"""Receiver, release and installation checks use temporary repositories and mocked services."""

import contextlib
import hashlib
import hmac
import io
import json
import os
import threading
import time
import unittest
import urllib.error
import urllib.request
from unittest import mock

import deploy
import engine
from fixtures import ModuleTestCase
from modules.base import switch_link


class DeploymentTest(ModuleTestCase):
    def setUp(self):
        super().setUp()
        self.add_all()
        self.write("app/version.txt", "first")
        self.first = self.commit("first")
        self.write("app/version.txt", "second")
        self.second = self.commit("second")
        patch = mock.patch.object(deploy, "UNIT_DIR", self.unit_dir)
        patch.start()
        self.addCleanup(patch.stop)

    def test_release_uses_the_commit_and_links_runtime_state(self):
        release = deploy.extract_release(self.repo, self.first, self.deploy_dir)
        self.assertEqual((release / "app/version.txt").read_text(), "first")
        self.assertEqual((release / ".revision").read_text(), self.first + "\n")
        engine.link_state(release, self.source, ["app/.env"])
        engine.link_state(release, self.source, ["app/.env"])
        self.assertEqual((release / "app/.env").resolve(), (self.source / "app/.env").resolve())
        self.assertEqual(deploy.extract_release(self.repo, self.first, self.deploy_dir), release)
        (self.source / "app/server.py").write_text("untracked copy")
        with self.assertRaisesRegex(deploy.DeployError, "must not be tracked"):
            engine.link_state(release, self.source, ["app/server.py"])

    def test_verifies_main_push_and_successful_job_across_pages(self):
        info = {"head_sha": self.first, "event": "push", "head_branch": "main", "run_attempt": 1,
                "status": "in_progress", "conclusion": None,
                "repository": {"full_name": "example/hub"}, "path": ".github/workflows/deploy.yml"}
        per_page = deploy.CONFIG["github"]["jobsPerPage"]
        full = {"jobs": [{"name": f"check ({i})", "conclusion": "success"} for i in range(per_page)]}
        with mock.patch.object(deploy, "github_json",
                               side_effect=[info, full, {"jobs": [{"name": "verify", "conclusion": "success"}]}]) as api:
            deploy.verify_run("example/hub", self.first, 12, 1)
        self.assertIn("page=2", api.call_args.args[0])
        with mock.patch.object(deploy, "github_json",
                               side_effect=[info, {"jobs": [{"name": "verify", "conclusion": "failure"}]}]):
            with self.assertRaisesRegex(deploy.DeployError, "successful verification"):
                deploy.verify_run("example/hub", self.first, 12, 1)

    def test_rejects_bad_signature_and_expired_requests(self):
        key = b"fixture-secret-for-a-test-at-least-32"
        body = json.dumps({"repo": "example/hub", "sha": self.first, "run_id": 12, "attempt": 1,
                           "timestamp": 1000}).encode()
        signature = "sha256=" + hmac.new(key, body, hashlib.sha256).hexdigest()
        self.assertEqual(deploy.authenticate(body, signature, key, "example/hub", 1001)["sha"], self.first)
        with self.assertRaisesRegex(deploy.DeployError, "signature"):
            deploy.authenticate(body, "sha256=" + "0" * 64, key, "example/hub", 1001)
        with self.assertRaisesRegex(deploy.DeployError, "expired"):
            deploy.authenticate(body, signature, key, "example/hub", 1301)

    def test_http_receiver_rejects_unauthorized_and_accepts_signed_request(self):
        secret = b"a-fixture-secret-with-at-least-32-bytes"
        (self.deploy_dir / "webhook-secret").write_bytes(secret)
        ready = threading.Event()
        servers = []
        original_server = deploy.HTTPServer

        def create_server(address, handler):
            server = original_server((address[0], 0), handler)
            servers.append(server)
            ready.set()
            return server

        old = deploy.extract_release(self.repo, self.first, self.deploy_dir)
        new = deploy.extract_release(self.repo, self.second, self.deploy_dir)
        switch_link(self.deploy_dir / "current", old)

        def deployed(*args):
            switch_link(self.deploy_dir / "current", new)
            return {"status": "partial", "modules": {"app": "failed"}}

        with mock.patch.object(deploy, "HTTPServer", side_effect=create_server), \
                mock.patch.object(deploy, "verify_run") as verified, \
                mock.patch.object(deploy, "deploy_revision", side_effect=deployed) as applied:
            thread = threading.Thread(target=deploy.serve, args=(self.source, self.deploy_dir, "example/hub"),
                                      daemon=True)
            thread.start()
            self.assertTrue(ready.wait(3))
            url = f"http://127.0.0.1:{servers[0].server_port}{deploy.WEBHOOK_PATH}"
            body = json.dumps({"repo": "example/hub", "sha": self.second, "run_id": 12, "attempt": 1,
                               "timestamp": int(time.time())}).encode()
            bad = urllib.request.Request(url, data=body, headers={"X-Jomaa-Signature": "bad"})
            with self.assertRaises(urllib.error.HTTPError) as error:
                urllib.request.urlopen(bad, timeout=5)
            self.assertEqual(error.exception.code, 403)
            error.exception.close()
            verified.assert_not_called()
            signature = "sha256=" + hmac.new(secret, body, hashlib.sha256).hexdigest()
            good = urllib.request.Request(url, data=body, headers={"X-Jomaa-Signature": signature})
            with urllib.request.urlopen(good, timeout=5) as response:
                self.assertEqual(json.load(response), {"status": "partial", "modules": {"app": "failed"},
                                                       "sha": self.second})
            thread.join(timeout=5)
            self.assertFalse(thread.is_alive())
        verified.assert_called_once_with("example/hub", self.second, 12, 1)
        applied.assert_called_once_with(self.source, self.deploy_dir, "example/hub", self.second, 12, 1)

    def test_old_verified_run_cannot_roll_back_newer_deployment(self):
        new = deploy.extract_release(self.repo, self.second, self.deploy_dir)
        switch_link(self.deploy_dir / "current", new)
        with mock.patch.object(deploy, "run"), \
                mock.patch.object(deploy, "is_ancestor", side_effect=[True, True]), \
                mock.patch.object(deploy, "run_engine") as handoff:
            result = deploy.deploy_revision(self.repo, self.deploy_dir, "example/hub", self.first, 12, 1)
        self.assertEqual(result, {"status": "older-revision-ignored"})
        handoff.assert_not_called()
        self.assertEqual((self.deploy_dir / "current").resolve(), new)

    def test_candidate_release_runs_its_own_activation(self):
        current = deploy.extract_release(self.repo, self.second, self.deploy_dir)
        switch_link(self.deploy_dir / "current", current)
        self.write("app/deploy.json", "not a declaration this receiver can read")
        self.write("jomaa-deploy/deploy.py",
                   "import json, os, sys\n"
                   "args = sys.argv[1:]\n"
                   "names = ('JOMAA_DEPLOY_SOURCE', 'JOMAA_DEPLOY_HOME', 'JOMAA_DEPLOY_REPO')\n"
                   "result = {'status': 'fake', 'args': args, 'cwd': os.getcwd(),\n"
                   "          'env': {name: os.environ[name] for name in names}}\n"
                   "open(args[args.index('--result') + 1], 'w').write(json.dumps(result))\n")
        candidate = self.commit("new declaration format")
        original_run = deploy.run

        def fetch_locally(*args, **kwargs):
            if "fetch" in args:
                args = (*args[:-2], str(self.repo), "HEAD")
            return original_run(*args, **kwargs)

        with mock.patch.object(deploy, "run", side_effect=fetch_locally):
            result = deploy.deploy_revision(self.source, self.deploy_dir, "example/hub", candidate, 12, 3)
        release = self.deploy_dir / "releases" / candidate
        self.assertEqual(result, {
            "status": "fake",
            "args": ["activate", "--sha", candidate, "--run-id", "12", "--attempt", "3",
                     "--result", str(self.deploy_dir / "result.json")],
            "cwd": str(release / "jomaa-deploy"),
            "env": {"JOMAA_DEPLOY_SOURCE": str(self.source), "JOMAA_DEPLOY_HOME": str(self.deploy_dir),
                    "JOMAA_DEPLOY_REPO": "example/hub"}})
        self.assertEqual((self.deploy_dir / "current").resolve(), current)

    def test_activate_command_reads_the_run_jobs_and_writes_the_result(self):
        deploy.extract_release(self.repo, self.second, self.deploy_dir)
        result_file = self.root / "result.json"
        reported = {"status": "deployed", "modules": {"app": "deployed"}, "ingress": {}}
        with mock.patch.dict(os.environ, {"JOMAA_DEPLOY_SOURCE": str(self.source),
                                          "JOMAA_DEPLOY_HOME": str(self.deploy_dir)}), \
                mock.patch.object(deploy, "github_jobs", return_value={"check (app)": "success"}) as jobs, \
                mock.patch.object(deploy.engine, "activate", return_value=reported) as activated:
            code = deploy.main(["activate", "--repo", "example/hub", "--sha", self.second, "--run-id", "12",
                                "--attempt", "2", "--result", str(result_file)])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(result_file.read_text()), reported)
        jobs.assert_called_once_with("example/hub", 12, 2)
        ctx, given = activated.call_args.args
        self.assertEqual((ctx.release, ctx.sha, given), (self.deploy_dir / "releases" / self.second, self.second,
                                                          {"check (app)": "success"}))

    def test_a_repeated_request_reports_the_stored_result_and_a_new_attempt_activates(self):
        deploy.extract_release(self.repo, self.second, self.deploy_dir)
        reported = {"status": "deployed", "modules": {"app": "deployed"}, "ingress": {}}
        with mock.patch.object(deploy, "github_jobs", return_value={}), \
                mock.patch.object(deploy.engine, "activate", return_value=reported) as activated, \
                contextlib.redirect_stdout(io.StringIO()):
            first = deploy.activate_revision(self.source, self.deploy_dir, "example/hub", self.second, 12, 1)
            again = deploy.activate_revision(self.source, self.deploy_dir, "example/hub", self.second, 12, 1)
            self.assertEqual(activated.call_count, 1)
            deploy.activate_revision(self.source, self.deploy_dir, "example/hub", self.second, 12, 2)
            self.assertEqual(activated.call_count, 2)
        self.assertEqual(first, reported)
        self.assertEqual(again, reported)
        self.assertEqual(sorted(p.name for p in (self.deploy_dir / "results").iterdir()),
                         [f"{self.second}-12-1.json", f"{self.second}-12-2.json"])

    def test_unreadable_jobs_make_modules_with_checks_ineligible(self):
        deploy.extract_release(self.repo, self.second, self.deploy_dir)
        with mock.patch.object(deploy, "github_jobs", side_effect=OSError("offline")), \
                mock.patch.object(deploy.engine, "activate", return_value={"status": "partial"}) as activated, \
                contextlib.redirect_stderr(io.StringIO()):
            deploy.activate_revision(self.source, self.deploy_dir, "example/hub", self.second, 12, 1)
        self.assertEqual(activated.call_args.args[1], {})

    def test_prune_keeps_newest_current_and_every_module_release(self):
        releases = self.deploy_dir / "releases"
        made = []
        for i in range(7):
            release = releases / f"r{i}"
            release.mkdir(parents=True)
            (release / ".revision").write_text(f"r{i}\n")
            os.utime(release, (1000 + i, 1000 + i))
            made.append(release)
        switch_link(self.deploy_dir / "current", made[1])
        switch_link(self.deploy_dir / "modules/app/current", made[0])
        switch_link(self.deploy_dir / "modules/app/previous", made[2])
        results = self.deploy_dir / "results"
        results.mkdir()
        for name in ("r3-12-1.json", "r4-12-1.json"):
            (results / name).write_text("{}")
        deploy.prune_releases(self.deploy_dir, keep=3)
        self.assertEqual(sorted(p.name for p in releases.iterdir()), ["r0", "r1", "r2", "r4", "r5", "r6"])
        self.assertEqual([p.name for p in results.iterdir()], ["r4-12-1.json"])

    def test_modules_command_lists_the_check_matrix(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertEqual(deploy.main(["modules", "--json"]), 0)
        matrix = json.loads(output.getvalue())
        modules, _ = engine.discover(deploy.SOURCE)
        self.assertEqual(matrix, sorted(m.name for m in modules if m.checks and m.check_job() != "verify"))
        self.assertIn("hub", matrix)
        self.assertNotIn("deploy", matrix)
        self.assertNotIn("sarah.jomaa.org", matrix)

    def test_install_is_repeatable_and_installs_the_receiver(self):
        original_run = deploy.run

        def run_or_mock(*args, **kwargs):
            if args[0] == "systemctl":
                return ""
            return original_run(*args, **kwargs)

        def activate(ctx, jobs):
            switch_link(ctx.deploy_dir / "current", ctx.release)
            return {"status": "deployed"}

        with mock.patch.object(deploy, "run", side_effect=run_or_mock), \
                mock.patch.object(deploy.native, "init_config"), \
                mock.patch.object(deploy.native, "provision"), \
                mock.patch.object(deploy.engine, "activate", side_effect=activate) as activated, \
                contextlib.redirect_stdout(io.StringIO()):
            deploy.install(self.repo, self.deploy_dir, "example/hub", "tunnel")
            secret = (self.deploy_dir / "webhook-secret").read_bytes()
            deploy.install(self.repo, self.deploy_dir, "example/hub", "tunnel")
        self.assertEqual(activated.call_count, 1)
        self.assertIsNone(activated.call_args.args[1])
        self.assertEqual((self.deploy_dir / "webhook-secret").read_bytes(), secret)
        self.assertEqual((self.deploy_dir / "webhook-secret").stat().st_mode & 0o777, 0o600)
        receiver = (self.unit_dir / "jomaa-deploy.service").read_text()
        self.assertIn("current/jomaa-deploy/deploy.py", receiver)
        self.assertIn(str(self.repo), receiver)


if __name__ == "__main__":
    unittest.main()

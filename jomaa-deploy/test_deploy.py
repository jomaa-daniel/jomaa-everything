"""Deployment checks use temporary repositories and mocked service restarts."""

import hashlib
import hmac
import json
import os
import subprocess
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest import mock

import deploy


class DeploymentTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()  # macOS: /var is a symlink to /private/var
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.source = self.repo / "jomaa-home-hub"
        (self.source / "scripts").mkdir(parents=True)
        deployment = self.repo / "jomaa-deploy"
        deployment.mkdir()
        (deployment / "boot.py").write_text("# tracked bootstrap\n")
        (deployment / "deploy.py").write_text("# tracked deployment\n")
        (deployment / "deploy.json").write_text(json.dumps({
            "checks": [],
            "state": ["jomaa-home-hub/.env", "jomaa-home-hub/config.json", "jomaa-home-hub/data"],
            "webhook": "hub.example.org",
            "services": {
                "hub": {"origin": "http://127.0.0.1:8080", "unit": "jomaa-hub", "directory": "jomaa-home-hub",
                        "command": ["{python}", "{release}/jomaa-deploy/boot.py", "hub"],
                        "build": [["npm", "ci", "--no-audit", "--no-fund"], ["npm", "run", "build"]],
                        "health": {"url": "http://127.0.0.1:8080/healthz"}},
                "static": {"origin": "http://127.0.0.1:8090", "unit": "jomaa-static-pages", "directory": "jomaa-static-pages",
                           "command": ["{python}", "{release}/jomaa-static-pages/serve.py"],
                           "health": {"url": "http://127.0.0.1:8090/healthz"}}},
            "routes": [{"hostname": "hub.example.org", "service": "hub"}]}))
        site = self.repo / "jomaa-static-pages/site.example.org"
        site.mkdir(parents=True)
        (site / "index.html").write_text("first site")
        (self.source / "cmd").mkdir()
        (self.source / "cmd/test.txt").write_text("first")
        self.panel = self.repo / "jomaa-static-pages/device-panel"
        self.panel.mkdir(parents=True)
        (self.panel / "index.html").write_text("first panel")
        self.git("init", "-q")
        self.git("config", "user.email", "test@example.org")
        self.git("config", "user.name", "Test")
        self.git("add", ".")
        self.git("commit", "-qm", "initial")
        self.first = self.git("rev-parse", "HEAD")
        (self.source / ".env").write_text("HUB_PASSWORD=test-password\nCLOUDFLARE_API_TOKEN=test-token\n")
        (self.source / "config.json").write_text('{"devices": []}\n')
        (self.source / "data/native").mkdir(parents=True)
        # The checkout's own build, which deployments must leave alone.
        (self.source / "dist").mkdir()
        (self.source / "dist/main.js").write_text("checkout build")
        (self.source / "cmd/test.txt").write_text("second")
        (self.panel / "index.html").write_text("second panel")
        self.git("add", "jomaa-home-hub/cmd/test.txt", "jomaa-static-pages/device-panel/index.html")
        self.git("commit", "-qm", "second")
        self.second = self.git("rev-parse", "HEAD")
        self.deploy_dir = self.root / "deploy"
        self.deploy_dir.mkdir()
        self.unit_dir = self.root / "units"
        self.unit_dir.mkdir()
        self.unit_patch = mock.patch.object(deploy, "UNIT_DIR", self.unit_dir)
        self.unit_patch.start()
        self.addCleanup(self.unit_patch.stop)

    @staticmethod
    def fake_npm(args, kwargs, built="new build"):
        """Stands in for npm: npm run build writes the release's dist/main.js."""
        if args[:3] == ("npm", "run", "build"):
            (kwargs["cwd"] / "dist").mkdir(exist_ok=True)
            (kwargs["cwd"] / "dist/main.js").write_text(built)

    def git(self, *args):
        return subprocess.run(["git", "-C", str(self.repo), *args], check=True, text=True,
                              stdout=subprocess.PIPE).stdout.strip()

    def test_release_uses_commit_and_preserves_runtime_state(self):
        release = deploy.make_release(self.repo, self.first, self.repo, self.deploy_dir)
        self.assertEqual((release / "jomaa-home-hub/cmd/test.txt").read_text(), "first")
        self.assertEqual((self.source / "cmd/test.txt").read_text(), "second")
        self.assertEqual((release / "jomaa-static-pages/device-panel/index.html").read_text(), "first panel")
        self.assertEqual((self.panel / "index.html").read_text(), "second panel")
        for name in (".env", "config.json", "data"):
            self.assertEqual((release / "jomaa-home-hub" / name).resolve(), (self.source / name).resolve())
        self.assertEqual(deploy.make_release(self.repo, self.first, self.repo, self.deploy_dir), release)

    def test_adding_and_removing_a_folder_changes_deployed_routes_and_dns(self):
        old = deploy.make_release(self.repo, self.second, self.repo, self.deploy_dir)
        deploy.switch_link(self.deploy_dir / "current", old)
        declaration = (self.repo / "jomaa-deploy/deploy.json").read_bytes()
        site = self.repo / "jomaa-static-pages/new.example.org"
        site.mkdir()
        (site / "index.html").write_text("new site")
        self.git("add", "jomaa-static-pages/new.example.org")
        self.git("commit", "-qm", "add site folder")
        added_sha = self.git("rev-parse", "HEAD")
        added = deploy.make_release(self.repo, added_sha, self.repo, self.deploy_dir)
        (self.source / "data/native/tunnel.yml").write_text("same tunnel")
        with mock.patch.object(deploy, "build_release"), \
                mock.patch.object(deploy.routing, "prepare", return_value="same tunnel") as prepared, \
                mock.patch.object(deploy.routing, "tunnel_id", return_value="fixture"), \
                mock.patch.object(deploy, "Cloudflare"), \
                mock.patch.object(deploy.routing, "DNS") as dns, \
                mock.patch.object(deploy, "wait_health", return_value=True), \
                mock.patch.object(deploy, "health", return_value=True), \
                mock.patch.object(deploy, "run"):
            deploy.activate(added, self.deploy_dir, self.repo)
            generated = prepared.call_args.args[2]
            self.assertIn("new.example.org", deploy.routing.hosts(generated))
            desired, previous = dns.return_value.apply.call_args.args
            self.assertIn("new.example.org", desired)
            self.assertNotIn("new.example.org", previous)
            self.git("rm", "-r", "jomaa-static-pages/new.example.org")
            self.git("commit", "-qm", "remove site folder")
            removed = deploy.make_release(self.repo, self.git("rev-parse", "HEAD"), self.repo, self.deploy_dir)
            deploy.activate(removed, self.deploy_dir, self.repo)
            desired, previous = dns.return_value.apply.call_args.args
            self.assertNotIn("new.example.org", desired)
            self.assertIn("new.example.org", previous)
        self.assertEqual((self.repo / "jomaa-deploy/deploy.json").read_bytes(), declaration)
        self.assertEqual((added / "jomaa-deploy/deploy.json").read_bytes(), declaration)
        self.assertEqual((added / "jomaa-static-pages/new.example.org/index.html").read_text(), "new site")

    def test_failed_health_restores_previous_release(self):
        old = deploy.make_release(self.repo, self.first, self.repo, self.deploy_dir)
        new = deploy.make_release(self.repo, self.second, self.repo, self.deploy_dir)
        deploy.switch_link(self.deploy_dir / "current", old)
        (self.source / "data/native/tunnel.yml").write_text("same tunnel")
        calls = []

        def fake_run(*args, **kwargs):
            calls.append(args)
            self.fake_npm(args, kwargs)
            return ""

        with mock.patch.object(deploy, "run", side_effect=fake_run), \
                mock.patch.object(deploy.routing, "prepare", return_value="same tunnel"), \
                mock.patch.object(deploy.routing, "tunnel_id", return_value="fixture"), \
                mock.patch.object(deploy, "Cloudflare"), \
                mock.patch.object(deploy.routing, "DNS"), \
                mock.patch.object(deploy, "health", return_value=True), \
                mock.patch.object(deploy, "wait_health", side_effect=[False, True]):
            with self.assertRaisesRegex(deploy.DeployError, "did not become healthy"):
                deploy.activate(new, self.deploy_dir, self.repo)
        self.assertEqual((self.deploy_dir / "current").resolve(), old)
        self.assertEqual((self.source / "dist/main.js").read_text(), "checkout build")
        self.assertIn(("npm", "ci", "--no-audit", "--no-fund"), calls)
        self.assertEqual(sum("restart" in call for call in calls), 2)

    def test_success_switches_only_current_release(self):
        old = deploy.make_release(self.repo, self.first, self.repo, self.deploy_dir)
        new = deploy.make_release(self.repo, self.second, self.repo, self.deploy_dir)
        deploy.switch_link(self.deploy_dir / "current", old)
        (self.source / "data/native/tunnel.yml").write_text("same tunnel")

        def fake_run(*args, **kwargs):
            self.fake_npm(args, kwargs)
            return ""

        with mock.patch.object(deploy, "run", side_effect=fake_run), \
                mock.patch.object(deploy.routing, "prepare", return_value="same tunnel"), \
                mock.patch.object(deploy.routing, "tunnel_id", return_value="fixture"), \
                mock.patch.object(deploy, "Cloudflare"), \
                mock.patch.object(deploy.routing, "DNS"), \
                mock.patch.object(deploy, "health", return_value=True), \
                mock.patch.object(deploy, "wait_health", return_value=True):
            deploy.activate(new, self.deploy_dir, self.repo)
        self.assertEqual((self.deploy_dir / "current").resolve(), new)
        self.assertEqual((new / "jomaa-home-hub/dist/main.js").read_text(), "new build")
        self.assertEqual((self.source / "dist/main.js").read_text(), "checkout build")
        self.assertIn("HUB_PASSWORD=test-password", (self.source / ".env").read_text())

    def test_verifies_main_push_and_successful_job(self):
        info = {"head_sha": self.first, "event": "push", "head_branch": "main", "run_attempt": 1,
                "status": "in_progress", "conclusion": None,
                "repository": {"full_name": "example/hub"}, "path": ".github/workflows/deploy.yml"}
        with mock.patch.object(deploy, "github_json", side_effect=[info, {"jobs": [{"name": "verify", "conclusion": "success"}]}]):
            deploy.verify_run("example/hub", self.first, 12, 1)
        with mock.patch.object(deploy, "github_json", side_effect=[info, {"jobs": [{"name": "verify", "conclusion": "failure"}]}]):
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

        with mock.patch.object(deploy, "HTTPServer", side_effect=create_server), \
                mock.patch.object(deploy, "verify_run") as verified, \
                mock.patch.object(deploy, "deploy_revision", return_value="deployed") as applied:
            thread = threading.Thread(target=deploy.serve, args=(self.source, self.deploy_dir, "example/hub"), daemon=True)
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
                self.assertEqual(json.load(response)["status"], "deployed")
            thread.join(timeout=5)
            self.assertFalse(thread.is_alive())
        verified.assert_called_once_with("example/hub", self.second, 12, 1)
        applied.assert_called_once_with(self.source, self.deploy_dir, "example/hub", self.second)

    def test_old_verified_run_cannot_roll_back_newer_deployment(self):
        deploy.make_release(self.repo, self.first, self.repo, self.deploy_dir)
        new = deploy.make_release(self.repo, self.second, self.repo, self.deploy_dir)
        deploy.switch_link(self.deploy_dir / "current", new)
        with mock.patch.object(deploy, "run"), \
                mock.patch.object(deploy, "is_ancestor", side_effect=[True, True]), \
                mock.patch.object(deploy, "activate") as activate:
            result = deploy.deploy_revision(self.repo, self.deploy_dir, "example/hub", self.first)
        self.assertEqual(result, "older-revision-ignored")
        activate.assert_not_called()
        self.assertEqual((self.deploy_dir / "current").resolve(), new)

    def test_prune_keeps_newest_releases_and_current(self):
        releases = self.deploy_dir / "releases"
        made = []
        for i in range(5):
            r = releases / f"r{i}"
            r.mkdir(parents=True)
            (r / ".revision").write_text(f"r{i}\n")
            os.utime(r, (1000 + i, 1000 + i))
            made.append(r)
        deploy.switch_link(self.deploy_dir / "current", made[0])
        deploy.prune_releases(self.deploy_dir, keep=3)
        self.assertEqual(sorted(p.name for p in releases.iterdir()), ["r0", "r2", "r3", "r4"])

    def test_install_is_repeatable_and_uses_repository_release_paths(self):
        original_run = deploy.run

        def run_or_mock(*args, **kwargs):
            if args[0] == "systemctl":
                return ""
            return original_run(*args, **kwargs)

        def activate(release, deploy_dir, source):
            deploy.switch_link(deploy_dir / "current", release)
            deploy.write_units(deploy.manifest.load(release), deploy_dir / "current")

        with mock.patch.object(deploy, "run", side_effect=run_or_mock), \
                mock.patch.object(deploy.native, "provision"), \
                mock.patch.object(deploy, "activate", side_effect=activate) as activated:
            deploy.install(self.repo, self.deploy_dir, "example/hub")
            secret = (self.deploy_dir / "webhook-secret").read_bytes()
            deploy.install(self.repo, self.deploy_dir, "example/hub")
        self.assertEqual(activated.call_count, 1)
        self.assertEqual((self.deploy_dir / "webhook-secret").read_bytes(), secret)
        self.assertEqual((self.deploy_dir / "webhook-secret").stat().st_mode & 0o777, 0o600)
        receiver = (self.unit_dir / "jomaa-deploy.service").read_text()
        self.assertIn("current/jomaa-deploy/deploy.py", receiver)
        self.assertIn(str(self.repo), receiver)
        hub = (self.unit_dir / "jomaa-hub.service").read_text()
        self.assertIn("current/jomaa-deploy/boot.py", hub)
        tunnel = (self.unit_dir / "jomaa-cloudflared.service").read_text()
        self.assertIn('current/jomaa-deploy/boot.py" "tunnel"', tunnel)

    def test_failed_activation_restores_tunnel_units_and_dns(self):
        old = deploy.make_release(self.repo, self.first, self.repo, self.deploy_dir)
        new = deploy.make_release(self.repo, self.second, self.repo, self.deploy_dir)
        deploy.switch_link(self.deploy_dir / "current", old)
        deploy.write_units(deploy.manifest.load(old), self.deploy_dir / "current")
        previous_unit = (self.unit_dir / "jomaa-hub.service").read_bytes()
        tunnel_unit = self.unit_dir / "jomaa-cloudflared.service"
        previous_tunnel_unit = tunnel_unit.read_bytes()
        override = self.unit_dir / "jomaa-cloudflared.service.d/deployment.conf"
        override.parent.mkdir()
        override.write_text("[Service]\nExecStart=/bin/true\n")
        tunnel = self.source / "data/native/tunnel.yml"
        tunnel.write_text("original tunnel")
        failed = False

        def restart(*args, **kwargs):
            nonlocal failed
            if args == ("systemctl", "--user", "restart", "jomaa-cloudflared.service"):
                if not failed:
                    self.assertEqual(tunnel.read_text(), "new tunnel")
                    self.assertFalse(override.exists())
                    failed = True
                    raise subprocess.CalledProcessError(1, args)
                self.assertEqual(tunnel.read_text(), "original tunnel")
                self.assertEqual(tunnel_unit.read_bytes(), previous_tunnel_unit)
                self.assertTrue(override.exists())
            return ""

        with mock.patch.object(deploy, "build_release"), \
                mock.patch.object(deploy.routing, "prepare", return_value="new tunnel"), \
                mock.patch.object(deploy.routing, "tunnel_id", return_value="fixture"), \
                mock.patch.object(deploy, "Cloudflare"), \
                mock.patch.object(deploy.routing, "DNS") as dns, \
                mock.patch.object(deploy, "wait_health", return_value=True), \
                mock.patch.object(deploy, "health", return_value=True), \
                mock.patch.object(deploy, "run", side_effect=restart):
            with self.assertRaises(subprocess.CalledProcessError):
                deploy.activate(new, self.deploy_dir, self.repo)
        dns.return_value.restore.assert_called_once()
        self.assertEqual((self.deploy_dir / "current").resolve(), old)
        self.assertTrue(failed)
        self.assertEqual(tunnel.read_text(), "original tunnel")
        self.assertEqual(tunnel_unit.read_bytes(), previous_tunnel_unit)
        self.assertTrue(override.exists())
        self.assertEqual((self.unit_dir / "jomaa-hub.service").read_bytes(), previous_unit)


if __name__ == "__main__":
    unittest.main()

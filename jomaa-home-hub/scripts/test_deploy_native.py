"""Deployment checks use temporary repositories and mocked service restarts."""

import io
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import deploy_native as deploy


class Response(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


class DeploymentTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.source = self.repo / "jomaa-home-hub"
        (self.source / "scripts").mkdir(parents=True)
        (self.source / "scripts/boot_native.py").write_text("# tracked bootstrap\n")
        (self.source / "scripts/deploy_native.py").write_text("# tracked deployment\n")
        (self.source / "cmd").mkdir()
        (self.source / "cmd/test.txt").write_text("first")
        self.git("init", "-q")
        self.git("config", "user.email", "test@example.org")
        self.git("config", "user.name", "Test")
        self.git("add", ".")
        self.git("commit", "-qm", "initial")
        self.first = self.git("rev-parse", "HEAD")
        (self.source / ".env").write_text("HUB_PASSWORD=secret\n")
        (self.source / "config.json").write_text('{"devices": []}\n')
        binary = self.source / "data/native/hub"
        binary.parent.mkdir(parents=True)
        binary.write_text("old binary")
        go = self.source / "data/native/go/bin/go"
        go.parent.mkdir(parents=True)
        go.touch()
        (self.source / "cmd/test.txt").write_text("second")
        self.git("add", "jomaa-home-hub/cmd/test.txt")
        self.git("commit", "-qm", "second")
        self.second = self.git("rev-parse", "HEAD")
        self.deploy_dir = self.root / "deploy"
        self.deploy_dir.mkdir()

    def git(self, *args):
        return subprocess.run(["git", "-C", str(self.repo), *args], check=True, text=True,
                              stdout=subprocess.PIPE).stdout.strip()

    def test_release_uses_commit_and_preserves_runtime_state(self):
        release = deploy.make_release(self.repo, self.first, self.source, self.deploy_dir)
        self.assertEqual((release / "cmd/test.txt").read_text(), "first")
        self.assertEqual((self.source / "cmd/test.txt").read_text(), "second")
        for name in (".env", "config.json", "data"):
            self.assertEqual((release / name).resolve(), (self.source / name).resolve())
        self.assertEqual(deploy.make_release(self.repo, self.first, self.source, self.deploy_dir), release)

    def test_failed_health_restores_previous_release(self):
        old = deploy.make_release(self.repo, self.first, self.source, self.deploy_dir)
        new = deploy.make_release(self.repo, self.second, self.source, self.deploy_dir)
        deploy.switch_link(self.deploy_dir / "current", old)
        calls = []

        def fake_run(*args, **kwargs):
            calls.append(args)
            if "build" in args:
                Path(args[args.index("-o") + 1]).write_text("new binary")
            return ""

        with mock.patch.object(deploy, "run", side_effect=fake_run), \
                mock.patch.object(deploy, "wait_health", side_effect=[False, True]):
            with self.assertRaisesRegex(deploy.DeployError, "did not become healthy"):
                deploy.activate(new, self.source, self.deploy_dir)
        self.assertEqual((self.deploy_dir / "current").resolve(), old)
        self.assertEqual((self.source / "data/native/hub").read_text(), "old binary")
        self.assertEqual(sum("restart" in call for call in calls), 2)

    def test_success_switches_only_current_release(self):
        old = deploy.make_release(self.repo, self.first, self.source, self.deploy_dir)
        new = deploy.make_release(self.repo, self.second, self.source, self.deploy_dir)
        deploy.switch_link(self.deploy_dir / "current", old)

        def fake_run(*args, **kwargs):
            if "build" in args:
                Path(args[args.index("-o") + 1]).write_text("new binary")
            return ""

        with mock.patch.object(deploy, "run", side_effect=fake_run), \
                mock.patch.object(deploy, "wait_health", return_value=True):
            deploy.activate(new, self.source, self.deploy_dir)
        self.assertEqual((self.deploy_dir / "current").resolve(), new)
        self.assertEqual((new / "bin/hub").read_text(), "new binary")
        self.assertEqual((self.source / "data/native/hub").read_text(), "old binary")
        self.assertEqual((self.source / ".env").read_text(), "HUB_PASSWORD=secret\n")

    def test_only_successful_main_push_run_is_selected(self):
        response = Response(json.dumps({"workflow_runs": [{"head_sha": "a" * 40, "event": "push",
                                                          "head_branch": "main", "conclusion": "success"}]}).encode())
        with mock.patch.object(deploy.urllib.request, "urlopen", return_value=response) as request:
            self.assertEqual(deploy.latest_success("example/hub"), "a" * 40)
        url = request.call_args.args[0].full_url
        self.assertIn("branch=main", url)
        self.assertIn("event=push", url)
        self.assertIn("status=success", url)
        self.assertIn("hub-deploy-native.yml", url)

    def test_rejects_a_run_that_did_not_pass(self):
        response = Response(json.dumps({"workflow_runs": [{"head_sha": "a" * 40, "event": "push",
                                                          "head_branch": "main", "conclusion": "failure"}]}).encode())
        with mock.patch.object(deploy.urllib.request, "urlopen", return_value=response):
            with self.assertRaisesRegex(deploy.DeployError, "not a successful main push"):
                deploy.latest_success("example/hub")

    def test_old_verified_run_cannot_roll_back_newer_deployment(self):
        old = deploy.make_release(self.repo, self.first, self.source, self.deploy_dir)
        new = deploy.make_release(self.repo, self.second, self.source, self.deploy_dir)
        deploy.switch_link(self.deploy_dir / "current", new)
        with mock.patch.object(deploy, "latest_success", return_value=self.first), \
                mock.patch.object(deploy, "run"), \
                mock.patch.object(deploy, "is_ancestor", side_effect=[True, True]), \
                mock.patch.object(deploy, "activate") as activate:
            deploy.poll(self.source, self.deploy_dir, "example/hub")
        activate.assert_not_called()
        self.assertEqual((self.deploy_dir / "current").resolve(), new)

    def test_install_can_be_repeated_without_replacing_a_live_release(self):
        unit_dir = self.root / "units"
        unit_dir.mkdir()
        for name in ("jomaa-setup", "jomaa-matter", "jomaa-hub"):
            (unit_dir / f"{name}.service").write_text("[Service]\nExecStart=/bin/true\n")
        original_run = deploy.run

        def run_or_mock_systemctl(*args, **kwargs):
            if args[0] == "systemctl":
                return ""
            if "build" in args:
                Path(args[args.index("-o") + 1]).write_text("built binary")
                return ""
            return original_run(*args, **kwargs)

        with mock.patch.object(deploy, "UNIT_DIR", unit_dir), \
                mock.patch.object(deploy, "run", side_effect=run_or_mock_systemctl):
            deploy.install(self.source, self.deploy_dir, "example/hub")
            release = (self.deploy_dir / "current").resolve()
            (release / "bin/hub").write_text("deployed binary")
            deploy.install(self.source, self.deploy_dir, "example/hub")
        self.assertEqual((release / "bin/hub").read_text(), "deployed binary")
        self.assertIn("current/bin/hub", (unit_dir / "jomaa-hub.service.d/deployment.conf").read_text())
        self.assertIn("OnUnitActiveSec=5min", (unit_dir / "jomaa-deploy.timer").read_text())


if __name__ == "__main__":
    unittest.main()

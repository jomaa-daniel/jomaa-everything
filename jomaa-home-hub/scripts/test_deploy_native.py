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

import deploy_native as deploy


class DeploymentTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()  # macOS: /var is a symlink to /private/var
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
        (self.source / ".env").write_text("HUB_PASSWORD=secret\nCLOUDFLARE_HOSTNAME=hub.example.org\n")
        (self.source / "config.json").write_text('{"devices": []}\n')
        (self.source / "data/native").mkdir(parents=True)
        # The checkout's own build, which deployments must leave alone.
        (self.source / "dist").mkdir()
        (self.source / "dist/main.js").write_text("checkout build")
        (self.source / "cmd/test.txt").write_text("second")
        self.git("add", "jomaa-home-hub/cmd/test.txt")
        self.git("commit", "-qm", "second")
        self.second = self.git("rev-parse", "HEAD")
        self.deploy_dir = self.root / "deploy"
        self.deploy_dir.mkdir()

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
            self.fake_npm(args, kwargs)
            return ""

        with mock.patch.object(deploy, "run", side_effect=fake_run), \
                mock.patch.object(deploy.shutil, "which", return_value="/usr/bin/npm"), \
                mock.patch.object(deploy, "wait_health", side_effect=[False, True]):
            with self.assertRaisesRegex(deploy.DeployError, "did not become healthy"):
                deploy.activate(new, self.deploy_dir)
        self.assertEqual((self.deploy_dir / "current").resolve(), old)
        self.assertEqual((self.source / "dist/main.js").read_text(), "checkout build")
        self.assertIn(("npm", "ci", "--no-audit", "--no-fund"), calls)
        self.assertEqual(sum("restart" in call for call in calls), 2)

    def test_success_switches_only_current_release(self):
        old = deploy.make_release(self.repo, self.first, self.source, self.deploy_dir)
        new = deploy.make_release(self.repo, self.second, self.source, self.deploy_dir)
        deploy.switch_link(self.deploy_dir / "current", old)

        def fake_run(*args, **kwargs):
            self.fake_npm(args, kwargs)
            return ""

        with mock.patch.object(deploy, "run", side_effect=fake_run), \
                mock.patch.object(deploy.shutil, "which", return_value="/usr/bin/npm"), \
                mock.patch.object(deploy, "wait_health", return_value=True):
            deploy.activate(new, self.deploy_dir)
        self.assertEqual((self.deploy_dir / "current").resolve(), new)
        self.assertEqual((new / "dist/main.js").read_text(), "new build")
        self.assertEqual((self.source / "dist/main.js").read_text(), "checkout build")
        self.assertIn("HUB_PASSWORD=secret", (self.source / ".env").read_text())

    def test_verifies_main_push_and_successful_job(self):
        info = {"head_sha": self.first, "event": "push", "head_branch": "main", "run_attempt": 1,
                "status": "in_progress", "conclusion": None,
                "repository": {"full_name": "example/hub"}, "path": ".github/workflows/hub-deploy-native.yml"}
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
            verified.assert_not_called()
            signature = "sha256=" + hmac.new(secret, body, hashlib.sha256).hexdigest()
            good = urllib.request.Request(url, data=body, headers={"X-Jomaa-Signature": signature})
            with urllib.request.urlopen(good, timeout=5) as response:
                self.assertEqual(json.load(response)["status"], "deployed")
            thread.join(timeout=5)
            self.assertFalse(thread.is_alive())
        verified.assert_called_once_with("example/hub", self.second, 12, 1)
        applied.assert_called_once_with(self.source, self.deploy_dir, "example/hub", self.second)

    def test_tunnel_rule_is_added_once_without_replacing_existing_ingress(self):
        config = self.source / "data/native/tunnel.yml"
        original = 'tunnel: fixture\ningress:\n  - hostname: "hub.example.org"\n    service: http://127.0.0.1:8080\n  - service: http_status:404\n'
        config.write_text(original)
        with mock.patch.object(deploy, "run") as run:
            deploy.configure_tunnel(self.source, "hub.example.org")
            updated = config.read_text()
            deploy.configure_tunnel(self.source, "hub.example.org")
        self.assertEqual(config.read_text(), updated)
        self.assertIn("path: ^/deploy$", updated)
        self.assertIn('service: http://127.0.0.1:8080', updated)
        self.assertLess(updated.index("/deploy"), updated.index("http://127.0.0.1:8080"))
        self.assertEqual(run.call_count, 2)

    def test_existing_deployment_route_is_migrated(self):
        config = self.source / "data/native/tunnel.yml"
        old = ('tunnel: fixture\ningress:\n  # jomaa-deployment-webhook\n'
               '  - hostname: "hub.example.org"\n    path: ^/__deployment$\n'
               '    service: http://127.0.0.1:8091\n  - hostname: "hub.example.org"\n'
               '    service: http://127.0.0.1:8080\n  - service: http_status:404\n')
        config.write_text(old)
        with mock.patch.object(deploy, "run") as run:
            deploy.configure_tunnel(self.source, "hub.example.org")
        self.assertEqual(config.read_text(), old.replace("^/__deployment$", "^/deploy$"))
        self.assertEqual(run.call_count, 2)

    def test_existing_deployment_route_below_another_rule_is_kept(self):
        config = self.source / "data/native/tunnel.yml"
        original = ('tunnel: fixture\ningress:\n  - hostname: "hub.example.org"\n    path: ^/devices$\n'
                    '    service: http://127.0.0.1:8082\n  # jomaa-deployment-webhook\n'
                    '  - hostname: "hub.example.org"\n    path: ^/deploy$\n'
                    '    service: http://127.0.0.1:8091\n  - service: http_status:404\n')
        config.write_text(original)
        with mock.patch.object(deploy, "run") as run:
            deploy.configure_tunnel(self.source, "hub.example.org")
        self.assertEqual(config.read_text(), original)
        run.assert_not_called()

    def test_conflicting_existing_deployment_route_is_preserved(self):
        config = self.source / "data/native/tunnel.yml"
        original = ('ingress:\n  # jomaa-deployment-webhook\n'
                    '  - hostname: "another.example.org"\n    path: ^/__deployment$\n'
                    '    service: http://127.0.0.1:8091\n  - service: http_status:404\n')
        config.write_text(original)
        with mock.patch.object(deploy, "run") as run:
            with self.assertRaisesRegex(deploy.DeployError, "differs from requested"):
                deploy.configure_tunnel(self.source, "hub.example.org")
        self.assertEqual(config.read_text(), original)
        run.assert_not_called()

    def test_old_verified_run_cannot_roll_back_newer_deployment(self):
        deploy.make_release(self.repo, self.first, self.source, self.deploy_dir)
        new = deploy.make_release(self.repo, self.second, self.source, self.deploy_dir)
        deploy.switch_link(self.deploy_dir / "current", new)
        with mock.patch.object(deploy, "run"), \
                mock.patch.object(deploy, "is_ancestor", side_effect=[True, True]), \
                mock.patch.object(deploy, "activate") as activate:
            result = deploy.deploy_revision(self.source, self.deploy_dir, "example/hub", self.first)
        self.assertEqual(result, "older-revision-ignored")
        activate.assert_not_called()
        self.assertEqual((self.deploy_dir / "current").resolve(), new)

    def test_install_can_be_repeated_without_replacing_a_live_release(self):
        unit_dir = self.root / "units"
        unit_dir.mkdir()
        for name in ("jomaa-setup", "jomaa-hub", "jomaa-cloudflared"):
            (unit_dir / f"{name}.service").write_text("[Service]\nExecStart=/bin/true\n")
        original_run = deploy.run

        def run_or_mock_systemctl(*args, **kwargs):
            if args[0] in ("systemctl", "npm"):
                self.fake_npm(args, kwargs, built="built")
                return ""
            return original_run(*args, **kwargs)

        with mock.patch.object(deploy, "UNIT_DIR", unit_dir), \
                mock.patch.object(deploy, "run", side_effect=run_or_mock_systemctl), \
                mock.patch.object(deploy.shutil, "which", return_value="/usr/bin/npm"), \
                mock.patch.object(deploy, "configure_tunnel"), \
                mock.patch.object(deploy, "wait_health", return_value=True):
            deploy.install(self.source, self.deploy_dir, "example/hub")
            release = (self.deploy_dir / "current").resolve()
            (release / "dist/main.js").write_text("deployed build")
            deploy.install(self.source, self.deploy_dir, "example/hub")
        self.assertEqual((release / "dist/main.js").read_text(), "deployed build")
        conf = (unit_dir / "jomaa-hub.service.d/deployment.conf").read_text()
        self.assertIn("current/scripts/boot_native.py", conf)
        self.assertNotIn("JOMAA_HUB_BINARY", conf)
        self.assertIn("serve", (unit_dir / "jomaa-deploy.service").read_text())
        self.assertFalse((unit_dir / "jomaa-deploy.timer").exists())

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


if __name__ == "__main__":
    unittest.main()

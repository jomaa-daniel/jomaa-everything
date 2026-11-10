import contextlib
import io
from pathlib import Path
import re
import tempfile
import unittest
from unittest.mock import patch

import serve_health_preview as preview


class PreviewRoutingTests(unittest.TestCase):
    def run_config(self, root, enabled, port=8082):
        with patch.object(preview, "remote_python") as remote:
            preview.configure_tunnel("jerry@192.168.1.239", str(root), "hub.jomaa.org", port, enabled)
        script = remote.call_args.args[1]
        with patch("subprocess.run") as run, contextlib.redirect_stdout(io.StringIO()):
            exec(script, {})
        return run

    def test_routes_only_health_and_keeps_existing_hub_and_deployment(self):
        original = ('tunnel: "existing-tunnel"\ningress:\n'
                    '  # deployment\n  - hostname: "hub.jomaa.org"\n'
                    '    path: ^/deploy$\n    service: http://127.0.0.1:8091\n'
                    '  - hostname: "hub.jomaa.org"\n    service: http://127.0.0.1:8080\n'
                    '  - service: http_status:404\n')
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            folder = root / "data/native"
            folder.mkdir(parents=True)
            config = folder / "tunnel.yml"
            config.write_text(original)
            self.run_config(root, True)
            updated = config.read_text()
            self.assertIn("service: http://127.0.0.1:8082", updated)
            self.assertIn(original.split("ingress:\n")[1], updated)
            self.assertEqual((folder / "tunnel.yml.pre-health-preview").read_text(), original)
            self.assertEqual((folder / "tunnel.yml.pre-health-preview").stat().st_mode & 0o777, 0o600)
            self.run_config(root, True)
            self.assertEqual(config.read_text(), updated)
            self.run_config(root, False)
            self.assertEqual(config.read_text(), original)
        pattern = re.compile(preview.HEALTH_PATH)
        for path in ("/", "/devices", "/devices/", "/devices/app.js", "/api/devices", "/api/devices/pico-test/health"):
            self.assertIsNotNone(pattern.fullmatch(path), path)
        for path in ("/deploy", "/api/login", "/api/logout", "/api/targets", "/api/matter/nodes", "/devices-other"):
            self.assertIsNone(pattern.fullmatch(path), path)

    def test_other_preview_rule_is_refused_without_writes(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            folder = root / "data/native"
            folder.mkdir(parents=True)
            config = folder / "tunnel.yml"
            original = ('ingress:\n  # jomaa-health-preview\n  - hostname: "other.example"\n'
                        '    service: http://127.0.0.1:9000\n  # /jomaa-health-preview\n')
            config.write_text(original)
            with self.assertRaises(AssertionError):
                self.run_config(root, True)
            self.assertEqual(config.read_text(), original)


if __name__ == "__main__":
    unittest.main()

"""Tests for native setup without modifying the machine's services or accounts."""

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import setup_native as setup


class NativeSetupTest(unittest.TestCase):
    def test_init_creates_private_password_and_empty_layout_and_preserves_both(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            setup.init_config(root)
            env = (root / ".env").read_text()
            self.assertIn("HUB_PASSWORD=", env)
            self.assertEqual((root / ".env").stat().st_mode & 0o777, 0o600)
            self.assertEqual(json.loads((root / "config.json").read_text())["devices"], [])
            (root / "config.json").write_text('{"devices": []}')
            setup.init_config(root)
            self.assertEqual((root / ".env").read_text(), env)
            self.assertEqual((root / "config.json").read_text(), '{"devices": []}')

    def test_units_use_repo_boot_scripts_and_optional_tunnel(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(setup, "UNITS", Path(temp)):
            units = setup.write_units(True)
            check = (Path(temp) / "jomaa-setup.service").read_text()
            hub = (Path(temp) / "jomaa-hub.service").read_text()
            tunnel = (Path(temp) / "jomaa-cloudflared.service").read_text()
            self.assertIn("setup_native.py\" --boot", check)
            self.assertIn("boot_native.py\" hub", hub)
            self.assertIn("Requires=jomaa-setup.service", hub)
            self.assertIn("boot_native.py\" tunnel", tunnel)
            self.assertIn("jomaa-cloudflared.service", units)

    def test_boot_check_reports_missing_programs(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            setup.init_config(root)
            with patch.object(setup, "ROOT", root), patch.object(setup, "DATA", root / "data/native"):
                with self.assertRaisesRegex(setup.SetupError, "missing"):
                    setup.verify_boot()

    def test_tunnel_refuses_to_overwrite_existing_config(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            data = root / "data/native"
            data.mkdir(parents=True)
            setup.init_config(root)
            cloud_dir = root / ".cloudflared"
            cloud_dir.mkdir()
            (cloud_dir / "cert.pem").touch()
            tunnel_id = "4b03940e-11ab-48c6-b288-4c9deb2cc905"
            (cloud_dir / (tunnel_id + ".json")).touch()
            config = data / "tunnel.yml"
            config.write_text("existing settings\n")

            def fake_run(*args, capture=False):
                if "list" in args:
                    return json.dumps([{"id": tunnel_id, "name": "home", "deleted_at": "0001-01-01T00:00:00Z"}])
                self.fail(f"unexpected command: {args}")

            with patch.object(setup, "ROOT", root), patch.object(setup, "DATA", data), \
                    patch.object(Path, "home", return_value=root), \
                    patch.object(setup, "get_cloudflared", return_value=data / "cloudflared"), \
                    patch.object(setup, "run", side_effect=fake_run):
                with self.assertRaisesRegex(setup.SetupError, "already exists"):
                    setup.setup_tunnel("hub.example.org", "home")
            self.assertEqual(config.read_text(), "existing settings\n")


if __name__ == "__main__":
    unittest.main()

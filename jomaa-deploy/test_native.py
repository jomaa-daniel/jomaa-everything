"""Native provisioning checks use temporary state and simulated Cloudflare commands."""

import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import native


class NativeTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.source = Path(self.temp.name)
        self.hub = self.source / "jomaa-home-hub"
        self.hub.mkdir()
        native.init_config(self.hub)
        self.data = self.hub / "data/native"

    def test_init_creates_private_password_and_preserves_config_and_state(self):
        env = (self.hub / ".env").read_text()
        self.assertIn("HUB_PASSWORD=", env)
        self.assertEqual((self.hub / ".env").stat().st_mode & 0o777, 0o600)
        self.assertEqual(json.loads((self.hub / "config.json").read_text())["devices"], [])
        (self.hub / "config.json").write_text('{"devices": []}')
        state = self.data / "matter-data/fabric"
        state.write_text("paired devices")
        native.init_config(self.hub)
        self.assertEqual((self.hub / ".env").read_text(), env)
        self.assertEqual((self.hub / "config.json").read_text(), '{"devices": []}')
        self.assertEqual(state.read_text(), "paired devices")

    def test_public_password_boundary_checked_before_cloudflare_setup(self):
        env = {"HUB_PASSWORD": "x" * 11, "CLOUDFLARE_API_TOKEN": "test-token"}
        with patch.object(native, "arch", return_value="amd64"), \
                patch.object(native.shutil, "which", return_value="program"), \
                patch.object(native, "run", return_value="v22.13.0"), \
                patch.object(native, "setup_tunnel") as tunnel:
            with self.assertRaisesRegex(ValueError, "at least 12 characters"):
                native.provision(self.source, env, "home")
            tunnel.assert_not_called()
            native.provision(self.source, {**env, "HUB_PASSWORD": "x" * 12}, "home")
            tunnel.assert_called_once_with(self.data, "home")

    def test_dns_token_required_before_cloudflare_setup(self):
        with patch.object(native, "arch", return_value="amd64"), \
                patch.object(native.shutil, "which", return_value="program"), \
                patch.object(native, "run", return_value="v22.13.0"), \
                patch.object(native, "setup_tunnel") as tunnel:
            with self.assertRaisesRegex(ValueError, "CLOUDFLARE_API_TOKEN"):
                native.provision(self.source, {"HUB_PASSWORD": "x" * 12}, "home")
            tunnel.assert_not_called()

    def test_existing_tunnel_keeps_complete_ingress(self):
        config = self.data / "tunnel.yml"
        config.write_text("existing settings\n")
        with patch.object(native, "get_cloudflared", return_value=self.data / "cloudflared"), \
                patch.object(native, "run") as run:
            native.setup_tunnel(self.data, "home")
        self.assertEqual(config.read_text(), "existing settings\n")
        run.assert_called_once_with(str(self.data / "cloudflared"), "--config", str(config),
                                    "tunnel", "ingress", "validate")

    def test_new_tunnel_has_credentials_and_no_public_routes_until_activation(self):
        tunnel_id = "4b03940e-11ab-48c6-b288-4c9deb2cc905"
        cloud = self.source / ".cloudflared"
        cloud.mkdir()
        (cloud / "cert.pem").touch()
        creds = cloud / (tunnel_id + ".json")
        creds.write_text("private credentials")
        calls = []

        def run(*args, capture=False):
            calls.append(args)
            if "list" in args:
                return json.dumps([{"id": tunnel_id, "name": "home", "deleted_at": "0001-01-01T00:00:00Z"}])
            return ""

        with patch.object(Path, "home", return_value=self.source), \
                patch.object(native, "get_cloudflared", return_value=self.data / "cloudflared"), \
                patch.object(native, "run", side_effect=run):
            native.setup_tunnel(self.data, "home")
        config = (self.data / "tunnel.yml").read_text()
        self.assertIn(tunnel_id, config)
        self.assertIn(str(creds), config)
        self.assertIn("http_status:404", config)
        self.assertNotIn("hostname:", config)
        self.assertFalse(any("dns" in call for call in calls))

    def test_download_checksum_failure_leaves_no_binary_or_partial_file(self):
        release = {"assets": [{"name": "cloudflared-linux-amd64", "digest": "sha256:" + "0" * 64,
                               "browser_download_url": "https://example.org/binary"}]}
        with patch.object(native, "arch", return_value="amd64"), \
                patch.object(native.urllib.request, "urlopen", side_effect=[
                    io.BytesIO(json.dumps(release).encode()), io.BytesIO(b"wrong binary")]):
            with self.assertRaisesRegex(ValueError, "checksum mismatch"):
                native.get_cloudflared(self.data)
        self.assertFalse((self.data / "cloudflared").exists())
        self.assertFalse((self.data / "cloudflared.download").exists())


if __name__ == "__main__":
    unittest.main()

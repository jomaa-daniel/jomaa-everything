"""Service launch checks keep environment and storage tied to the release."""

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import boot


class BootTest(unittest.TestCase):
    def test_hub_loads_credentials_and_bluetooth_settings_and_shared_storage(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            data = root / "data/native"
            (root / ".env").write_text("HUB_PASSWORD=test-password\nMATTER_BLUETOOTH_ADAPTER=2\nHEALTH_RETENTION_DAYS=7\n")
            with patch.object(boot, "ROOT", root), patch.object(boot, "DATA", data), \
                    patch.object(boot.sys, "argv", ["boot.py", "hub"]), \
                    patch.dict(os.environ, {}, clear=True), \
                    patch.object(boot.os, "chdir") as chdir, patch.object(boot.os, "execvpe") as launch:
                boot.main()
                command, args, env = launch.call_args.args
                self.assertEqual(command, "node")
                self.assertIn(str(data / "matter-data"), args)
                self.assertEqual(args[-2:], ["--bluetooth-adapter", "2"])
                self.assertEqual(env["HUB_PASSWORD"], "test-password")
                self.assertEqual(env["NOBLE_BINDINGS"], "dbus")
                self.assertEqual(env["HEALTH_RETENTION_DAYS"], "7")
                chdir.assert_called_once_with(root)


if __name__ == "__main__":
    unittest.main()

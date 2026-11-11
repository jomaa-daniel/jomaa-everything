from __future__ import annotations

from contextlib import ExitStack, redirect_stderr, redirect_stdout
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import setup_pico

OLD = "5303284720e42a9c"
NEW = "530328472857581c"
TOKEN = "a" * 64
WIFI = {"wifi_ssid": "test-network", "wifi_password": "private-wifi-password"}


class Hub:
    def __init__(self, old=None):
        self.origin = "https://hub.jomaa.org"
        self.devices = {} if old is None else {old["id"]: old}
        self.calls = []
        self.installed = None
        self.sequence = 0

    def request(self, path, body=None, method=None):
        self.calls.append((path, body, method))
        if path == "/api/devices":
            return {"devices": list(self.devices.values())}
        if path == "/api/devices/enroll":
            device = {**body, "status": "pending", "registeredAt": None, "latest": None}
            self.devices[body["id"]] = device
            return {"device": device, "token": TOKEN}
        device_id = path.split("/")[3]
        device = self.devices[device_id]
        if "/logs?" in path:
            if self.installed != device_id:
                return {"logs": []}
            self.sequence += 1
            heartbeat = {"bootId": "b" * 32, "sequence": self.sequence, "ip": "192.0.2.10",
                         "freeHeapBytes": 100000, "firmware": "jomaa-pico-health/1.0.0"}
            device.update(status="online", registeredAt=device.get("registeredAt") or 1,
                          lastSeen=self.sequence, latest=heartbeat)
            return {"logs": [{"id": self.sequence, "heartbeat": heartbeat}]}
        if body is not None:
            device.update(body)
        return {"device": device}


class SetupPicoTests(unittest.TestCase):
    def test_plan_never_opens_usb_enrolls_or_creates_outputs(self):
        with tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
            run = Path(directory) / "run"
            hub = stack.enter_context(patch.object(setup_pico, "Hub"))
            tools = stack.enter_context(patch.object(setup_pico.wifi, "install_tools"))
            flash = stack.enter_context(patch.object(setup_pico.wifi, "flash"))
            stack.enter_context(redirect_stdout(io.StringIO()))
            self.assertEqual(setup_pico.main(["--run-dir", str(run)]), 0)
            self.assertFalse(run.exists())
            for operation in (hub, tools, flash):
                operation.assert_not_called()

    def run_setup(self, configure):
        old = {"id": "pico-existing" if configure else "pico-" + OLD, "name": "Existing Pico", "intervalSeconds": 15,
               "status": "offline", "registeredAt": 123, "latest": None}
        client = Hub(old.copy())
        module = setup_pico.provisioner()
        uid = OLD if configure else NEW
        device_id = old["id"] if configure else "pico-" + uid
        port = "/dev/old" if configure else "/dev/" + uid
        with tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
            run = Path(directory) / "run"
            env = {"PYTHONPATH": str(run / "tools")}
            stack.enter_context(patch.object(setup_pico, "trusted_root", return_value=b"verified-root"))
            stack.enter_context(patch.object(setup_pico, "hub_password", return_value="private-hub-password"))
            stack.enter_context(patch.object(setup_pico, "Hub", return_value=client))
            stack.enter_context(patch.object(setup_pico, "provisioner", return_value=module))
            stack.enter_context(patch.object(setup_pico.wifi, "install_tools", return_value=env))
            stack.enter_context(patch.object(setup_pico.wifi, "require_serial_access"))
            stack.enter_context(patch.object(setup_pico.wifi, "ports", return_value={OLD: "/dev/old"}))
            stack.enter_context(patch.object(setup_pico.wifi, "find_bootsel", return_value=("/dev/bootsel", "/volume")))
            stack.enter_context(patch.object(setup_pico.wifi, "get_wifi", return_value=(WIFI.copy(), OLD)))
            stack.enter_context(patch.object(setup_pico.wifi, "download", return_value=b"firmware"))
            stack.enter_context(patch.object(setup_pico.wifi, "validate_firmware"))
            stack.enter_context(patch.object(setup_pico.wifi, "mount_bootsel", return_value=(Path("/volume"), False)))
            flash = stack.enter_context(patch.object(setup_pico.wifi, "flash"))
            stack.enter_context(patch.object(setup_pico.wifi, "returning_port", return_value=(NEW, port)))
            erase = stack.enter_context(patch.object(setup_pico, "fresh_filesystem"))
            stack.enter_context(patch("common.time.sleep"))

            def install(selected, prepared, *, env):
                self.assertEqual(selected, port)
                settings = json.loads((prepared / "device_config.json").read_text())
                self.assertEqual(settings["wifi_password"], WIFI["wifi_password"])
                self.assertEqual(settings["token"], TOKEN)
                self.assertEqual(settings["id"], device_id)
                self.assertEqual((prepared / "health_ca.der").read_bytes(), b"verified-root")
                for name in ("device_config.json", "health_ca.der", "main.py", "esp8285.py"):
                    self.assertEqual((prepared / name).stat().st_mode & 0o777, 0o600)
                self.assertEqual(env["PYTHONPATH"], str(run / "tools"))
                client.installed = settings["id"]

            install_mock = stack.enter_context(patch.object(module, "install", side_effect=install))
            arguments = ["--execute", "--run-dir", str(run)]
            if configure:
                arguments += ["--configure-port", "/dev/old"]
                stack.enter_context(patch.object(setup_pico.wifi, "target_identity", return_value=OLD))
                stack.enter_context(patch.object(setup_pico, "inspect_target", return_value={
                    "uid": OLD, "config": {**WIFI, "id": old["id"], "token": TOKEN,
                                            "hub_host": "hub.jomaa.org", "hub_port": 443},
                    "startup": "existing_startup()\n"}))
            printed = stack.enter_context(redirect_stdout(io.StringIO()))
            self.assertEqual(setup_pico.main(arguments), 0)
            install_mock.assert_called_once()
            report = json.loads((run / "report.json").read_text())
            self.assertEqual(report["status"], "online")
            self.assertGreaterEqual(report["reportsAccepted"], 3)
            self.assertEqual(client.devices[device_id]["registeredAt"], 123 if configure else 1)
            self.assertNotIn(TOKEN, printed.getvalue())
            self.assertNotIn(WIFI["wifi_password"], printed.getvalue())
            self.assertNotIn("private-hub-password", printed.getvalue())
            if configure:
                flash.assert_not_called()
                erase.assert_not_called()
                self.assertEqual((run / "startup-before.py").read_text(), "existing_startup()\n")
                self.assertFalse(any("enroll" in path or "credential" in path for path, _, _ in client.calls))
            else:
                flash.assert_called_once()
                erase.assert_called_once_with(port, NEW, "esp8285")
                self.assertEqual(client.devices[old["id"]], old)
                enrollment = [body for path, body, _ in client.calls if path == "/api/devices/enroll"]
                self.assertEqual(enrollment[0]["id"], "pico-" + NEW)

    def test_one_shot_flash_enroll_install_and_persisted_reports_preserves_existing_device(self):
        self.run_setup(configure=False)

    def test_configure_restores_existing_reporter_without_formatting_or_rotating(self):
        self.run_setup(configure=True)

    def test_untrusted_ca_prevents_hardware_access_and_enrollment(self):
        with tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
            stack.enter_context(patch.object(setup_pico, "trusted_root", side_effect=setup_pico.BenchError("untrusted CA")))
            stack.enter_context(patch.object(setup_pico.wifi, "find_bootsel", return_value=("/dev/bootsel", None)))
            hub = stack.enter_context(patch.object(setup_pico, "Hub"))
            tools = stack.enter_context(patch.object(setup_pico.wifi, "install_tools"))
            stack.enter_context(redirect_stderr(io.StringIO()))
            self.assertEqual(setup_pico.main(["--execute", "--run-dir", str(Path(directory) / "run")]), 1)
            hub.assert_not_called()
            tools.assert_not_called()

    def test_existing_credential_requires_matching_id_and_never_rotates_implicitly(self):
        client = Hub({"id": "pico-existing", "status": "online"})
        with self.assertRaises(setup_pico.BenchError):
            setup_pico.credentials(client, "pico-existing", "Pico", 15, {"id": "pico-other", "token": TOKEN}, False)
        self.assertFalse(any("credential" in path for path, _, _ in client.calls))

    def test_installed_credentials_cannot_be_reused_at_a_different_hub(self):
        client = Hub({"id": "pico-existing", "status": "online"})
        config = {"id": "pico-existing", "token": TOKEN, "hub_host": "another.example", "hub_port": 443}
        with self.assertRaises(setup_pico.BenchError):
            setup_pico.credentials(client, "pico-existing", "Pico", 15, config, False)

    def test_root_must_be_the_os_verified_trust_anchor(self):
        context = MagicMock()
        connection = context.wrap_socket.return_value.__enter__.return_value
        connection.get_verified_chain.return_value = [b"leaf", b"root"]
        context.get_ca_certs.return_value = [b"root"]
        raw = MagicMock()
        raw.__enter__.return_value = raw
        with patch.object(setup_pico.ssl, "create_default_context", return_value=context), \
                patch.object(setup_pico.socket, "create_connection", return_value=raw):
            self.assertEqual(setup_pico.trusted_root("https://hub.jomaa.org"), b"root")
            context.wrap_socket.assert_called_with(raw, server_hostname="hub.jomaa.org")
            context.get_ca_certs.return_value = [b"different-root"]
            with self.assertRaises(setup_pico.BenchError):
                setup_pico.trusted_root("https://hub.jomaa.org")


if __name__ == "__main__":
    unittest.main()

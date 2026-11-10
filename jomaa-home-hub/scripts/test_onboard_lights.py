"""Registration tests use private temporary configs and simulated device APIs."""

from __future__ import annotations

import io
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from contextlib import redirect_stderr, redirect_stdout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import onboard_lights as onboarding
from hubctl import HUB_DIR, Hub, HubError


def govee_inventory() -> dict:
    return {
        "sku": "H600B", "device": "AA:BB", "deviceName": "Desk Lamp", "type": "devices.types.light",
        "capabilities": [
            {"instance": "powerSwitch"}, {"instance": "brightness"}, {"instance": "colorRgb"},
            {"instance": "colorTemperatureK", "parameters": {"range": {"min": 2700, "max": 6500}}},
        ],
    }


class RegistrationTest(unittest.TestCase):
    def setUp(self):
        self.layout = {"listen": "127.0.0.1:8080", "devices": [], "rooms": []}
        self.light = onboarding.govee_light(govee_inventory(), "desk-lamp", None)

    def test_new_room_and_existing_nested_room_preserve_the_layout(self):
        result = onboarding.register(self.layout, self.light, "office", "Office")
        self.assertEqual(self.layout["devices"], [])
        result["rooms"].append({"id": "home", "name": "Home", "members": ["office"]})
        second = {**self.light, "id": "floor-lamp", "device": "CC:DD"}
        result = onboarding.register(result, second, "office", None)
        onboarding.validate_layout(HUB_DIR, result)
        self.assertEqual(result["rooms"][0]["members"], ["desk-lamp", "floor-lamp"])
        self.assertEqual(result["rooms"][1]["members"], ["office"])
        self.assertEqual(result["listen"], self.layout["listen"])

    def test_duplicate_target_and_physical_light_are_rejected(self):
        layout = onboarding.register(self.layout, self.light, None, None)
        with self.assertRaisesRegex(HubError, "already exists"):
            onboarding.register(layout, self.light, None, None)
        with self.assertRaisesRegex(HubError, "already registered as desk-lamp"):
            onboarding.register(layout, {**self.light, "id": "other", "device": "aa:bb"}, None, None)
        layout["rooms"] = [{"id": "office", "name": "Office", "members": ["desk-lamp"]}]
        with self.assertRaisesRegex(HubError, "already exists"):
            onboarding.register(layout, {**self.light, "id": "office", "device": "CC"}, None, None)

    def test_room_requirements_fail_before_writing(self):
        with self.assertRaisesRegex(HubError, "needs --room-name"):
            onboarding.register(self.layout, self.light, "office", None)
        with self.assertRaisesRegex(HubError, "conflicts"):
            onboarding.register(self.layout, self.light, "desk-lamp", "Desk")
        self.assertEqual(self.layout["devices"], [])

    def test_distinct_endpoints_of_a_bridge_can_be_registered(self):
        lamp = {"id": "a", "name": "A", "driver": "matter", "nodeId": 7, "endpoint": 2}
        layout = onboarding.register(self.layout, lamp, None, None)
        layout = onboarding.register(layout, {**lamp, "id": "b", "endpoint": 3}, None, None)
        with self.assertRaisesRegex(HubError, "already registered as a"):
            onboarding.register(layout, {**lamp, "id": "c"}, None, None)
        self.assertEqual(len(layout["devices"]), 2)

    def test_nonlights_missing_controls_and_bad_temperature_ranges_are_rejected(self):
        cases = [
            {**govee_inventory(), "type": "devices.types.socket"},
            {**govee_inventory(), "capabilities": []},
        ]
        for low, high in [(0, 6500), (6500, 2700), (True, 6500)]:
            raw = govee_inventory()
            raw["capabilities"][-1]["parameters"]["range"] = {"min": low, "max": high}
            cases.append(raw)
        for raw in cases:
            with self.subTest(raw=raw), self.assertRaises(HubError):
                onboarding.govee_light(raw, "lamp", None)


class ConfigFileTest(unittest.TestCase):
    def test_symlink_and_permissions_survive_atomic_replacement(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            target = directory / "persistent.json"
            target.write_text('{"devices": [], "rooms": []}')
            link = directory / "config.json"
            link.symlink_to(target)
            with onboarding.locked_layout(link) as (path, raw, layout):
                layout["devices"].append({"id": "new"})
                onboarding.save_layout(path, raw, layout)
            self.assertTrue(link.is_symlink())
            self.assertEqual(json.loads(target.read_text())["devices"], [{"id": "new"}])
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)
            self.assertEqual(sorted(p.name for p in directory.iterdir()), ["config.json", "persistent.json"])

    def test_concurrent_edit_is_preserved_and_temporary_file_is_removed(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "config.json"
            path.write_bytes(b"{}")
            with onboarding.locked_layout(path) as (target, raw, layout):
                with self.assertRaisesRegex(HubError, "another onboarding"):
                    with onboarding.locked_layout(path):
                        self.fail("a second command acquired the lock")
                target.write_bytes(b'{"external": true}')
                with self.assertRaisesRegex(HubError, "changed during"):
                    onboarding.save_layout(target, raw, layout)
            self.assertEqual(path.read_bytes(), b'{"external": true}')
            self.assertEqual(len(list(Path(tmp).iterdir())), 1)


class FakeAPI(BaseHTTPRequestHandler):
    def reply(self, status: int, body: dict):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self.server.calls.append(("GET", self.path, None))
        if self.path == "/router/api/v1/user/devices":
            self.server.keys.append(self.headers.get("Govee-API-Key"))
            self.reply(200, {"code": self.server.govee_code, "data": self.server.inventory})
        elif self.headers.get("Authorization") != "Bearer fake-token":
            self.reply(401, {"error": "sign in"})
        elif self.path == "/api/matter/nodes":
            self.reply(200, {"nodes": self.server.nodes})
        else:
            self.reply(404, {})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.server.calls.append(("POST", self.path, body))
        if self.path == "/router/api/v1/device/state":
            self.reply(200, {"code": 200, "payload": {"capabilities": [
                {"instance": "powerSwitch", "state": {"value": 0}},
                {"instance": "brightness", "state": {"value": 50}},
                {"instance": "colorTemperatureK", "state": {"value": 4000}},
            ]}})
        elif self.path == "/api/login":
            self.reply(200, {"token": "fake-token"})
        elif self.path == "/api/matter/commission":
            if self.server.pairing_error:
                self.reply(502, {"error": f"cannot pair {body['code']}"})
            else:
                self.reply(200, {"node": {"node_id": 7, "available": True, "is_bridge": False}})
        else:
            self.reply(200, {"ok": True})

    def log_message(self, *args):
        pass


class CommandTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / "dist").symlink_to(HUB_DIR / "dist", target_is_directory=True)
        self.config = self.root / "config.json"
        self.config.write_text(json.dumps({"devices": [], "rooms": []}))
        (self.root / ".env").write_text("HUB_PASSWORD=test-password\nGOVEE_API_KEY=test-key\n")
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), FakeAPI)
        self.server.calls = []
        self.server.keys = []
        self.server.govee_code = 200
        self.server.inventory = [govee_inventory()]
        self.server.nodes = [{"nodeId": 7, "available": True, "lightEndpoints": [2]}]
        self.server.pairing_error = False
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        self.env_patch = patch.dict(os.environ, {"GOVEE_BASE_URL": self.url, "HUB_PASSWORD": "test-password", "GOVEE_API_KEY": "test-key"})
        self.env_patch.start()
        self.addCleanup(self.env_patch.stop)

    def run_command(self, *args):
        stdout, stderr = io.StringIO(), io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            code = onboarding.main(["--hub-dir", str(self.root), "--url", self.url, *args])
        return code, stdout.getvalue(), stderr.getvalue()

    def test_govee_discovery_and_dry_run_do_not_write_or_send_controls(self):
        initial = self.config.read_bytes()
        code, out, err = self.run_command("discover", "govee")
        self.assertEqual(code, 0, err)
        self.assertTrue(json.loads(out)["lights"][0]["supported"])
        self.assertEqual(self.server.keys, ["test-key"])
        code, out, err = self.run_command("govee", "--device", "aa:bb", "--id", "desk", "--room", "office", "--room-name", "Office", "--dry-run")
        self.assertEqual(code, 0, err)
        self.assertEqual(json.loads(out)["devices"][0]["sku"], "H600B")
        self.assertEqual(self.config.read_bytes(), initial)
        self.assertFalse(any(method == "POST" for method, _, _ in self.server.calls))

    def test_govee_registration_uses_cloud_range_and_preserves_existing_config(self):
        code, out, err = self.run_command("govee", "--device", "AA:BB", "--id", "desk", "--room", "office", "--room-name", "Office", "--restart", "none")
        self.assertEqual(code, 0, err)
        layout = json.loads(self.config.read_text())
        self.assertEqual(layout["devices"][0]["minKelvin"], 2700)
        self.assertEqual(layout["rooms"][0]["members"], ["desk"])
        self.assertIn("Restart the hub", out)
        self.assertNotIn("test-key", out + err)

    def test_govee_http_success_with_error_code_does_not_register(self):
        self.server.govee_code = 429
        initial = self.config.read_bytes()
        code, _, err = self.run_command("govee", "--device", "AA:BB", "--id", "desk", "--restart", "none")
        self.assertEqual(code, 1)
        self.assertIn("unsuccessful", err)
        self.assertEqual(self.config.read_bytes(), initial)

    def test_selectors_register_govee_with_saved_metadata_and_no_address_entry(self):
        existing = onboarding.govee_light(govee_inventory(), "desk", None)
        self.config.write_text(json.dumps({"devices": [existing], "rooms": [{"id": "bedroom", "name": "Bedroom", "members": ["desk"]}]}))
        self.server.inventory.append({**govee_inventory(), "device": "CC:DD", "deviceName": "Bedroom mirror"})
        with patch("builtins.input", side_effect=["1", "1", "1"]):
            code, out, err = self.run_command("govee", "--restart", "none")
        self.assertEqual(code, 0, err)
        layout = json.loads(self.config.read_text())
        added = layout["devices"][-1]
        self.assertEqual(added, {"id": "bedroom-mirror", "name": "Bedroom mirror", "driver": "govee", "sku": "H600B", "device": "CC:DD", "minKelvin": 2700, "maxKelvin": 6500})
        self.assertEqual(layout["rooms"][0]["members"], ["desk", "bedroom-mirror"])
        inventory_path = self.root / "data/light-inventory/govee.json"
        self.assertEqual(json.loads(inventory_path.read_text())["devices"], self.server.inventory)
        self.assertEqual(inventory_path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.server.keys, ["test-key"])
        self.assertNotIn("test-key", inventory_path.read_text() + out + err)
        self.assertNotIn("Desk Lamp (", out)
        self.assertFalse(any(method == "POST" for method, _, _ in self.server.calls))

    def test_selectors_create_a_room_and_generate_distinct_ids(self):
        self.config.write_text(json.dumps({"devices": [{"id": "desk-lamp", "name": "Desk Lamp", "driver": "matter", "nodeId": 9}], "rooms": []}))
        with patch("builtins.input", side_effect=["1", "2", "Desk Lamp", "1"]):
            code, _, err = self.run_command("govee", "--restart", "none")
        self.assertEqual(code, 0, err)
        layout = json.loads(self.config.read_text())
        self.assertEqual(layout["devices"][-1]["id"], "desk-lamp-2")
        self.assertEqual(layout["rooms"], [{"id": "desk-lamp-3", "name": "Desk Lamp", "members": ["desk-lamp-2"]}])

    def test_cancel_after_selection_preserves_config_and_retains_discovery(self):
        initial = self.config.read_bytes()
        with patch("builtins.input", side_effect=["invalid", "9", "1", "1", "2"]):
            code, out, err = self.run_command("govee", "--restart", "none")
        self.assertEqual(code, 0, err)
        self.assertIn("Onboarding cancelled", out)
        self.assertEqual(self.config.read_bytes(), initial)
        self.assertTrue((self.root / "data/light-inventory/govee.json").is_file())
        self.assertFalse(any(method == "POST" for method, _, _ in self.server.calls))

    def test_selector_preview_does_not_write_discovery_or_registration(self):
        initial = self.config.read_bytes()
        with patch("builtins.input", side_effect=["1", "1"]):
            code, out, err = self.run_command("govee", "--dry-run")
        self.assertEqual(code, 0, err)
        self.assertIn('"device": "AA:BB"', out)
        self.assertEqual(self.config.read_bytes(), initial)
        self.assertFalse((self.root / "data").exists())

    def test_all_registered_and_unsupported_lights_do_not_offer_a_selector(self):
        existing = onboarding.govee_light(govee_inventory(), "desk", None)
        self.config.write_text(json.dumps({"devices": [existing], "rooms": []}))
        self.server.inventory.append({**govee_inventory(), "device": "CC", "type": "devices.types.socket"})
        initial = self.config.read_bytes()
        with patch("builtins.input", side_effect=AssertionError("prompted")):
            code, out, err = self.run_command("govee")
        self.assertEqual(code, 0, err)
        self.assertIn("No new supported", out)
        self.assertEqual(self.config.read_bytes(), initial)

    def test_no_subcommand_offers_provider_and_light_selectors(self):
        initial = self.config.read_bytes()
        with patch("builtins.input", side_effect=["1", "q"]):
            code, out, err = self.run_command()
        self.assertEqual(code, 0, err)
        self.assertIn("Choose a light provider", out)
        self.assertIn("Choose a Govee light", out)
        self.assertEqual(self.config.read_bytes(), initial)

    def test_matter_selector_excludes_registered_endpoints_and_uses_node_metadata(self):
        self.server.nodes = [{"nodeId": 7, "lightEndpoints": [2, 10], "label": "Desk", "product": "Bridge"}]
        self.config.write_text(json.dumps({"devices": [{"id": "existing", "name": "Existing", "driver": "matter", "nodeId": 7, "endpoint": 2}], "rooms": []}))
        with patch("builtins.input", side_effect=["1", "1", "1"]):
            code, _, err = self.run_command("matter", "--restart", "none")
        self.assertEqual(code, 0, err)
        added = json.loads(self.config.read_text())["devices"][-1]
        self.assertEqual((added["id"], added["name"], added["nodeId"], added["endpoint"]), ("desk", "Desk", 7, 10))
        inventory = json.loads((self.root / "data/light-inventory/matter.json").read_text())
        self.assertEqual(inventory["devices"], self.server.nodes)
        self.assertEqual(sum(path == "/api/matter/nodes" for _, path, _ in self.server.calls), 1)

    def test_pair_selector_gets_the_display_name_after_commissioning(self):
        self.server.nodes[0]["label"] = "New Desk Light"
        with patch("builtins.input", side_effect=["2", "1", "1", "1"]), \
                patch.object(onboarding.getpass, "getpass", return_value="private-setup-code"):
            code, _, err = self.run_command("matter", "--restart", "none")
        self.assertEqual(code, 0, err)
        added = json.loads(self.config.read_text())["devices"][0]
        self.assertEqual((added["id"], added["name"]), ("new-desk-light", "New Desk Light"))
        commission = next(body for _, path, body in self.server.calls if path == "/api/matter/commission")
        self.assertTrue(commission["networkOnly"])
        inventory = (self.root / "data/light-inventory/matter.json").read_text()
        self.assertNotIn("private-setup-code", inventory)

    def test_pairing_preview_never_prompts_or_calls_matter(self):
        initial = self.config.read_bytes()
        with patch.object(onboarding.getpass, "getpass", side_effect=AssertionError("prompted")):
            code, out, err = self.run_command("matter", "--pair", "--id", "desk", "--name", "Desk", "--wifi", "Network", "--dry-run")
        self.assertEqual(code, 0, err)
        self.assertIn("assigned after pairing", out)
        self.assertEqual(self.server.calls, [])
        self.assertEqual(self.config.read_bytes(), initial)

    def test_pairing_saves_node_and_detected_endpoint_with_credentials_kept_private(self):
        with patch.object(onboarding.getpass, "getpass", side_effect=["private-setup-code", "private-wifi-password"]):
            code, out, err = self.run_command("matter", "--pair", "--id", "desk", "--name", "Desk", "--wifi", "Network", "--restart", "none")
        self.assertEqual(code, 0, err)
        device = json.loads(self.config.read_text())["devices"][0]
        self.assertEqual((device["nodeId"], device["endpoint"]), (7, 2))
        self.assertIn("--node-id 7", out)
        paths = [path for method, path, _ in self.server.calls if method == "POST"]
        self.assertEqual(paths, ["/api/login", "/api/matter/wifi", "/api/matter/commission"])
        self.assertNotIn("private-", out + err + self.config.read_text())

    def test_pairing_failure_redacts_setup_code_and_keeps_config(self):
        self.server.pairing_error = True
        initial = self.config.read_bytes()
        with patch.object(onboarding.getpass, "getpass", return_value="private-setup-code"):
            code, out, err = self.run_command("matter", "--pair", "--id", "desk", "--name", "Desk", "--restart", "none")
        self.assertEqual(code, 1)
        self.assertIn("[redacted]", err)
        self.assertNotIn("private-setup-code", out + err)
        self.assertEqual(self.config.read_bytes(), initial)

    def test_multiple_endpoints_require_selection_and_nonlight_endpoint_is_rejected(self):
        self.server.nodes[0]["lightEndpoints"] = [2, 10]
        initial = self.config.read_bytes()
        for endpoint in [None, "3"]:
            args = ["matter", "--node-id", "7", "--id", "desk", "--name", "Desk", "--restart", "none"]
            if endpoint:
                args.extend(["--endpoint", endpoint])
            code, _, err = self.run_command(*args)
            self.assertEqual(code, 1, err)
            self.assertEqual(self.config.read_bytes(), initial)
        code, _, err = self.run_command("matter", "--node-id", "7", "--endpoint", "10", "--id", "desk", "--name", "Desk", "--restart", "none")
        self.assertEqual(code, 0, err)

    def test_duplicate_id_and_bad_room_are_rejected_before_pairing(self):
        self.config.write_text(json.dumps({"devices": [{"id": "desk", "name": "Desk", "driver": "matter", "nodeId": 8}], "rooms": []}))
        with patch.object(onboarding.getpass, "getpass", side_effect=AssertionError("prompted")):
            for args in [[], ["--id", "other", "--room", "unknown"]]:
                code, _, err = self.run_command("matter", "--pair", "--id", "desk", "--name", "Desk", "--restart", "none", *args)
                self.assertEqual(code, 1, err)
        self.assertEqual(self.server.calls, [])

    def test_inactive_service_prevents_pairing_and_config_writes(self):
        initial = self.config.read_bytes()
        actual_run = subprocess.run
        with patch.object(onboarding.subprocess, "run", wraps=subprocess.run) as run, \
                patch.object(onboarding.getpass, "getpass", side_effect=AssertionError("prompted")):
            def service_check(command, **kwargs):
                if command[0] == "systemctl":
                    return subprocess.CompletedProcess(command, 1)
                return actual_run(command, **kwargs)

            run.side_effect = service_check
            code, _, err = self.run_command("matter", "--pair", "--id", "desk", "--name", "Desk")
        self.assertEqual(code, 1)
        self.assertIn("not running", err)
        self.assertEqual(self.config.read_bytes(), initial)
        self.assertEqual(self.server.calls, [])

    def test_registration_restarts_a_real_hub_and_reads_the_new_light(self):
        with socket.socket() as socket_reservation:
            socket_reservation.bind(("127.0.0.1", 0))
            port = socket_reservation.getsockname()[1]
        self.config.write_text(json.dumps({"listen": f"127.0.0.1:{port}", "devices": [], "rooms": []}))
        api_url = f"http://127.0.0.1:{port}"
        processes = []

        def start_hub():
            proc = subprocess.Popen(
                ["node", str(HUB_DIR / "dist/main.js"), "--config", str(self.config), "--no-matter"],
                cwd=self.root, env={**os.environ, "HEALTH_DB_PATH": str(self.root / "health.sqlite")},
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            processes.append(proc)
            deadline = time.monotonic() + 15
            hub = Hub(api_url, "test-password")
            while not hub.healthy():
                if proc.poll() is not None or time.monotonic() > deadline:
                    self.fail("real hub did not start")
                time.sleep(0.1)

        def stop_hub():
            for proc in processes:
                if proc.poll() is None:
                    proc.terminate()
                    proc.wait(timeout=15)

        self.addCleanup(stop_hub)
        start_hub()
        actual_run = subprocess.run

        def service_command(command, **kwargs):
            if command[0] != "systemctl":
                return actual_run(command, **kwargs)
            if "restart" in command:
                stop_hub()
                start_hub()
            return subprocess.CompletedProcess(command, 0)

        with patch.object(onboarding.subprocess, "run", side_effect=service_command):
            code, out, err = self.run_command("--url", api_url, "govee", "--device", "AA:BB", "--id", "desk",
                                              "--room", "office", "--room-name", "Office")
        self.assertEqual(code, 0, err)
        self.assertIn("desk is active", out)
        targets = Hub(api_url, "test-password").call("GET", "/api/targets")["targets"]
        self.assertEqual([t["id"] for t in targets], ["desk", "office"])
        paths = [path for _, path, _ in self.server.calls]
        self.assertIn("/router/api/v1/device/state", paths)
        self.assertNotIn("/router/api/v1/device/control", paths)

class ActivationTest(unittest.TestCase):
    def test_restart_waits_for_matter_state_without_sending_a_command(self):
        class Hub:
            calls = []
            states = 0

            def call(self, method, path):
                self.calls.append((method, path))
                if path == "/api/targets":
                    return {"targets": [{"id": "lamp", "kind": "matter"}, {"id": "office", "members": ["lamp"]}]}
                self.states += 1
                return {"failed": {"lamp": "not ready"}} if self.states == 1 else {"devices": {"lamp": {"on": False}}}

        hub = Hub()
        with patch.object(onboarding.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)) as run, \
                patch.object(onboarding.time, "sleep") as sleep, redirect_stdout(io.StringIO()):
            onboarding.activate(HUB_DIR, {}, "native", hub, "lamp", "office")
        self.assertEqual(hub.states, 2)
        sleep.assert_called_once_with(2)
        self.assertTrue(all(method == "GET" for method, _ in hub.calls))
        self.assertEqual(run.call_args.args[0], ["systemctl", "--user", "restart", "jomaa-hub.service"])


if __name__ == "__main__":
    unittest.main()

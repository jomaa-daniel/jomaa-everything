"""Tests for hubctl.py. The end-to-end test builds the real hub, points it at a
fake Govee API, and drives it through hubctl.

Run from jomaa-home-hub/:  python3 -m unittest discover -s scripts
"""

from __future__ import annotations

import io
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from contextlib import redirect_stdout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hubctl  # noqa: E402


class LoadEnvTest(unittest.TestCase):
    def test_reads_file_and_lets_real_env_win(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / ".env"
            path.write_text('# comment\nHUB_PASSWORD="from-file"\nGOVEE_API_KEY=abc\nnot a pair\n')
            old = os.environ.get("HUB_PASSWORD")
            os.environ["HUB_PASSWORD"] = "from-env"
            try:
                env = hubctl.load_env(path)
            finally:
                if old is None:
                    del os.environ["HUB_PASSWORD"]
                else:
                    os.environ["HUB_PASSWORD"] = old
        self.assertEqual(env["HUB_PASSWORD"], "from-env")
        self.assertEqual(env["GOVEE_API_KEY"], "abc")

    def test_missing_file_is_fine(self):
        self.assertIsInstance(hubctl.load_env(Path("/nonexistent/.env")), dict)


class CheckSetupTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.dir)

    def write_config(self, devices):
        (self.dir / "config.json").write_text(json.dumps({"devices": devices, "rooms": []}))

    def test_missing_everything(self):
        problems = hubctl.check_setup(self.dir, {})
        self.assertTrue(any("config.json is missing" in p for p in problems))
        self.assertTrue(any("HUB_PASSWORD" in p for p in problems))

    def test_placeholder_password_rejected(self):
        self.write_config([])
        problems = hubctl.check_setup(self.dir, {"HUB_PASSWORD": "change-me"})
        self.assertTrue(any("placeholder" in p for p in problems))

    def test_govee_needs_key(self):
        self.write_config([{"id": "a", "driver": "govee"}])
        problems = hubctl.check_setup(self.dir, {"HUB_PASSWORD": "pw"})
        self.assertEqual(problems, ["config.json has Govee devices but GOVEE_API_KEY is not set"])

    def test_matter_only_needs_no_govee_key(self):
        self.write_config([{"id": "a", "driver": "matter", "nodeId": 1}])
        self.assertEqual(hubctl.check_setup(self.dir, {"HUB_PASSWORD": "pw"}), [])

    def test_bad_json(self):
        (self.dir / "config.json").write_text("{")
        problems = hubctl.check_setup(self.dir, {"HUB_PASSWORD": "pw"})
        self.assertTrue(any("not valid JSON" in p for p in problems))


class FakeGovee(BaseHTTPRequestHandler):
    calls: list[dict] = []

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        FakeGovee.calls.append({"path": self.path, "key": self.headers.get("Govee-API-Key"), "body": body})
        out = json.dumps({"code": 200, "msg": "success"}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, *args):
        pass


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@unittest.skipUnless((hubctl.HUB_DIR / "node_modules").is_dir(), "needs npm ci in jomaa-home-hub to build the hub")
class EndToEndTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp())
        subprocess.run(["npm", "run", "build"], cwd=hubctl.HUB_DIR, check=True, capture_output=True)

        cls.govee = ThreadingHTTPServer(("127.0.0.1", 0), FakeGovee)
        threading.Thread(target=cls.govee.serve_forever, daemon=True).start()

        port = free_port()
        config = {
            "listen": f"127.0.0.1:{port}",
            "devices": [
                {"id": "lamp-a", "name": "Lamp A", "driver": "govee", "sku": "H607C", "device": "AA", "minKelvin": 2200, "maxKelvin": 6500},
                {"id": "lamp-b", "name": "Lamp B", "driver": "govee", "sku": "H6006", "device": "BB", "minKelvin": 2000, "maxKelvin": 9000},
            ],
            "rooms": [{"id": "living-room", "name": "Living Room", "members": ["lamp-a", "lamp-b"]}],
        }
        (cls.tmp / "config.json").write_text(json.dumps(config))
        cls.env = {"HUB_PASSWORD": "test-pw", "GOVEE_API_KEY": "fake-key", "HUB_URL": f"http://127.0.0.1:{port}",
                   "HEALTH_DB_PATH": str(cls.tmp / "health.sqlite")}
        cls.proc = subprocess.Popen(
            # Without Matter, so pairing reports that it's unavailable.
            ["node", str(hubctl.HUB_DIR / "dist/main.js"), "--config", str(cls.tmp / "config.json"), "--no-matter"],
            env={**os.environ, **cls.env, "GOVEE_BASE_URL": f"http://127.0.0.1:{cls.govee.server_port}"},
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        hub = hubctl.hub_from_env(cls.env)
        deadline = time.monotonic() + 15
        while not hub.healthy():
            if time.monotonic() > deadline or cls.proc.poll() is not None:
                raise RuntimeError("hub didn't start")
            time.sleep(0.1)

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        cls.proc.wait(timeout=10)
        cls.govee.shutdown()
        cls.govee.server_close()
        shutil.rmtree(cls.tmp)

    def setUp(self):
        FakeGovee.calls.clear()

    def run_hubctl(self, *args) -> str:
        out = io.StringIO()
        with redirect_stdout(out):
            for k, v in self.env.items():
                os.environ[k] = v
            try:
                code = hubctl.main(list(args))
            finally:
                for k in self.env:
                    os.environ.pop(k, None)
        self.assertEqual(code, 0, out.getvalue())
        return out.getvalue()

    def test_room_command_reaches_every_lamp(self):
        self.run_hubctl("on", "living-room")
        devices = sorted(c["body"]["payload"]["device"] for c in FakeGovee.calls)
        self.assertEqual(devices, ["AA", "BB"])
        for c in FakeGovee.calls:
            self.assertEqual(c["path"], "/router/api/v1/device/control")
            self.assertEqual(c["key"], "fake-key")
            self.assertEqual(c["body"]["payload"]["capability"], {"type": "devices.capabilities.on_off", "instance": "powerSwitch", "value": 1})

    def test_status_lists_rooms_and_reports_matter_down(self):
        out = self.run_hubctl("status")
        self.assertIn("matter: NOT ready", out)
        self.assertIn("living-room", out)
        self.assertIn("[lamp-a, lamp-b]", out)

    def test_wrong_password_fails_cleanly(self):
        hub = hubctl.Hub(self.env["HUB_URL"], "wrong")
        with self.assertRaises(hubctl.HubError):
            hub.call("GET", "/api/targets")

    def test_commission_without_matter_is_an_error(self):
        hub = hubctl.hub_from_env(self.env)
        with self.assertRaisesRegex(hubctl.HubError, "not running"):
            hub.call("POST", "/api/matter/commission", {"code": "34970112332"})


if __name__ == "__main__":
    unittest.main()

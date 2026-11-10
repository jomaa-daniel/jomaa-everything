#!/usr/bin/env python3
"""Run the real hub against a fake Govee cloud, for testing the phone apps.

    python3 scripts/test_hub.py            hub on 127.0.0.1:8797, fake Govee on 127.0.0.1:8798
    python3 scripts/test_hub.py --port 9000 --fake-port 9001

Hub password: device-panel-test. Layout: a "Living Room" with two lamps.
The fake keeps lamp state and exposes test controls:

    GET  /__fake/state      {"devices": {"AA": {...}, "BB": {...}}}
    GET  /__fake/requests   every control call, in order
    POST /__fake/reset      lamps on at 50%, history cleared
    POST /__fake/fail       {"enabled": true} makes every Govee call fail

The iOS simulator reaches these at 127.0.0.1; the Android emulator at 10.0.2.2.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HUB_DIR = Path(__file__).resolve().parents[2] / "jomaa-home-hub"
PASSWORD = "device-panel-test"
LAMPS = {"AA": ("lamp-a", "Lamp A", "H607C", 2200, 6500), "BB": ("lamp-b", "Lamp B", "H6006", 2000, 9000)}


class FakeGovee:
    def __init__(self):
        self.lock = threading.Lock()
        self.reset()

    def reset(self):
        with getattr(self, "lock", threading.Lock()):
            self.devices = {mac: {"powerSwitch": 1, "brightness": 50, "colorTemperatureK": 4000} for mac in LAMPS}
            self.requests: list[dict] = []
            self.failing = False


def make_handler(fake: FakeGovee):
    class Handler(BaseHTTPRequestHandler):
        def send_json(self, value, status=200):
            data = json.dumps(value).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def body(self) -> dict:
            length = int(self.headers.get("Content-Length") or 0)
            return json.loads(self.rfile.read(length) or b"{}")

        def do_GET(self):
            with fake.lock:
                if self.path == "/__fake/state":
                    return self.send_json({"devices": fake.devices})
                if self.path == "/__fake/requests":
                    return self.send_json(fake.requests)
            self.send_json({"error": "not found"}, 404)

        def do_POST(self):
            body = self.body()
            if self.path == "/__fake/reset":
                fake.reset()
                return self.send_json({"ok": True})
            if self.path == "/__fake/fail":
                with fake.lock:
                    fake.failing = bool(body.get("enabled"))
                return self.send_json({"ok": True})
            payload = body.get("payload", {})
            with fake.lock:
                if fake.failing:
                    return self.send_json({"code": 500, "msg": "simulated Govee outage"})
                lamp = fake.devices.get(payload.get("device"))
                if lamp is None:
                    return self.send_json({"code": 400, "msg": "devices not exist"})
                if self.path.endswith("/device/control"):
                    cap = payload["capability"]
                    lamp[cap["instance"]] = cap["value"]
                    fake.requests.append({"device": payload["device"], **cap})
                    return self.send_json({"code": 200, "msg": "success"})
                if self.path.endswith("/device/state"):
                    caps = [{"type": "", "instance": k, "state": {"value": v}} for k, v in lamp.items()]
                    return self.send_json({"code": 200, "payload": {**payload, "capabilities": caps}})
            self.send_json({"error": "not found"}, 404)

        def log_message(self, *args):
            pass

    return Handler


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", type=int, default=8797)
    parser.add_argument("--fake-port", type=int, default=8798)
    args = parser.parse_args()

    fake = FakeGovee()
    server = ThreadingHTTPServer(("127.0.0.1", args.fake_port), make_handler(fake))
    threading.Thread(target=server.serve_forever, daemon=True).start()

    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run(["npm", "run", "build"], cwd=HUB_DIR, check=True)
        config = {
            "listen": f"127.0.0.1:{args.port}",
            "devices": [
                {"id": i, "name": n, "driver": "govee", "sku": s, "device": mac, "minKelvin": lo, "maxKelvin": hi}
                for mac, (i, n, s, lo, hi) in LAMPS.items()
            ],
            "rooms": [{"id": "living-room", "name": "Living Room", "members": [v[0] for v in LAMPS.values()]}],
        }
        (Path(tmp) / "config.json").write_text(json.dumps(config))
        env = {**os.environ, "HUB_PASSWORD": PASSWORD, "GOVEE_API_KEY": "test",
               "GOVEE_BASE_URL": f"http://127.0.0.1:{args.fake_port}"}
        # Without Matter, so pairing reports that it's unavailable.
        hub = subprocess.Popen(["node", str(HUB_DIR / "dist/main.js"), "--config", str(Path(tmp) / "config.json"),
                                "--no-matter"], env=env)
        try:
            deadline = time.monotonic() + 15
            while True:
                try:
                    urllib.request.urlopen(f"http://127.0.0.1:{args.port}/healthz", timeout=1)
                    break
                except OSError:
                    if time.monotonic() > deadline or hub.poll() is not None:
                        print("hub didn't start", file=sys.stderr)
                        return 1
                    time.sleep(0.1)
            print(f"hub: http://127.0.0.1:{args.port}  password: {PASSWORD}")
            print(f"fake Govee: http://127.0.0.1:{args.fake_port}/__fake/state  (Ctrl-C to stop)", flush=True)
            hub.wait()
        except KeyboardInterrupt:
            pass
        finally:
            hub.terminate()
            hub.wait(timeout=10)
            server.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())

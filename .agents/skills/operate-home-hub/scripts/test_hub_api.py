"""Exercise authentication and error handling against a local fake hub."""

import json
import os
import subprocess
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SCRIPT = Path(__file__).with_name("hub_api.py")
PASSWORD = "fixture-password"
TOKEN = "fixture-bearer-token"


class Handler(BaseHTTPRequestHandler):
    def reply(self, status, body):
        raw = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.path == "/api/login" and body.get("password") == PASSWORD:
            return self.reply(200, {"token": TOKEN})
        if self.path == "/api/targets/room/command" and self.headers.get("Authorization") == "Bearer " + TOKEN:
            return self.reply(502, {"failed": {"lamp": "unavailable"}})
        return self.reply(401, {"error": "unauthorized"})

    def do_GET(self):
        if self.path == "/healthz":
            return self.reply(200, {"ok": True})
        if self.path == "/api/targets" and self.headers.get("Authorization") == "Bearer " + TOKEN:
            return self.reply(200, {"targets": [{"id": "room"}]})
        return self.reply(401, {"error": "unauthorized"})

    def log_message(self, *args):
        pass


class HubApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def call(self, *args, body=None, url=None):
        env = {**os.environ, "JOMAA_HUB_PASSWORD": PASSWORD}
        return subprocess.run([sys.executable, str(SCRIPT), *args, "--url", url or self.url],
                              input=body, env=env, capture_output=True, text=True, timeout=10)

    def test_health_and_authenticated_targets_do_not_print_secrets(self):
        health = self.call("GET", "/healthz")
        self.assertEqual(json.loads(health.stdout), {"ok": True})
        targets = self.call("GET", "/api/targets")
        self.assertEqual(json.loads(targets.stdout)["targets"][0]["id"], "room")
        self.assertNotIn(PASSWORD, targets.stdout + targets.stderr)
        self.assertNotIn(TOKEN, targets.stdout + targets.stderr)

    def test_command_reports_partial_failure(self):
        result = self.call("POST", "/api/targets/room/command", "--json-stdin", body='{"on":true}')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("HTTP 502", result.stderr)
        self.assertIn("unavailable", result.stderr)
        self.assertNotIn(TOKEN, result.stderr)

    def test_nonlocal_plain_http_is_rejected(self):
        result = self.call("GET", "/api/targets", url="http://example.com")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must use HTTPS", result.stderr)


if __name__ == "__main__":
    unittest.main()

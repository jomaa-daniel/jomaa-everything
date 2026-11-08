"""Tests for cloudflare.py against a fake Cloudflare v4 API.

Run from jomaa-home-hub/:  python3 -m unittest discover -s scripts
"""

from __future__ import annotations

import io
import json
import os
import shutil
import sys
import tempfile
import threading
import unittest
import uuid
from contextlib import redirect_stdout
from unittest import mock
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
import cloudflare  # noqa: E402
import hubctl  # noqa: E402

TOKEN = "test-api-token"
ACCOUNT = "acct-123"


class FakeCloudflare:
    """Keeps zones, tunnels, tunnel configs and DNS records in memory."""

    def __init__(self):
        self.zones = [{"id": "zone-1", "name": "example.org", "status": "active", "account": {"id": ACCOUNT}}]
        self.tunnels: dict[str, dict] = {}
        self.configs: dict[str, dict] = {}
        self.records: dict[str, dict] = {}
        self.calls: list[tuple[str, str]] = []
        self.lock = threading.Lock()

    def handle(self, method: str, path: str, query: dict, body: dict | None):
        parts = path.strip("/").split("/")[2:]  # drop "client/v4"
        self.calls.append((method, "/" + "/".join(parts)))
        match parts:
            case ["zones"]:
                return [z for z in self.zones if z["name"] == query.get("name")]
            case ["accounts", _, "cfd_tunnel"] if method == "GET":
                return [t for t in self.tunnels.values() if t["name"] == query.get("name") and not t.get("deleted_at")]
            case ["accounts", _, "cfd_tunnel"] if method == "POST":
                tid = str(uuid.uuid4())
                self.tunnels[tid] = {"id": tid, "name": body["name"], "remote_config": body.get("config_src") == "cloudflare",
                                     "status": "inactive", "connections": []}
                return self.tunnels[tid]
            case ["accounts", _, "cfd_tunnel", tid] if method == "GET":
                return self.tunnels[tid]
            case ["accounts", _, "cfd_tunnel", tid] if method == "DELETE":
                return self.tunnels.pop(tid)
            case ["accounts", _, "cfd_tunnel", tid, "configurations"]:
                self.configs[tid] = body["config"]
                return {"tunnel_id": tid, "config": body["config"]}
            case ["accounts", _, "cfd_tunnel", tid, "token"]:
                return f"token-for-{tid}"
            case ["accounts", _, "cfd_tunnel", tid, "connections"]:
                self.tunnels[tid]["connections"] = []
                return None
            case ["zones", _, "dns_records"] if method == "GET":
                return [r for r in self.records.values() if r["name"] == query.get("name")]
            case ["zones", _, "dns_records"] if method == "POST":
                rid = str(uuid.uuid4())
                self.records[rid] = {"id": rid, **body}
                return self.records[rid]
            case ["zones", _, "dns_records", rid] if method == "PUT":
                self.records[rid] = {"id": rid, **body}
                return self.records[rid]
            case ["zones", _, "dns_records", rid] if method == "DELETE":
                self.records.pop(rid)
                return {"id": rid}
        raise LookupError(f"{method} {path}")


def serve(fake: FakeCloudflare) -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        def respond(self):
            url = urlsplit(self.path)
            query = {k: v[0] for k, v in parse_qs(url.query).items()}
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length)) if length else None
            if self.headers.get("Authorization") != f"Bearer {TOKEN}":
                status, out = 403, {"success": False, "errors": [{"code": 10000, "message": "Authentication error"}]}
            else:
                try:
                    with fake.lock:
                        status, out = 200, {"success": True, "errors": [], "result": fake.handle(self.command, url.path, query, body)}
                except LookupError as e:
                    status, out = 404, {"success": False, "errors": [{"code": 7003, "message": f"no route {e}"}]}
            data = json.dumps(out).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        do_GET = do_POST = do_PUT = do_DELETE = respond

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


class CloudflareTest(unittest.TestCase):
    def setUp(self):
        self.fake = FakeCloudflare()
        self.server = serve(self.fake)
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.cf = cloudflare.Cloudflare(TOKEN, f"http://127.0.0.1:{self.server.server_port}/client/v4")
        self.settings = cloudflare.Settings("hub.example.org", "jomaa-home-hub", "http://localhost:8080")

    def test_deploy_creates_tunnel_route_and_dns(self):
        out = cloudflare.deploy(self.cf, self.settings)
        self.assertTrue(out["tunnelCreated"])
        self.assertEqual(out["account"], ACCOUNT)
        tid = out["tunnel"]
        self.assertTrue(self.fake.tunnels[tid]["remote_config"])
        self.assertEqual(self.fake.configs[tid]["ingress"], [
            {"hostname": "hub.example.org", "service": "http://localhost:8080", "originRequest": {}},
            {"service": "http_status:404"},
        ])
        [record] = self.fake.records.values()
        self.assertEqual((record["type"], record["name"], record["content"], record["proxied"]),
                         ("CNAME", "hub.example.org", f"{tid}.cfargotunnel.com", True))

    def test_deploy_again_reuses_everything(self):
        first = cloudflare.deploy(self.cf, self.settings)
        second = cloudflare.deploy(self.cf, self.settings)
        self.assertFalse(second["tunnelCreated"])
        self.assertEqual(second["tunnel"], first["tunnel"])
        self.assertEqual(second["dns"], "unchanged")
        self.assertEqual((len(self.fake.tunnels), len(self.fake.records)), (1, 1))

    def test_existing_record_is_not_clobbered_without_replace(self):
        self.fake.records["r1"] = {"id": "r1", "type": "A", "name": "hub.example.org", "content": "203.0.113.5"}
        with self.assertRaisesRegex(cloudflare.CloudflareError, "already has a A record"):
            cloudflare.deploy(self.cf, self.settings)
        self.assertIn("r1", self.fake.records)
        out = cloudflare.deploy(self.cf, self.settings, replace=True)
        self.assertEqual(out["dns"], "created")
        self.assertEqual([r["type"] for r in self.fake.records.values()], ["CNAME"])

    def test_record_for_an_old_tunnel_is_repointed(self):
        self.fake.records["r1"] = {"id": "r1", "type": "CNAME", "name": "hub.example.org",
                                   "content": "old-tunnel.cfargotunnel.com", "proxied": True}
        out = cloudflare.deploy(self.cf, self.settings)
        self.assertEqual(out["dns"], "updated")
        self.assertEqual(self.fake.records["r1"]["content"], f"{out['tunnel']}.cfargotunnel.com")

    def test_zone_found_from_a_deeper_hostname(self):
        settings = cloudflare.Settings("lights.home.example.org", "t", "http://localhost:8080")
        self.assertEqual(cloudflare.deploy(self.cf, settings)["zone"], "example.org")

    def test_explicit_account_wins(self):
        out = cloudflare.deploy(self.cf, self.settings, account="other-acct")
        self.assertEqual(out["account"], "other-acct")
        self.assertIn(("POST", "/accounts/other-acct/cfd_tunnel"), self.fake.calls)

    def test_missing_zone_and_bad_token_explain_themselves(self):
        with self.assertRaisesRegex(cloudflare.CloudflareError, "no active Cloudflare zone covers hub.nowhere.net"):
            cloudflare.deploy(self.cf, cloudflare.Settings("hub.nowhere.net", "t", "http://localhost:8080"))
        bad = cloudflare.Cloudflare("wrong", self.cf.base)
        with self.assertRaisesRegex(cloudflare.CloudflareError, "Authentication error"):
            cloudflare.deploy(bad, self.settings)

    def test_locally_managed_tunnel_with_same_name_is_refused(self):
        self.fake.tunnels["t1"] = {"id": "t1", "name": "jomaa-home-hub", "remote_config": False, "connections": []}
        with self.assertRaisesRegex(cloudflare.CloudflareError, "local config file"):
            cloudflare.deploy(self.cf, self.settings)

    def test_missing_hostname_makes_no_api_calls(self):
        with self.assertRaisesRegex(cloudflare.CloudflareError, "CLOUDFLARE_HOSTNAME is not set"):
            cloudflare.deploy(self.cf, cloudflare.Settings(""))
        self.assertEqual(self.fake.calls, [])

    def test_token_fetch_and_destroy(self):
        out = cloudflare.deploy(self.cf, self.settings)
        _, tid, token = cloudflare.tunnel_token(self.cf, self.settings, None)
        self.assertEqual((tid, token), (out["tunnel"], f"token-for-{out['tunnel']}"))

        stopped = []
        original = cloudflare.compose
        cloudflare.compose = lambda *a, **k: stopped.append(a)
        self.addCleanup(setattr, cloudflare, "compose", original)
        cloudflare.destroy(self.cf, self.settings, None)
        self.assertEqual(stopped, [("rm", "--stop", "--force", "cloudflared")])
        self.assertEqual((self.fake.tunnels, self.fake.records), ({}, {}))

    def test_settings_come_from_env(self):
        settings = cloudflare.Settings.from_env({"CLOUDFLARE_HOSTNAME": " Hub.Example.org. "})
        self.assertEqual(settings, cloudflare.Settings("hub.example.org", "jomaa-home-hub", "http://localhost:8080"))
        custom = cloudflare.Settings.from_env({"CLOUDFLARE_HOSTNAME": "hub.example.org", "CLOUDFLARE_TUNNEL_NAME": "home",
                                               "CLOUDFLARE_TUNNEL_SERVICE": "http://127.0.0.1:9000"})
        self.assertEqual((custom.tunnel, custom.service), ("home", "http://127.0.0.1:9000"))
        self.assertFalse(cloudflare.Settings.from_env({}).configured)
        for bad in ({"CLOUDFLARE_HOSTNAME": "not a host"},
                    {"CLOUDFLARE_HOSTNAME": "hub.example.org", "CLOUDFLARE_TUNNEL_SERVICE": "http://10.0.0.5:8080"},
                    {"CLOUDFLARE_HOSTNAME": "hub.example.org", "CLOUDFLARE_TUNNEL_NAME": "bad name!"}):
            with self.assertRaises(cloudflare.CloudflareError, msg=str(bad)):
                cloudflare.Settings.from_env(bad)

    def test_cli_reads_hostname_from_env(self):
        out = io.StringIO()
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.enterContext(mock.patch.object(cloudflare, "HUB_DIR", Path(tmp.name)))
        with mock.patch.dict(os.environ, {"CLOUDFLARE_HOSTNAME": "", "CLOUDFLARE_API_TOKEN": ""}), redirect_stdout(out):
            self.assertEqual(cloudflare.main(["deploy", "--if-configured"]), 0)
        self.assertIn("CLOUDFLARE_HOSTNAME isn't set", out.getvalue())
        with mock.patch.dict(os.environ, {"CLOUDFLARE_HOSTNAME": "hub.example.org", "CLOUDFLARE_API_TOKEN": TOKEN}), \
                mock.patch.object(cloudflare, "API", self.cf.base), redirect_stdout(out):
            self.assertEqual(cloudflare.main(["deploy"]), 0)
        self.assertIn("dns hub.example.org", out.getvalue())
        self.assertEqual(len(self.fake.records), 1)


class HubctlTunnelTest(unittest.TestCase):
    def test_tunnel_requires_a_long_password(self):
        d = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, d)
        (d / "config.json").write_text(json.dumps({"devices": [], "rooms": []}))
        env = {"HUB_PASSWORD": "short-password", "CLOUDFLARE_HOSTNAME": "hub.example.org", "CLOUDFLARE_API_TOKEN": "t"}
        self.assertTrue(any("16+ characters" in p for p in hubctl.check_setup(d, env)))
        env["HUB_PASSWORD"] = "a-much-longer-passphrase"
        self.assertEqual(hubctl.check_setup(d, env), [])
        # Without a token the tunnel stays off, so a short password is fine.
        self.assertEqual(hubctl.check_setup(d, {"HUB_PASSWORD": "short-password"}), [])


if __name__ == "__main__":
    unittest.main()

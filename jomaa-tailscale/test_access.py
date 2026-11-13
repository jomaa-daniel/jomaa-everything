"""Exit-node access sync against a fake provider, isolated databases and lock files."""
from __future__ import annotations

import copy
import fcntl
import json
import re
import sqlite3
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest import mock

import access
import setup_server as server
import tailnet
from fake_tailnet import FakeTailnet

HERE = Path(__file__).parent
TEMPLATE = tailnet.template()
SECRET = "tskey-api-SENTINEL-do-not-print"


def user(uid: str, login: str, role: str = "member", kind: str = "member") -> dict:
    return {"id": uid, "loginName": login, "displayName": login.split("@")[0].title(), "type": kind,
            "role": role, "status": "active", "lastSeen": "2026-11-13T10:00:00Z"}


USERS = [user("u1", "alice@example.com"), user("u2", "bob@example.com"), user("u3", "owner@example.com", "owner"),
         user("u9", "shared@example.com", kind="shared")]


class Base(unittest.TestCase):
    """A hub database written the way the hub writes it, and a fake provider."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.path = self.tmp / "accounts.sqlite"
        self.db = sqlite3.connect(self.path, isolation_level=None)
        self.addCleanup(self.db.close)
        self.db.executescript((HERE / "access.sql").read_text())
        self.db.execute("UPDATE tailscale_sync SET enabled_at=1")
        self.lock = self.tmp / "deploy" / "tailnet.lock"
        self.provider = FakeTailnet({"users": copy.deepcopy(USERS), "devices": [],
                                     "policy": access.render(TEMPLATE, ["old@example.com"])})

    def link(self, username: str, uid: str, login: str, has_access: bool = True) -> None:
        self.db.execute("INSERT INTO tailscale_links VALUES (?, ?, ?, ?, ?, 1)",
                        (username, uid, login, login, int(has_access)))

    def set_access(self, username: str, has_access: bool) -> None:
        self.db.execute("UPDATE tailscale_links SET access=? WHERE username=?", (int(has_access), username))

    def sync(self, timeout: float = 1) -> dict:
        return access.sync(self.path, self.provider, TEMPLATE, self.lock, timeout, 0.01, 1)

    def family(self) -> list[str]:
        return self.provider.state["policy"]["groups"]["group:family"]

    def state(self) -> tuple:
        return self.db.execute("SELECT error, family FROM tailscale_sync").fetchone()


class SyncTest(Base):
    def test_the_family_group_is_exactly_the_linked_accounts_with_access(self):
        self.link("alice", "u1", "alice@example.com")
        self.link("bob", "u2", "bob@example.com")
        self.link("carol", "u3", "owner@example.com", has_access=False)
        self.assertEqual(self.sync()["status"], access.APPLIED)
        self.assertEqual(self.family(), ["alice@example.com", "bob@example.com"])
        self.assertEqual(self.state(), (None, json.dumps(["alice@example.com", "bob@example.com"])))

    def test_family_reaches_only_the_internet_and_the_rest_of_the_template_is_kept(self):
        self.link("alice", "u1", "alice@example.com")
        self.sync()
        policy = self.provider.state["policy"]
        self.assertEqual([g for g in policy["grants"] if "group:family" in g["src"]],
                         [{"src": ["group:family"], "dst": ["autogroup:internet"], "ip": ["*"]}])
        self.assertIn({"src": ["autogroup:admin"], "dst": ["*"], "ip": ["*"]}, policy["grants"])
        self.assertEqual(policy["tagOwners"], {server.TAG: ["autogroup:admin"]})
        self.assertEqual(policy["autoApprovers"], {"routes": {server.LAN: [server.TAG]}, "exitNode": [server.TAG]})
        denied = [d for t in policy["tests"] if t["src"] == "group:family" for d in t["deny"]]
        self.assertEqual(denied, [f"{server.CONFIG['router']}:80", f"{server.TAG}:22"])

    def test_an_empty_family_has_no_tests_and_no_placeholders_remain(self):
        self.sync()
        self.assertEqual(self.family(), [])
        self.assertEqual(self.provider.state["policy"]["tests"], [])
        self.assertIsNone(re.search(r"\{[a-z]+\}", json.dumps(access.render(TEMPLATE, ["a@example.com"]))))

    def test_removing_access_or_the_link_removes_them(self):
        self.link("alice", "u1", "alice@example.com")
        self.link("bob", "u2", "bob@example.com")
        self.sync()
        self.set_access("alice", False)
        self.db.execute("DELETE FROM tailscale_links WHERE username='bob'")
        self.assertEqual(self.sync()["status"], access.APPLIED)
        self.assertEqual(self.family(), [])

    def test_an_unchanged_policy_is_not_rewritten(self):
        self.link("alice", "u1", "alice@example.com")
        self.sync()
        for _ in range(3):
            self.assertEqual(self.sync()["status"], access.CURRENT)
        self.assertEqual(len(self.provider.state["writes"]), 1)

    def test_nothing_is_written_while_managed_access_is_off(self):
        self.db.execute("UPDATE tailscale_sync SET enabled_at=NULL")
        self.link("alice", "u1", "alice@example.com")
        self.assertEqual(self.sync()["status"], access.OFF)
        self.assertEqual(self.provider.state["writes"], [])
        self.assertEqual(self.provider.state["reads"], 0)
        self.assertEqual(self.family(), ["old@example.com"])

    def test_a_refused_policy_changes_nothing_and_is_reported(self):
        self.link("alice", "u1", "alice@example.com")
        self.provider.state["faults"] = {"policyWrite": ["reject"]}
        outcome = self.sync()
        self.assertEqual(outcome["status"], access.FAILED)
        self.assertIn("HTTP 400", outcome["message"])
        self.assertEqual(self.family(), ["old@example.com"])
        self.assertEqual(self.state()[0], outcome["message"])
        self.assertIsNone(self.state()[1])

    def test_a_lost_write_response_is_settled_by_reading_back(self):
        self.link("alice", "u1", "alice@example.com")
        self.provider.state["faults"] = {"policyWrite": ["lose-response"]}
        self.assertEqual(self.sync()["status"], access.APPLIED)
        self.assertEqual(len(self.provider.state["writes"]), 1)

    def test_the_next_sync_fixes_what_an_outage_left(self):
        self.link("alice", "u1", "alice@example.com")
        self.sync()
        self.set_access("alice", False)
        self.provider.state["faults"] = {"policyRead": ["unreachable"]}
        self.assertEqual(self.sync()["status"], access.FAILED)
        self.assertEqual(self.family(), ["alice@example.com"])
        self.assertEqual(self.sync()["status"], access.APPLIED)
        self.assertEqual(self.family(), [])
        self.assertIsNone(self.state()[0])

    def test_provider_failures_are_never_read_as_empty(self):
        self.link("alice", "u1", "alice@example.com")
        self.sync()
        for operation, fault, phrase in [("policyRead", "unauthorized", "HTTP 401"),
                                         ("policyRead", "malformed", "without groups"),
                                         ("users", "malformed", "malformed users"),
                                         ("users", "unreachable", "unreachable")]:
            with self.subTest(operation=operation, fault=fault):
                self.provider.state["faults"] = {operation: [fault]}
                outcome = self.sync()
                self.assertEqual(outcome["status"], access.FAILED)
                self.assertIn(phrase, outcome["message"])
                self.assertEqual(self.family(), ["alice@example.com"])
        self.assertEqual(len(self.provider.state["writes"]), 1)

    def test_a_changed_login_is_followed_by_stable_id(self):
        self.link("alice", "u1", "alice@example.com")
        self.sync()
        self.provider.state["users"][0]["loginName"] = "alice@new.example.com"
        self.assertEqual(self.sync()["status"], access.APPLIED)
        self.assertEqual(self.family(), ["alice@new.example.com"])
        self.assertEqual(self.db.execute("SELECT login FROM tailscale_links").fetchone()[0], "alice@new.example.com")

    def test_a_missing_or_shared_user_is_left_out_and_named(self):
        self.link("alice", "u1", "alice@example.com")
        self.link("sam", "u9", "shared@example.com")
        self.provider.state["users"] = [u for u in USERS if u["id"] != "u1"]
        outcome = self.sync()
        self.assertEqual(outcome["status"], access.APPLIED)
        self.assertIn("no user for alice, sam", outcome["message"])
        self.assertEqual(self.family(), [])
        self.assertIn("alice, sam", self.state()[0])


class LockTest(Base):
    def hold(self) -> subprocess.Popen:
        self.lock.parent.mkdir(parents=True, exist_ok=True)
        code = (f"import fcntl,time\nf=open({str(self.lock)!r},'a')\nfcntl.flock(f,fcntl.LOCK_EX)\n"
                "print('held',flush=True)\ntime.sleep(60)\n")
        holder = subprocess.Popen([sys.executable, "-c", code], stdout=subprocess.PIPE, text=True)
        self.assertEqual(holder.stdout.readline().strip(), "held")
        self.addCleanup(holder.stdout.close)
        self.addCleanup(holder.wait)
        self.addCleanup(holder.kill)
        return holder

    def test_a_sync_waits_for_another_process_and_its_death_releases_the_lock(self):
        self.link("alice", "u1", "alice@example.com")
        holder = self.hold()
        outcome = self.sync(timeout=0.2)
        self.assertEqual(outcome["status"], access.FAILED)
        self.assertIn("Another sync", outcome["message"])
        self.assertEqual(self.provider.state["reads"], 0)
        holder.kill()
        holder.wait()
        self.assertEqual(self.sync()["status"], access.APPLIED)

    def test_the_lock_is_released_when_a_sync_fails(self):
        self.provider.state["faults"] = {"users": ["unreachable"]}
        self.sync()
        with self.lock.open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)


class DeployTest(Base):
    STATUS = {"BackendState": "Running", "Self": {"Tags": [server.TAG]}}
    PREFS = {"Hostname": server.HOSTNAME, "AdvertiseRoutes": [server.LAN, "0.0.0.0/0", "::/0"]}

    def deploy(self, env: dict) -> None:
        with mock.patch.object(tailnet, "local_status", return_value=(self.STATUS, self.PREFS)), \
                mock.patch.object(tailnet, "host_problems", return_value=[]), \
                mock.patch.object(tailnet, "load_env", return_value=env), \
                mock.patch.object(tailnet, "hub_database", return_value=self.path), \
                mock.patch.object(tailnet, "api", return_value=self.provider), \
                mock.patch.object(tailnet.deploy_settings, "deploy_dir", return_value=self.lock.parent), \
                mock.patch("sys.stdout"):
            tailnet.deploy()

    def test_deployment_syncs_the_same_way(self):
        self.link("alice", "u1", "alice@example.com")
        self.deploy({"TAILSCALE_API_KEY": "tskey-api-x"})
        self.assertEqual(self.family(), ["alice@example.com"])

    def test_an_obsolete_family_setting_stops_deployment_before_the_policy(self):
        with self.assertRaisesRegex(tailnet.TailnetError, "TAILSCALE_FAMILY"):
            self.deploy({"TAILSCALE_API_KEY": "tskey-api-x", "TAILSCALE_FAMILY": "alice@example.com"})
        self.assertEqual(self.provider.state["reads"], 0)

    def test_a_failed_sync_fails_deployment_and_off_does_not(self):
        self.provider.state["faults"] = {"policyWrite": ["reject"]}
        self.link("alice", "u1", "alice@example.com")
        with self.assertRaisesRegex(tailnet.TailnetError, "HTTP 400"):
            self.deploy({"TAILSCALE_API_KEY": "tskey-api-x"})
        self.db.execute("UPDATE tailscale_sync SET enabled_at=NULL")
        self.deploy({"TAILSCALE_API_KEY": "tskey-api-x"})
        self.assertEqual(self.family(), ["old@example.com"])

    def test_missing_root_setup_is_reported_and_nothing_runs_as_root(self):
        with mock.patch.object(tailnet, "local_status", return_value=({}, {})), \
                mock.patch.object(tailnet, "read_file", return_value=None), \
                mock.patch.object(subprocess, "run") as run:
            with self.assertRaisesRegex(tailnet.TailnetError, "setup_server.py on jerry with sudo"):
                tailnet.deploy()
            run.assert_not_called()

    def test_the_hub_database_is_read_from_the_hub_settings(self):
        with mock.patch.object(tailnet, "load_env", return_value={"HEALTH_DB_PATH": "data/health.sqlite"}):
            settings = json.loads((tailnet.HUB / "settings.json").read_text())
            self.assertEqual(tailnet.hub_database(), tailnet.HUB / "data" / settings["accounts"]["databaseFile"])
        with mock.patch.object(tailnet, "load_env", return_value={}):
            with self.assertRaisesRegex(tailnet.TailnetError, "HEALTH_DB_PATH"):
                tailnet.hub_database()


class ObserveTest(unittest.TestCase):
    def test_devices_server_routes_and_problems_stay_separate(self):
        devices = [
            {"id": "d1", "name": "alice-phone", "hostname": "alice-phone", "user": "alice@example.com", "os": "iOS",
             "tags": [], "lastSeen": "2026-11-13T10:00:00Z", "connectedToControl": True},
            {"id": "d2", "name": "jerry", "hostname": server.HOSTNAME, "user": "owner@example.com", "os": "linux",
             "tags": [server.TAG], "advertisedRoutes": [server.LAN, "0.0.0.0/0", "::/0"],
             "enabledRoutes": [server.LAN]},
        ]
        fake = FakeTailnet({"users": USERS, "devices": devices, "policy": access.render(TEMPLATE, []),
                            "status": {"BackendState": "Running", "Self": {"Online": True, "Tags": [server.TAG]},
                                       "CurrentTailnet": {"Name": "example.com"}},
                            "prefs": {"AdvertiseRoutes": [server.LAN, "0.0.0.0/0", "::/0"]}})
        seen = tailnet.observe(fake, fake.local)
        server_status = seen["server"]["value"]
        self.assertEqual(server_status["advertisedRoutes"], sorted([server.LAN, "0.0.0.0/0", "::/0"]))
        self.assertEqual(server_status["approvedRoutes"], [server.LAN])
        self.assertTrue(server_status["online"])
        self.assertEqual(server_status["tailnet"], "example.com")
        self.assertTrue(server_status["problems"])
        phone = seen["devices"]["value"][0]
        self.assertIsNone(phone["expires"])
        self.assertTrue(phone["connectedToControl"])
        self.assertEqual(seen["policy"]["value"]["family"], [])

    def test_each_section_fails_on_its_own(self):
        fake = FakeTailnet({"users": USERS, "devices": [], "policy": {}, "status": {}, "prefs": {},
                            "faults": {"devices": ["malformed"], "local": ["unreachable"]}})
        seen = tailnet.observe(fake, fake.local)
        self.assertTrue(seen["users"]["ok"])
        self.assertFalse(seen["devices"]["ok"])
        self.assertFalse(seen["policy"]["ok"])
        self.assertIn("not installed", seen["server"]["error"])


class Provider(BaseHTTPRequestHandler):
    replies: list[tuple[int, bytes]] = []
    seen: list[dict] = []

    def do_GET(self):
        self.reply()

    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length", "0")))
        self.reply()

    def reply(self):
        Provider.seen.append({"path": self.path, "authorization": self.headers.get("Authorization")})
        status, body = Provider.replies.pop(0)
        self.send_response(status)
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


class ClientTest(unittest.TestCase):
    def setUp(self):
        self.http = HTTPServer(("127.0.0.1", 0), Provider)
        threading.Thread(target=self.http.serve_forever, daemon=True).start()
        self.addCleanup(self.http.server_close)
        self.addCleanup(self.http.shutdown)
        self.client = tailnet.Tailscale(SECRET, f"http://127.0.0.1:{self.http.server_port}")
        Provider.seen = []

    def test_errors_are_classified_and_never_echo_the_token(self):
        Provider.replies = [(401, json.dumps({"message": f"bad token {SECRET}"}).encode()),
                            (400, json.dumps({"message": f"policy invalid {SECRET}"}).encode()),
                            (503, b"down"), (200, b"not json"), (200, b'{"users": [{"id": 1}]}')]
        for expected, call in [(access.Rejected, self.client.policy), (access.Rejected, lambda: self.client.set_policy({})),
                               (access.Uncertain, self.client.policy), (access.Uncertain, self.client.policy),
                               (access.Uncertain, self.client.users)]:
            with self.assertRaises(expected) as caught:
                call()
            self.assertNotIn("SENTINEL", str(caught.exception))
        self.assertEqual(Provider.seen[0]["authorization"], f"Bearer {SECRET}")

    def test_the_cli_prints_sanitized_json_and_no_token(self):
        Provider.replies = [(500, json.dumps({"message": f"oops {SECRET}"}).encode())] * 3
        with mock.patch.object(tailnet, "api", return_value=self.client), \
                mock.patch.object(tailnet, "local_status", side_effect=tailnet.TailnetError("no daemon")), \
                mock.patch("sys.stdout") as stdout:
            tailnet.main(["observe"])
        printed = "".join(call.args[0] for call in stdout.write.call_args_list)
        self.assertNotIn("SENTINEL", printed)
        self.assertIn("[redacted]", printed)


class ConfigTest(unittest.TestCase):
    def test_lock_and_timeout_settings_are_positive(self):
        for key in ("lockTimeoutSeconds", "lockPollSeconds", "databaseTimeoutSeconds"):
            self.assertGreater(tailnet.CONFIG[key], 0, key)
        self.assertLess(tailnet.CONFIG["lockPollSeconds"], tailnet.CONFIG["lockTimeoutSeconds"])


if __name__ == "__main__":
    unittest.main()

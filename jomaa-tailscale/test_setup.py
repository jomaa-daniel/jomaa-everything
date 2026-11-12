"""Check jerry's Tailscale setup and the tailnet policy without changing the machine."""

import json
import unittest
from pathlib import Path

import setup_server as server

POLICY = json.loads((Path(__file__).parent / "policy.json").read_text())


class ServerTest(unittest.TestCase):
    def test_up_advertises_lan_and_exit_node_under_the_tag(self):
        args = server.up_args(Path("/home/jerry/key"))
        for arg in ("--reset", f"--advertise-routes={server.LAN}", f"--advertise-tags={server.TAG}",
                    "--advertise-exit-node", "--force-reauth", "--auth-key=file:/home/jerry/key"):
            self.assertIn(arg, args)
        self.assertFalse(any(a.startswith(("--auth-key", "--force-reauth")) for a in server.up_args(None)))

    def test_ipv4_and_ipv6_forwarding_are_enabled(self):
        self.assertEqual(server.SYSCTL_TEXT, "net.ipv4.ip_forward = 1\nnet.ipv6.conf.all.forwarding = 1\n")

    def test_apt_source_is_signed(self):
        line = server.apt_source("resolute")
        self.assertEqual(line, f"deb [signed-by={server.KEYRING}] {server.REPO} resolute main\n")

    def test_os_release_parses_quoted_values(self):
        self.assertEqual(server.os_release('ID=ubuntu\nVERSION_CODENAME="resolute"\n'),
                         {"ID": "ubuntu", "VERSION_CODENAME": "resolute"})


class PolicyTest(unittest.TestCase):
    def test_jerry_routes_and_exit_node_are_auto_approved(self):
        self.assertEqual(POLICY["autoApprovers"]["routes"], {server.LAN: [server.TAG]})
        self.assertEqual(POLICY["autoApprovers"]["exitNode"], [server.TAG])
        self.assertIn(server.TAG, POLICY["tagOwners"])

    def test_family_reaches_only_the_internet(self):
        family = [g for g in POLICY["grants"] if "group:family" in g["src"]]
        self.assertEqual(family, [{"src": ["group:family"], "dst": ["autogroup:internet"], "ip": ["*"]}])

    def test_family_is_denied_the_lan_and_jerry(self):
        denied = [d for t in POLICY["tests"] if t["src"] == "group:family" for d in t["deny"]]
        self.assertIn("192.168.1.1:80", denied)
        self.assertIn(f"{server.TAG}:22", denied)

    def test_family_members_come_from_terraform(self):
        self.assertEqual(POLICY["groups"], {"group:family": []})


if __name__ == "__main__":
    unittest.main()

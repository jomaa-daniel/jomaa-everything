"""Check jerry's Tailscale setup, deployment and tailnet policy without changing the machine."""

import json
import re
import unittest
from pathlib import Path

import setup_server as server
import tailnet

HERE = Path(__file__).parent
POLICY = json.loads((HERE / "policy.json").read_text())
RENDERED = tailnet.render_policy(POLICY, server.CONFIG, ["a@example.com"])
JOINED = {"BackendState": "Running", "Self": {"Tags": [server.TAG]}}
PREFS = {"Hostname": server.HOSTNAME, "AdvertiseRoutes": [server.LAN, "0.0.0.0/0", "::/0"],
         "OperatorUser": "jerry", "AutoUpdate": {"Check": True, "Apply": True}}
FILES = {server.SYSCTL: server.SYSCTL_TEXT, server.DISPATCHER: server.dispatcher_script()}


class ServerTest(unittest.TestCase):
    def test_join_uses_the_key_file_and_tag(self):
        args = server.join_args(Path("/tmp/key"))
        for arg in ("--reset", "--force-reauth", "--auth-key=file:/tmp/key", f"--advertise-tags={server.TAG}",
                    f"--advertise-routes={server.LAN}", "--advertise-exit-node"):
            self.assertIn(arg, args)

    def test_set_makes_the_user_operator_and_turns_on_auto_updates(self):
        self.assertEqual(server.set_args("jerry")[:3], ["sudo", "tailscale", "set"])
        self.assertIn("--operator=jerry", server.set_args("jerry"))
        self.assertIn("--auto-update", server.set_args("jerry"))

    def test_joined_requires_running_with_the_tag(self):
        self.assertTrue(server.joined(JOINED))
        self.assertFalse(server.joined({"BackendState": "Running", "Self": {"Tags": []}}))
        self.assertFalse(server.joined({"BackendState": "NeedsLogin", "Self": None}))

    def test_ipv4_and_ipv6_forwarding_are_enabled(self):
        self.assertEqual(server.SYSCTL_TEXT, "net.ipv4.ip_forward = 1\nnet.ipv6.conf.all.forwarding = 1\n")

    def test_gro_dispatcher_runs_on_physical_interfaces_coming_up(self):
        script = server.dispatcher_script()
        self.assertTrue(script.startswith("#!/bin/sh\n"))
        self.assertIn('[ "$2" = up ] || exit 0', script)
        self.assertIn("lo|tailscale*|docker*", script)
        self.assertIn(f'{server.ETHTOOL} -K "$1" rx-udp-gro-forwarding on rx-gro-list off', script)

    def test_default_device_comes_from_the_route(self):
        route = "1.1.1.1 via 192.168.1.1 dev enp2s0 src 192.168.1.239 uid 1000\n"
        self.assertEqual(server.default_device(route), "enp2s0")

    def test_apt_source_is_signed(self):
        line = server.apt_source("resolute")
        repository = server.CONFIG["apt"]["repository"]
        self.assertEqual(line, f"deb [signed-by={server.KEYRING}] {repository} resolute main\n")

    def test_os_release_parses_quoted_values(self):
        self.assertEqual(server.os_release('ID=ubuntu\nVERSION_CODENAME="resolute"\n'),
                         {"ID": "ubuntu", "VERSION_CODENAME": "resolute"})


class DeployTest(unittest.TestCase):
    def test_current_host_has_no_problems(self):
        self.assertEqual(tailnet.host_problems(FILES.get, PREFS, JOINED, "jerry"), [])

    def test_outdated_root_setup_is_reported(self):
        problems = tailnet.host_problems({}.get, {**PREFS, "OperatorUser": "", "AutoUpdate": {"Apply": None}},
                                         {"BackendState": "Running", "Self": {"Tags": []}}, "jerry")
        self.assertEqual(len(problems), 5)

    def test_node_settings_compare_hostname_and_routes(self):
        self.assertTrue(tailnet.node_current(PREFS))
        self.assertFalse(tailnet.node_current({**PREFS, "Hostname": "jerry-server"}))
        self.assertFalse(tailnet.node_current({**PREFS, "AdvertiseRoutes": [server.LAN]}))

    def test_family_comes_from_a_comma_separated_list(self):
        self.assertEqual(tailnet.family({"TAILSCALE_FAMILY": " a@example.com, ,b@example.com "}),
                         ["a@example.com", "b@example.com"])
        self.assertEqual(tailnet.family({}), [])

    def test_policy_fills_family_and_keeps_tests_only_with_members(self):
        empty = tailnet.render_policy(POLICY, server.CONFIG, [])
        self.assertEqual(empty["groups"]["group:family"], [])
        self.assertEqual(empty["tests"], [])
        self.assertEqual(RENDERED["groups"]["group:family"], ["a@example.com"])
        self.assertEqual(len(RENDERED["tests"]), len(POLICY["tests"]))
        self.assertEqual(POLICY["groups"]["group:family"], [])

    def test_placeholders_are_filled_in_keys_and_values(self):
        config = {"lan": "10.0.0.0/24", "tag": "tag:box", "router": "10.0.0.1"}
        self.assertEqual(tailnet.fill({"{lan}": ["{tag}", "{router}:80"]}, config),
                         {"10.0.0.0/24": ["tag:box", "10.0.0.1:80"]})
        self.assertIsNone(re.search(r"\{[a-z]+\}", json.dumps(RENDERED)))

    def test_only_access_tokens_are_accepted(self):
        with self.assertRaises(tailnet.TailnetError):
            tailnet.Tailscale("tskey-auth-abc-def")
        tailnet.Tailscale("tskey-api-abc-def")


class PolicyTest(unittest.TestCase):
    def test_jerry_routes_and_exit_node_are_auto_approved(self):
        self.assertEqual(RENDERED["autoApprovers"]["routes"], {server.LAN: [server.TAG]})
        self.assertEqual(RENDERED["autoApprovers"]["exitNode"], [server.TAG])
        self.assertIn(server.TAG, RENDERED["tagOwners"])

    def test_family_reaches_only_the_internet(self):
        family = [g for g in RENDERED["grants"] if "group:family" in g["src"]]
        self.assertEqual(family, [{"src": ["group:family"], "dst": ["autogroup:internet"], "ip": ["*"]}])

    def test_family_is_denied_the_router_and_jerry(self):
        denied = [d for t in RENDERED["tests"] if t["src"] == "group:family" for d in t["deny"]]
        self.assertIn(f"{server.CONFIG['router']}:80", denied)
        self.assertIn(f"{server.TAG}:22", denied)


class ConfigDocTest(unittest.TestCase):
    def test_config_md_documents_every_setting(self):
        doc = (HERE / "config.md").read_text()

        def keys(value, prefix=""):
            for key, item in value.items():
                yield prefix + key
                if isinstance(item, dict):
                    yield from keys(item, prefix + key + ".")

        documented = [*keys(server.CONFIG), *POLICY, *(f"{{{name}}}" for name in tailnet.PLACEHOLDERS),
                      *(line.split("=", 1)[0] for line in (HERE / ".env.example").read_text().splitlines())]
        for key in documented:
            self.assertIn(f"`{key}`", doc, f"config.md does not document {key}")


if __name__ == "__main__":
    unittest.main()

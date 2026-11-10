"""Checks the tunnel rule and the client's ssh config edits without touching the machine."""

import tempfile
import unittest
from pathlib import Path

import setup_client as client
import setup_server as server

TUNNEL = ('tunnel: "4b03940e-11ab-48c6-b288-4c9deb2cc905"\ningress:\n'
          '  - hostname: "hub.example.org"\n    service: http://127.0.0.1:8080\n  - service: http_status:404\n')


def fake_resolve(config: Path) -> str:
    """Like cloudflared: the first rule naming ssh.example.org, else the catch-all."""
    text = config.read_text()
    at = text.find('hostname: "ssh.example.org"')
    return text[at:].split("service: ", 1)[1].split("\n", 1)[0] if at != -1 else "http_status:404"


class ServerTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.config = Path(temp.name) / "tunnel.yml"

    def test_rule_is_added_first_once(self):
        self.config.write_text(TUNNEL)
        self.assertTrue(server.add_tunnel_rule(self.config, "ssh.example.org", fake_resolve))
        updated = self.config.read_text()
        self.assertLess(updated.index("ssh://127.0.0.1:2222"), updated.index("hub.example.org"))
        self.assertFalse(server.add_tunnel_rule(self.config, "ssh.example.org", fake_resolve))
        self.assertEqual(self.config.read_text(), updated)
        self.assertEqual(server.tunnel_id(self.config), "4b03940e-11ab-48c6-b288-4c9deb2cc905")

    def test_changed_rule_is_left_for_review(self):
        self.config.write_text(TUNNEL.replace("ingress:\n", 'ingress:\n  # jomaa-ssh\n  - hostname: "ssh.example.org"\n'
                                              "    service: ssh://127.0.0.1:22\n"))
        before = self.config.read_text()
        with self.assertRaisesRegex(server.SetupError, "review it by hand"):
            server.add_tunnel_rule(self.config, "ssh.example.org", fake_resolve)
        self.assertEqual(self.config.read_text(), before)
        self.assertEqual([p.name for p in self.config.parent.iterdir()], ["tunnel.yml"])

    def test_sshd_config_allows_keys_only(self):
        text = server.sshd_config(Path("/home/jerry/.local/share/jomaa-ssh"), "jerry")
        for line in ("ListenAddress 127.0.0.1", "PasswordAuthentication no", "KbdInteractiveAuthentication no",
                     "AllowUsers jerry", "PermitRootLogin no"):
            self.assertIn(line + "\n", text)


class ClientTest(unittest.TestCase):
    def test_block_is_added_at_the_top_and_replaced(self):
        block = client.host_block("jerry", "ssh.example.org", "jerry", "/opt/bin/cloudflared")
        config = client.with_block("Host *\n  AddKeysToAgent yes\n", block)
        self.assertTrue(config.startswith(client.BEGIN))
        self.assertIn("ProxyCommand /opt/bin/cloudflared access ssh --hostname %h", config)
        newer = client.host_block("jerry", "ssh.example.org", "jerry", "/usr/local/bin/cloudflared")
        replaced = client.with_block(config, newer)
        self.assertEqual(replaced, newer + "\nHost *\n  AddKeysToAgent yes\n")
        self.assertEqual(client.with_block("", block), block)

    def test_known_hosts_lines_are_added_once(self):
        self.assertEqual(client.missing_lines("a key\n", "a key\nb key\n\n"), ["b key"])


if __name__ == "__main__":
    unittest.main()

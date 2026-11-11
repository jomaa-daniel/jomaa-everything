"""Check keys-only SSH configuration and client setup without changing the machine."""

import tempfile
import unittest
from pathlib import Path

import setup_client as client
import setup_server as server

class ServerTest(unittest.TestCase):
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

import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

import serve
import setup_server


class ServeTest(unittest.TestCase):
    def setUp(self):
        self.server = serve.make_server(serve.ROOT, 0)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def get(self, host: str, path: str) -> tuple[int, bytes, dict[str, str]]:
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", headers={"Host": host})
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return r.status, r.read(), dict(r.headers)
        except urllib.error.HTTPError as e:
            return e.code, b"", dict(e.headers)

    def test_every_site_serves_its_index_with_security_headers(self):
        for host, folder in serve.load_sites(serve.ROOT).items():
            status, body, headers = self.get(host, "/")
            self.assertEqual(status, 200, host)
            self.assertEqual(body, (folder / "index.html").read_bytes())
            self.assertIn("frame-ancestors 'none'", headers["Content-Security-Policy"])
            self.assertEqual(headers["X-Content-Type-Options"], "nosniff")

    def test_unknown_host_hidden_files_listings_and_escapes_are_404(self):
        host = next(iter(serve.load_sites(serve.ROOT)))
        for h, path in [("evil.example", "/"), (host, "/.git/config"), (host, "/images/"),
                        (host, "/../serve.py"), (host, "/%2e%2e/serve.py"), (host, "/missing.png")]:
            self.assertEqual(self.get(h, path)[0], 404, (h, path))

    def test_sarah_portfolio_references_only_files_that_exist(self):
        site = serve.ROOT / "sarah-portfolio"
        data = (site / "artworks.js").read_text()
        files = [line.split('file: "', 1)[1].split('"', 1)[0] for line in data.splitlines() if 'file: "' in line]
        self.assertGreater(len(files), 0)
        for name in files:
            self.assertTrue((site / "images" / name).is_file(), name)
            self.assertEqual(self.get("sarah.jomaa.org", f"/images/{name}")[0], 200, name)


class TunnelRuleTest(unittest.TestCase):
    def test_rule_is_added_first_once(self):
        with tempfile.TemporaryDirectory() as d:
            config = Path(d) / "tunnel.yml"
            config.write_text('tunnel: x\ningress:\n  - hostname: "hub.jomaa.org"\n    service: http://127.0.0.1:8080\n'
                              "  - service: http_status:404\n")

            def resolve(path: Path, hostname: str) -> str:
                rules = path.read_text().split("ingress:\n", 1)[1]
                for block in rules.split("  - ")[1:]:
                    if f'hostname: "{hostname}"' in block or "hostname" not in block:
                        return block.split("service: ", 1)[1].split()[0]
                return ""

            self.assertTrue(setup_server.add_tunnel_rule(config, "sarah.jomaa.org", resolve))
            self.assertFalse(setup_server.add_tunnel_rule(config, "sarah.jomaa.org", resolve))
            text = config.read_text()
            self.assertLess(text.index("sarah.jomaa.org"), text.index("hub.jomaa.org"))
            self.assertEqual(text.count("sarah.jomaa.org"), 2)  # marker and rule


if __name__ == "__main__":
    unittest.main()

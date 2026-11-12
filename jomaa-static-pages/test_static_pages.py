import json
import os
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

import serve

# The hostname directories of this folder, as the deployment maps them.
SITES = {p.name: p for p in sorted(serve.ROOT.iterdir())
         if p.is_dir() and "." in p.name and not p.name.startswith(".")}


class ServeTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.site_map = Path(self.temp.name) / "sites.json"
        self.site_map.write_text(json.dumps({host: str(folder) for host, folder in SITES.items()}))
        self.server = serve.make_server(self.site_map, 0)
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
            with e:
                return e.code, b"", dict(e.headers)

    def test_every_site_serves_its_index_with_security_headers(self):
        for host, folder in SITES.items():
            status, body, headers = self.get(host, "/")
            self.assertEqual(status, 200, host)
            self.assertEqual(body, (folder / "index.html").read_bytes())
            self.assertIn("frame-ancestors 'none'", headers["Content-Security-Policy"])
            self.assertEqual(headers["X-Content-Type-Options"], "nosniff")

    def test_health_does_not_depend_on_a_site_hostname(self):
        status, body, headers = self.get("127.0.0.1", "/healthz")
        self.assertEqual(status, 200)
        self.assertEqual(body, b'{"ok":true}')
        self.assertEqual(headers["Content-Type"], "application/json")

    def test_a_rewritten_site_map_is_served_without_a_restart(self):
        site = Path(self.temp.name) / "new.example.org"
        page = site / "gallery"
        page.mkdir(parents=True)
        (site / "index.html").write_text("new site")
        (page / "index.html").write_text("new gallery")
        self.assertEqual(self.get("new.example.org", "/")[0], 404)
        replacement = self.site_map.with_name("sites.new")
        replacement.write_text(json.dumps({"new.example.org": str(site)}))
        os.replace(replacement, self.site_map)
        for path, expected in (("/", b"new site"), ("/gallery/", b"new gallery")):
            self.assertEqual(self.get("new.example.org", path)[:2], (200, expected))
        self.assertEqual(self.get(next(iter(SITES)), "/")[0], 404)

    def test_a_missing_site_map_serves_no_sites(self):
        self.site_map.unlink()
        self.assertEqual(self.get(next(iter(SITES)), "/")[0], 404)
        self.assertEqual(self.get("127.0.0.1", "/healthz")[0], 200)

    def test_unknown_host_hidden_files_listings_and_escapes_are_404(self):
        host = next(iter(SITES))
        for h, path in [("evil.example", "/"), (host, "/.git/config"), (host, "/images/"),
                        (host, "/../serve.py"), (host, "/%2e%2e/serve.py"), (host, "/missing.png")]:
            self.assertEqual(self.get(h, path)[0], 404, (h, path))

    def test_device_panel_is_a_room_controller(self):
        panel = serve.ROOT / "device-panel"
        html = (panel / "index.html").read_text()
        script = (panel / "app.js").read_text()
        # Brightness is one continuous control with a visible readout, not presets.
        self.assertIn('id="brightness"', html)
        self.assertIn('id="brightness-value"', html)
        self.assertNotIn("data-brightness", html)
        self.assertIn("Mixed", script)
        # Four fixed colours plus two customs are visible without opening a dialog.
        self.assertEqual(html.count('class="swatch"'), 6)
        self.assertEqual(html.count('data-custom="custom-'), 2)
        # Device dots distinguish on from off, not just reachable from unreachable.
        self.assertIn('"on"', script)
        self.assertIn('"off"', script)

    def test_sarah_portfolio_references_only_files_that_exist(self):
        site = serve.ROOT / "sarah.jomaa.org"
        data = (site / "artworks.js").read_text()
        files = [line.split('file: "', 1)[1].split('"', 1)[0] for line in data.splitlines() if 'file: "' in line]
        self.assertGreater(len(files), 0)
        for name in files:
            self.assertTrue((site / "images" / name).is_file(), name)
            self.assertEqual(self.get("sarah.jomaa.org", f"/images/{name}")[0], 200, name)


if __name__ == "__main__":
    unittest.main()

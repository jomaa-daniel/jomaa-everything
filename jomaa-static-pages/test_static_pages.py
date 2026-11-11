import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

import serve


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
            with e:
                return e.code, b"", dict(e.headers)

    def test_every_site_serves_its_index_with_security_headers(self):
        for host, folder in serve.load_sites(serve.ROOT).items():
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

    def test_new_hostname_folder_and_nested_page_are_served_automatically(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "jomaa-static-pages"
            site = root / "new.example.org"
            page = site / "gallery"
            page.mkdir(parents=True)
            (site / "index.html").write_text("new site")
            (page / "index.html").write_text("new gallery")
            server = serve.make_server(root, 0)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                port = server.server_address[1]
                for path, expected in (("/", b"new site"), ("/gallery/", b"new gallery")):
                    request = urllib.request.Request(f"http://127.0.0.1:{port}{path}",
                                                     headers={"Host": "new.example.org"})
                    with urllib.request.urlopen(request, timeout=5) as response:
                        self.assertEqual(response.read(), expected)
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)

    def test_unknown_host_hidden_files_listings_and_escapes_are_404(self):
        host = next(iter(serve.load_sites(serve.ROOT)))
        for h, path in [("evil.example", "/"), (host, "/.git/config"), (host, "/images/"),
                        (host, "/../serve.py"), (host, "/%2e%2e/serve.py"), (host, "/missing.png")]:
            self.assertEqual(self.get(h, path)[0], 404, (h, path))

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

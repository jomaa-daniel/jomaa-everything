#!/usr/bin/env python3
"""Serve each static site in this folder at its own hostname, on loopback only.

Directories named with their full hostname are discovered automatically.
The Cloudflare tunnel keeps the original Host header, so one server answers
for every site. Site requests for other hosts and hidden files get 404.
"""
from __future__ import annotations

import argparse
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "jomaa-deploy"))
import manifest

ROOT = Path(__file__).resolve().parent
PORT = 8090
HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; "
    "frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    "Cache-Control": "public, max-age=300",
}


def load_sites(root: Path) -> dict[str, Path]:
    return {route["hostname"]: root.parent / route["site"]
            for route in manifest.discover_sites(root.parent)}


class Handler(SimpleHTTPRequestHandler):
    server_version = "jomaa-static"
    sys_version = ""

    def __init__(self, *args: object, sites: dict[str, Path], **kwargs: object) -> None:
        self.sites = sites
        super().__init__(*args, **kwargs)  # type: ignore[arg-type]

    def do_GET(self) -> None:
        if self.path == "/healthz":
            body = b'{"ok":true}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def send_head(self):  # type: ignore[no-untyped-def]
        host = (self.headers.get("Host") or "").split(":")[0].lower()
        site = self.sites.get(host)
        path = unquote(urlsplit(self.path).path)
        if (site is None or any(part.startswith(".") for part in path.split("/") if part)
                or not (site / path.lstrip("/")).resolve().is_relative_to(site.resolve())):
            self.send_error(404)
            return None
        self.directory = str(site)
        return super().send_head()

    def list_directory(self, path):  # type: ignore[no-untyped-def]
        self.send_error(404)
        return None

    def end_headers(self) -> None:
        for name, value in HEADERS.items():
            self.send_header(name, value)
        super().end_headers()


def make_server(root: Path, port: int) -> ThreadingHTTPServer:
    return ThreadingHTTPServer(("127.0.0.1", port), partial(Handler, sites=load_sites(root)))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=PORT)
    args = parser.parse_args()
    server = make_server(ROOT, args.port)
    print(f"serving {', '.join(load_sites(ROOT))} on 127.0.0.1:{args.port}", flush=True)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Serve each deployed static site at its own hostname, on loopback only.

The deployment writes a site map from hostname to directory and this server
re-reads it when it changes. The Cloudflare tunnel keeps the original Host
header, so one server answers for every site. Site requests for other hosts
and hidden files get 404.
"""
from __future__ import annotations

import argparse
import json
import sys
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "jomaa-deploy"))
import settings

ROOT = Path(__file__).resolve().parent
PORT = urlsplit(json.loads((ROOT / "deploy.json").read_text())["origin"]).port
HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; "
    "frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    "Cache-Control": "public, max-age=300",
}


class Sites:
    """The site map file, read again whenever it is replaced or modified."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.lock = threading.Lock()
        self.stamp: tuple[int, int, int] | None = None
        self.sites: dict[str, Path] = {}

    def get(self, host: str) -> Path | None:
        with self.lock:
            try:
                info = self.path.stat()
                stamp = (info.st_ino, info.st_mtime_ns, info.st_size)
            except FileNotFoundError:
                stamp = None
            if stamp != self.stamp:
                self.sites = ({h: Path(d) for h, d in json.loads(self.path.read_text()).items()}
                              if stamp is not None else {})
                self.stamp = stamp
            return self.sites.get(host)


class Handler(SimpleHTTPRequestHandler):
    server_version = "jomaa-static"
    sys_version = ""

    def __init__(self, *args: object, sites: Sites, **kwargs: object) -> None:
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


def make_server(site_map: Path, port: int) -> ThreadingHTTPServer:
    return ThreadingHTTPServer(("127.0.0.1", port), partial(Handler, sites=Sites(site_map)))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=PORT)
    parser.add_argument("--sites", type=Path, default=settings.site_map(settings.deploy_dir()),
                        help="site map written by the deployment")
    args = parser.parse_args()
    server = make_server(args.sites, args.port)
    print(f"serving the sites in {args.sites} on 127.0.0.1:{args.port}", flush=True)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())

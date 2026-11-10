#!/usr/bin/env python3
"""Serve each static site in this folder at its own hostname, on loopback only.

sites.json maps a hostname to a folder here. The Cloudflare tunnel keeps the
original Host header, so one server answers for every site. Requests for other
hosts, hidden files and folders without an index.html get 404.
"""
from __future__ import annotations

import argparse
import json
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

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
    raw: object = json.loads((root / "sites.json").read_text())
    if not isinstance(raw, dict):
        raise ValueError("sites.json must be an object of hostname -> folder")
    sites: dict[str, Path] = {}
    for host, folder in raw.items():
        if not isinstance(host, str) or not isinstance(folder, str) or "/" in folder or folder.startswith("."):
            raise ValueError(f"bad sites.json entry {host!r}: {folder!r}")
        path = root / folder
        if not (path / "index.html").is_file():
            raise ValueError(f"{path} has no index.html")
        sites[host.lower()] = path
    return sites


class Handler(SimpleHTTPRequestHandler):
    server_version = "jomaa-static"
    sys_version = ""

    def __init__(self, *args: object, sites: dict[str, Path], **kwargs: object) -> None:
        self.sites = sites
        super().__init__(*args, **kwargs)  # type: ignore[arg-type]

    def send_head(self):  # type: ignore[no-untyped-def]
        host = (self.headers.get("Host") or "").split(":")[0].lower()
        site = self.sites.get(host)
        path = self.path.split("?", 1)[0].split("#", 1)[0]
        if site is None or any(part.startswith(".") for part in path.split("/") if part):
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

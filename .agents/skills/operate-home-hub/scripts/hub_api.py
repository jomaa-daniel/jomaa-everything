#!/usr/bin/env python3
"""Call the home hub HTTPS API without printing the password or login token."""

import argparse
import getpass
import ipaddress
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

DEFAULT_URL = "https://hub.jomaa.org"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Don't send the password or bearer token to a redirect target.
        return None


def password_from_file(path: Path) -> str:
    content = path.read_text().strip()
    for line in content.splitlines():
        key, sep, value = line.partition("=")
        if sep and key.strip() == "HUB_PASSWORD":
            return value.strip().strip("'\"")
    if "\n" not in content and "=" not in content:
        return content
    raise ValueError("password file must contain HUB_PASSWORD=... or a single password")


def base_url(value: str) -> str:
    u = urllib.parse.urlsplit(value)
    if not u.hostname or u.username or u.password or u.path not in ("", "/") or u.query or u.fragment:
        raise ValueError("base URL must be an origin without credentials, path, query or fragment")
    loopback = u.hostname == "localhost"
    try:
        loopback = loopback or ipaddress.ip_address(u.hostname).is_loopback
    except ValueError:
        pass
    if u.scheme != "https" and not (u.scheme == "http" and loopback):
        raise ValueError("hub URL must use HTTPS, except for localhost")
    return value.rstrip("/")


def request(url: str, method: str, token: str | None = None, body=None, timeout: int = 30):
    headers = {"User-Agent": "jomaa-home-hub-agent/1.0", "Accept": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    opener = urllib.request.build_opener(NoRedirect())
    with opener.open(req, timeout=timeout) as response:
        return json.load(response)


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("method", choices=("GET", "POST", "DELETE"))
    p.add_argument("path", help="/healthz or an /api/ path")
    p.add_argument("--url", default=os.getenv("JOMAA_HUB_URL", DEFAULT_URL), help="HTTPS hub origin")
    p.add_argument("--password-file", type=Path, help="private file containing HUB_PASSWORD or a password")
    p.add_argument("--json-stdin", action="store_true", help="read JSON request body from stdin")
    args = p.parse_args()
    try:
        url = base_url(args.url)
        if args.path != "/healthz" and (not args.path.startswith("/api/") or args.path == "/api/login"):
            raise ValueError("path must be /healthz or an authenticated /api/ path")
        if "#" in args.path or "\r" in args.path or "\n" in args.path:
            raise ValueError("invalid path")
        body = json.load(sys.stdin) if args.json_stdin else None
        token = None
        if args.path != "/healthz":
            password = os.getenv("JOMAA_HUB_PASSWORD") or os.getenv("HUB_PASSWORD")
            if not password and args.password_file:
                password = password_from_file(args.password_file)
            if not password:
                if not sys.stdin.isatty():
                    raise ValueError("set JOMAA_HUB_PASSWORD or provide --password-file")
                password = getpass.getpass("Hub password: ")
            login = request(url + "/api/login", "POST", body={"password": password})
            token = login["token"]
        timeout = 360 if args.path == "/api/matter/commission" else 30
        result = request(url + args.path, args.method, token=token, body=body, timeout=timeout)
        print(json.dumps(result, indent=2))
        return 0
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")[:2000]
        print(f"HTTP {e.code}: {detail}", file=sys.stderr)
    except (ValueError, KeyError, OSError, urllib.error.URLError) as e:
        print(f"Hub request failed: {e}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())

"""Cloudflare v4 API client for tunnel and DNS resources."""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request

API = os.environ.get("CLOUDFLARE_API_BASE", "https://api.cloudflare.com/client/v4")


class CloudflareError(Exception):
    pass


class Cloudflare:
    """Minimal Cloudflare v4 API client: just the calls this script needs."""

    def __init__(self, token: str, base: str | None = None):
        if not token:
            raise CloudflareError("CLOUDFLARE_API_TOKEN is not set")
        self.token = token
        self.base = (base or API).rstrip("/")

    def call(self, method: str, path: str, body: dict | None = None, query: dict | None = None):
        url = self.base + path + ("?" + urllib.parse.urlencode(query) if query else "")
        req = urllib.request.Request(url, method=method, data=json.dumps(body).encode() if body is not None else None)
        req.add_header("Authorization", f"Bearer {self.token}")
        req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=30) as res:
                payload = json.loads(res.read() or b"{}")
        except urllib.error.HTTPError as e:
            try:
                payload = json.loads(e.read() or b"{}")
            except json.JSONDecodeError:
                raise CloudflareError(f"{method} {path}: HTTP {e.code}") from e
        except (urllib.error.URLError, OSError) as e:
            raise CloudflareError(f"can't reach the Cloudflare API: {e}") from e
        if not payload.get("success", False):
            messages = "; ".join(f"{x.get('code')}: {x.get('message')}" for x in payload.get("errors", [])) or "unknown error"
            raise CloudflareError(f"{method} {path}: {messages}")
        return payload.get("result")

    def find_zone(self, hostname: str) -> dict:
        labels = hostname.split(".")
        for i in range(len(labels) - 1):
            name = ".".join(labels[i:])
            zones = self.call("GET", "/zones", query={"name": name, "status": "active"})
            if zones:
                return zones[0]
        raise CloudflareError(
            f"no active Cloudflare zone covers {hostname}. Add the domain to Cloudflare, "
            "or give the API token Zone > Zone > Read on it"
        )

    def find_tunnel(self, account: str, name: str) -> dict | None:
        tunnels = self.call("GET", f"/accounts/{account}/cfd_tunnel", query={"name": name, "is_deleted": "false"})
        return tunnels[0] if tunnels else None

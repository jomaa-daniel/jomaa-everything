#!/usr/bin/env python3
"""Put the hub on the internet through a Cloudflare Tunnel.

    cloudflare.py deploy     create or update the tunnel, its routing rule and the DNS record
    cloudflare.py run        start cloudflared next to the hub (on the hub machine)
    cloudflare.py status     tunnel health, DNS record, and whether the public URL answers
    cloudflare.py destroy    stop cloudflared, delete the DNS record and the tunnel

Everything comes from environment variables, read from the hub's .env file
or the real environment (GitHub secrets in CI), the same way GOVEE_API_KEY is:

    CLOUDFLARE_HOSTNAME        the public address, like hub.yourdomain.com
    CLOUDFLARE_API_TOKEN       needs Account > Cloudflare Tunnel > Edit, Zone > DNS > Edit
                               and Zone > Zone > Read for the domain's zone
    CLOUDFLARE_ACCOUNT_ID      optional; taken from the domain's zone if unset
    CLOUDFLARE_TUNNEL_NAME     optional; default jomaa-home-hub
    CLOUDFLARE_TUNNEL_SERVICE  optional; where the hub listens, default http://localhost:8080

deploy is safe to run again: it reuses the tunnel and record it made before.
No ports are opened on your router; cloudflared connects out to Cloudflare.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "jomaa-deploy"))
from cloudflare_api import Cloudflare, CloudflareError

HUB_DIR = Path(__file__).resolve().parent.parent
API = os.environ.get("CLOUDFLARE_API_BASE", "https://api.cloudflare.com/client/v4")
HOSTNAME = re.compile(r"^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$")


@dataclass
class Settings:
    hostname: str
    tunnel: str = "jomaa-home-hub"
    service: str = "http://localhost:8080"

    @classmethod
    def from_env(cls, env: dict[str, str]) -> Settings:
        settings = cls(
            hostname=env.get("CLOUDFLARE_HOSTNAME", "").strip().lower().rstrip("."),
            tunnel=env.get("CLOUDFLARE_TUNNEL_NAME") or cls.tunnel,
            service=env.get("CLOUDFLARE_TUNNEL_SERVICE") or cls.service,
        )
        settings.validate()
        return settings

    @property
    def configured(self) -> bool:
        return bool(self.hostname)

    def validate(self) -> None:
        if self.hostname and not HOSTNAME.match(self.hostname):
            raise CloudflareError(f"CLOUDFLARE_HOSTNAME {self.hostname!r} is not a valid DNS name")
        if not re.match(r"^[A-Za-z0-9._-]{1,64}$", self.tunnel):
            raise CloudflareError(f"CLOUDFLARE_TUNNEL_NAME {self.tunnel!r} may only use letters, digits, '.', '_' and '-'")
        if not re.match(r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$", self.service):
            raise CloudflareError("CLOUDFLARE_TUNNEL_SERVICE must be http://localhost:<port> (the hub on this machine)")

    def require_configured(self) -> None:
        if not self.configured:
            raise CloudflareError("CLOUDFLARE_HOSTNAME is not set; set it to a name on your Cloudflare domain, like hub.yourdomain.com")


# --- Commands ------------------------------------------------------------------


def target_for(tunnel_id: str) -> str:
    return f"{tunnel_id}.cfargotunnel.com"


def deploy(cf: Cloudflare, settings: Settings, account: str | None = None, replace: bool = False) -> dict:
    """Create or update everything on Cloudflare's side. Returns a summary."""
    settings.require_configured()
    zone = cf.find_zone(settings.hostname)
    account = account or zone["account"]["id"]

    tunnel = cf.find_tunnel(account, settings.tunnel)
    created = tunnel is None
    if created:
        tunnel = cf.call("POST", f"/accounts/{account}/cfd_tunnel",
                         {"name": settings.tunnel, "config_src": "cloudflare"})
    elif not tunnel.get("remote_config", False):
        raise CloudflareError(
            f"tunnel {settings.tunnel!r} exists but is managed by a local config file; "
            "set CLOUDFLARE_TUNNEL_NAME to another name or delete the old tunnel"
        )
    tunnel_id = tunnel["id"]

    cf.call("PUT", f"/accounts/{account}/cfd_tunnel/{tunnel_id}/configurations", {"config": {"ingress": [
        {"hostname": settings.hostname, "service": settings.service, "originRequest": {}},
        {"service": "http_status:404"},
    ]}})

    dns = upsert_dns(cf, zone["id"], settings.hostname, target_for(tunnel_id), replace)
    return {"zone": zone["name"], "account": account, "tunnel": tunnel_id,
            "tunnelCreated": created, "dns": dns, "url": f"https://{settings.hostname}"}


def upsert_dns(cf: Cloudflare, zone_id: str, hostname: str, target: str, replace: bool) -> str:
    """Point hostname at the tunnel with a proxied CNAME. Returns what changed."""
    record = {"type": "CNAME", "name": hostname, "content": target, "proxied": True,
              "comment": "jomaa-home-hub tunnel (managed by cloudflare.py)"}
    existing = cf.call("GET", f"/zones/{zone_id}/dns_records", query={"name": hostname})
    for r in existing:
        if r["type"] == "CNAME" and r["content"] == target and r.get("proxied"):
            return "unchanged"
    ours = [r for r in existing if r["type"] == "CNAME" and r["content"].endswith(".cfargotunnel.com")]
    others = [r for r in existing if r not in ours]
    if others and not replace:
        kinds = ", ".join(sorted({r["type"] for r in others}))
        raise CloudflareError(
            f"{hostname} already has a {kinds} record that doesn't point at a tunnel. "
            "Pick another hostname, or run deploy --replace to delete it"
        )
    for r in others:
        cf.call("DELETE", f"/zones/{zone_id}/dns_records/{r['id']}")
    if ours:
        cf.call("PUT", f"/zones/{zone_id}/dns_records/{ours[0]['id']}", record)
        for r in ours[1:]:
            cf.call("DELETE", f"/zones/{zone_id}/dns_records/{r['id']}")
        return "updated"
    cf.call("POST", f"/zones/{zone_id}/dns_records", record)
    return "created"


def tunnel_token(cf: Cloudflare, settings: Settings, account: str | None) -> tuple[str, str, str]:
    """Returns (account, tunnel id, tunnel token) for the deployed tunnel."""
    account = account or cf.find_zone(settings.hostname)["account"]["id"]
    tunnel = cf.find_tunnel(account, settings.tunnel)
    if tunnel is None:
        raise CloudflareError(f"tunnel {settings.tunnel!r} doesn't exist yet; run deploy first")
    token = cf.call("GET", f"/accounts/{account}/cfd_tunnel/{tunnel['id']}/token")
    return account, tunnel["id"], token


def compose(*args: str, token: str = "") -> None:
    env = {**os.environ, "CLOUDFLARE_TUNNEL_TOKEN": token}
    result = subprocess.run(["docker", "compose", "--profile", "tunnel", *args], cwd=HUB_DIR, env=env)
    if result.returncode != 0:
        raise CloudflareError(f"docker compose {' '.join(args)} failed")


def public_health(hostname: str, timeout: float = 10) -> str:
    req = urllib.request.Request(f"https://{hostname}/healthz", headers={"User-Agent": "jomaa-home-hub/cloudflare.py"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return "ok" if json.loads(res.read()).get("ok") else f"HTTP {res.status}, unexpected body"
    except urllib.error.HTTPError as e:
        return f"HTTP {e.code}"
    except (urllib.error.URLError, OSError, json.JSONDecodeError) as e:
        return f"not reachable ({e})"


def run(cf: Cloudflare, settings: Settings, account: str | None, wait: float = 60) -> None:
    settings.require_configured()
    account, tunnel_id, token = tunnel_token(cf, settings, account)
    compose("up", "-d", "cloudflared", token=token)
    deadline = time.monotonic() + wait
    while time.monotonic() < deadline:
        tunnel = cf.call("GET", f"/accounts/{account}/cfd_tunnel/{tunnel_id}")
        if tunnel.get("connections"):
            print(f"tunnel connected ({len(tunnel['connections'])} connections)")
            print(f"https://{settings.hostname}/healthz: {public_health(settings.hostname)}")
            return
        time.sleep(2)
    raise CloudflareError("cloudflared started but the tunnel didn't connect; see: docker compose logs cloudflared")


def status(cf: Cloudflare, settings: Settings, account: str | None) -> None:
    settings.require_configured()
    zone = cf.find_zone(settings.hostname)
    account = account or zone["account"]["id"]
    tunnel = cf.find_tunnel(account, settings.tunnel)
    if tunnel is None:
        print(f"tunnel {settings.tunnel}: not created (run deploy)")
        return
    connections = tunnel.get("connections") or []
    colos = ", ".join(sorted({c.get("colo_name", "?") for c in connections})) or "none"
    print(f"tunnel {settings.tunnel}: {tunnel.get('status', 'unknown')}, {len(connections)} connections ({colos})")
    records = cf.call("GET", f"/zones/{zone['id']}/dns_records", query={"name": settings.hostname})
    pointed = any(r["type"] == "CNAME" and r["content"] == target_for(tunnel["id"]) for r in records)
    print(f"dns {settings.hostname}: {'points at the tunnel' if pointed else 'MISSING or wrong (run deploy)'}")
    print(f"https://{settings.hostname}/healthz: {public_health(settings.hostname)}")


def destroy(cf: Cloudflare, settings: Settings, account: str | None) -> None:
    settings.require_configured()
    zone = cf.find_zone(settings.hostname)
    account = account or zone["account"]["id"]
    try:
        compose("rm", "--stop", "--force", "cloudflared")
    except (CloudflareError, FileNotFoundError):
        print("note: couldn't stop a local cloudflared (not on the hub machine?)")
    tunnel = cf.find_tunnel(account, settings.tunnel)
    if tunnel is None:
        print("nothing to delete")
        return
    for r in cf.call("GET", f"/zones/{zone['id']}/dns_records", query={"name": settings.hostname}):
        if r["type"] == "CNAME" and r["content"] == target_for(tunnel["id"]):
            cf.call("DELETE", f"/zones/{zone['id']}/dns_records/{r['id']}")
            print(f"deleted dns record {settings.hostname}")
    cf.call("DELETE", f"/accounts/{account}/cfd_tunnel/{tunnel['id']}/connections")
    cf.call("DELETE", f"/accounts/{account}/cfd_tunnel/{tunnel['id']}")
    print(f"deleted tunnel {settings.tunnel}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    dep = sub.add_parser("deploy", help="create or update the tunnel, routing and DNS")
    dep.add_argument("--replace", action="store_true", help="delete a conflicting DNS record for the hostname")
    dep.add_argument("--if-configured", action="store_true",
                     help="succeed quietly when CLOUDFLARE_HOSTNAME isn't set (for CI)")
    sub.add_parser("run", help="start cloudflared on this machine")
    sub.add_parser("status", help="show tunnel and DNS health")
    sub.add_parser("destroy", help="remove the tunnel and DNS record")
    args = parser.parse_args(argv)

    from hubctl import load_env  # here, not at the top: hubctl imports this module

    env = load_env(HUB_DIR / ".env")
    try:
        settings = Settings.from_env(env)
        if getattr(args, "if_configured", False) and not settings.configured:
            print("CLOUDFLARE_HOSTNAME isn't set; skipping deploy")
            return 0
        settings.require_configured()
        cf = Cloudflare(env.get("CLOUDFLARE_API_TOKEN", ""), base=API)
        account = env.get("CLOUDFLARE_ACCOUNT_ID") or None
        if args.command == "deploy":
            out = deploy(cf, settings, account, args.replace)
            print(f"tunnel {settings.tunnel} ({out['tunnel']}): {'created' if out['tunnelCreated'] else 'reused'}")
            print(f"route {settings.hostname} -> {settings.service}: set")
            print(f"dns {settings.hostname} -> {target_for(out['tunnel'])}: {out['dns']}")
            print(f"next, on the hub machine: python3 scripts/cloudflare.py run   ({out['url']})")
        elif args.command == "run":
            run(cf, settings, account)
        elif args.command == "status":
            status(cf, settings, account)
        elif args.command == "destroy":
            destroy(cf, settings, account)
    except CloudflareError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

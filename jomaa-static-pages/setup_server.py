#!/usr/bin/env python3
"""Publish the static sites in sites.json through the hub's Cloudflare tunnel.

Starts serve.py as the jomaa-static-pages user service on 127.0.0.1:8090,
puts a tunnel rule for each hostname first in the hub's tunnel.yml, restarts
the tunnel if a rule was added, and creates each DNS record. Safe to rerun.
Run it on jerry; the service serves files from the folder this script is in.
See README.md for publishing.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from collections.abc import Callable
from pathlib import Path

from serve import PORT, ROOT, load_sites

SERVICE = f"http://127.0.0.1:{PORT}"
UNIT = "jomaa-static-pages.service"


class SetupError(Exception):
    pass


def run(*args: str, capture: bool = False) -> str:
    r = subprocess.run(args, check=True, text=True, timeout=120,
                       stdout=subprocess.PIPE if capture else None,
                       stderr=subprocess.STDOUT if capture else None)
    return r.stdout.strip() if capture else ""


def unit(python: str) -> str:
    return f"""[Unit]
Description=Jomaa static pages (sites.json) for the Cloudflare tunnel
After=network-online.target
[Service]
ExecStart={python} {ROOT / "serve.py"}
Restart=always
RestartSec=2
[Install]
WantedBy=default.target
"""


def routed_service(cloudflared: Path) -> Callable[[Path, str], str]:
    """Asks cloudflared which service a request for hostname reaches; this also validates the file."""
    def resolve(config: Path, hostname: str) -> str:
        output = run(str(cloudflared), "--config", str(config), "tunnel", "ingress", "rule",
                     f"https://{hostname}/", capture=True)
        match = re.search(r"^\s*service: (\S+)\s*$", output, re.MULTILINE)
        return match.group(1) if match else ""
    return resolve


def add_tunnel_rule(config: Path, hostname: str, resolve: Callable[[Path, str], str]) -> bool:
    """Puts a rule for hostname first in the ingress list. Returns whether the file changed."""
    if resolve(config, hostname) == SERVICE:
        return False
    marker = f"# jomaa-static-pages {hostname}"
    original = config.read_text()
    if marker in original:
        raise SetupError(f"the {marker} rule in {config} no longer reaches {SERVICE}; review it by hand")
    if original.count("ingress:\n") != 1:
        raise SetupError(f"{config} needs review by hand before adding {hostname}")
    rule = f"  {marker}\n  - hostname: {json.dumps(hostname)}\n    service: {SERVICE}\n"
    updated = original.replace("ingress:\n", "ingress:\n" + rule, 1)
    with tempfile.NamedTemporaryFile(mode="w", dir=config.parent, prefix=".tunnel-", delete=False) as f:
        temp = Path(f.name)
        f.write(updated)
    try:
        if resolve(temp, hostname) != SERVICE:
            raise SetupError(f"after adding the rule, {hostname} still doesn't reach {SERVICE}")
        os.replace(temp, config)
    finally:
        temp.unlink(missing_ok=True)
    return True


def tunnel_id(config: Path) -> str:
    match = re.search(r'^tunnel:\s*"?([0-9a-f-]{36})"?\s*$', config.read_text(), re.MULTILINE)
    if not match:
        raise SetupError(f"no tunnel id in {config}")
    return match.group(1)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hub", type=Path, default=ROOT.parent / "jomaa-home-hub",
                        help="hub checkout whose data/native holds the tunnel config and cloudflared")
    args = parser.parse_args(argv)
    tunnel = args.hub / "data/native/tunnel.yml"
    cloudflared = args.hub / "data/native/cloudflared"
    unit_dir = Path.home() / ".config/systemd/user"
    try:
        sites = load_sites(ROOT)
        if not tunnel.is_file() or not cloudflared.is_file():
            raise SetupError(f"no Cloudflare tunnel under {args.hub}; run the hub's setup_native.py --tunnel first")
        unit_dir.mkdir(parents=True, exist_ok=True)
        (unit_dir / UNIT).write_text(unit(sys.executable))
        run("systemctl", "--user", "daemon-reload")
        run("systemctl", "--user", "enable", UNIT)
        run("systemctl", "--user", "restart", UNIT)

        resolve = routed_service(cloudflared)
        changed = [host for host in sites if add_tunnel_rule(tunnel, host, resolve)]
        if changed:
            run("systemctl", "--user", "restart", "jomaa-cloudflared.service")
        for host in sites:
            try:
                run(str(cloudflared), "tunnel", "route", "dns", tunnel_id(tunnel), host, capture=True)
            except subprocess.CalledProcessError as e:
                if "already exists" not in (e.stdout or ""):
                    raise SetupError(f"could not create the DNS record for {host}: {e.stdout}") from e
            print(f"https://{host} -> {sites[host].name}/" + (" (new tunnel rule)" if host in changed else ""))
        return 0
    except (SetupError, ValueError, OSError, subprocess.SubprocessError) as e:
        print(f"setup failed: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

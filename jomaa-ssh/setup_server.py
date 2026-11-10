#!/usr/bin/env python3
"""Serve SSH for this user through the hub's Cloudflare tunnel, keys only.

Runs a second sshd as this user on 127.0.0.1:2222 with password logins off,
adds a tunnel rule that sends the public SSH hostname to it, and creates the
DNS record. The system sshd on port 22 is not touched. Safe to rerun.
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

PORT = 2222
SERVICE = f"ssh://127.0.0.1:{PORT}"
MARKER = "# jomaa-ssh"
UNIT = "jomaa-ssh.service"
SSHD = Path("/usr/sbin/sshd")


class SetupError(Exception):
    pass


def run(*args: str, capture: bool = False) -> str:
    r = subprocess.run(args, check=True, text=True, timeout=120,
                       stdout=subprocess.PIPE if capture else None,
                       stderr=subprocess.STDOUT if capture else None)
    return r.stdout.strip() if capture else ""


def sshd_config(state: Path, user: str) -> str:
    return f"""# Written by jomaa-ssh/setup_server.py. Reached only through the Cloudflare tunnel.
ListenAddress 127.0.0.1
Port {PORT}
HostKey {state}/ssh_host_ed25519_key
PidFile {state}/sshd.pid
AuthorizedKeysFile .ssh/authorized_keys
AllowUsers {user}
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
UsePAM no
StrictModes yes
LoginGraceTime 20
MaxAuthTries 3
X11Forwarding no
# scp and sftp clients.
Subsystem sftp internal-sftp
"""


def unit(config: Path) -> str:
    return f"""[Unit]
Description=Jomaa SSH for the Cloudflare tunnel (keys only)
After=network-online.target
[Service]
ExecStartPre={SSHD} -t -f {config}
ExecStart={SSHD} -D -e -f {config}
Restart=always
RestartSec=2
[Install]
WantedBy=default.target
"""


def routed_service(cloudflared: Path, hostname: str) -> Callable[[Path], str]:
    """Asks cloudflared which service a request for hostname reaches; this also validates the file."""
    def resolve(config: Path) -> str:
        output = run(str(cloudflared), "--config", str(config), "tunnel", "ingress", "rule",
                     f"https://{hostname}", capture=True)
        match = re.search(r"^\s*service: (\S+)\s*$", output, re.MULTILINE)
        return match.group(1) if match else ""
    return resolve


def add_tunnel_rule(config: Path, hostname: str, resolve: Callable[[Path], str]) -> bool:
    """Puts a rule for hostname first in the ingress list. Returns whether the file changed."""
    if resolve(config) == SERVICE:
        return False
    original = config.read_text()
    if MARKER in original:
        raise SetupError(f"the {MARKER} rule in {config} no longer reaches {SERVICE}; review it by hand")
    if original.count("ingress:\n") != 1:
        raise SetupError(f"{config} needs review by hand before adding the SSH route")
    rule = f"  {MARKER}\n  - hostname: {json.dumps(hostname)}\n    service: {SERVICE}\n"
    updated = original.replace("ingress:\n", "ingress:\n" + rule, 1)
    with tempfile.NamedTemporaryFile(mode="w", dir=config.parent, prefix=".tunnel-", delete=False) as f:
        temp = Path(f.name)
        f.write(updated)
    try:
        if resolve(temp) != SERVICE:
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
    parser.add_argument("--hostname", default="ssh.jomaa.org")
    parser.add_argument("--hub", type=Path, default=Path.home() / "jomaa-everything/jomaa-home-hub",
                        help="hub checkout whose data/native holds the tunnel config and cloudflared")
    args = parser.parse_args(argv)
    state = Path.home() / ".local/share/jomaa-ssh"
    unit_dir = Path.home() / ".config/systemd/user"
    tunnel = args.hub / "data/native/tunnel.yml"
    cloudflared = args.hub / "data/native/cloudflared"
    try:
        if not SSHD.is_file():
            raise SetupError(f"{SSHD} not found; install openssh-server")
        keys = Path.home() / ".ssh/authorized_keys"
        if not keys.is_file() or not keys.read_text().strip():
            raise SetupError(f"{keys} is empty; passwords are off, so add a public key first")
        if not tunnel.is_file() or not cloudflared.is_file():
            raise SetupError(f"no Cloudflare tunnel under {args.hub}; run the hub's setup_native.py --tunnel first")

        state.mkdir(parents=True, exist_ok=True)
        state.chmod(0o700)
        key = state / "ssh_host_ed25519_key"
        if not key.exists():
            run("ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "jomaa-ssh", "-f", str(key))
        config = state / "sshd_config"
        config.write_text(sshd_config(state, os.environ.get("USER") or Path.home().name))
        run(str(SSHD), "-t", "-f", str(config))

        unit_dir.mkdir(parents=True, exist_ok=True)
        (unit_dir / UNIT).write_text(unit(config))
        run("systemctl", "--user", "daemon-reload")
        run("systemctl", "--user", "enable", UNIT)
        run("systemctl", "--user", "restart", UNIT)

        if add_tunnel_rule(tunnel, args.hostname, routed_service(cloudflared, args.hostname)):
            run("systemctl", "--user", "restart", "jomaa-cloudflared.service")
            print(f"Tunnel: {args.hostname} -> {SERVICE}")
        try:
            run(str(cloudflared), "tunnel", "route", "dns", tunnel_id(tunnel), args.hostname, capture=True)
        except subprocess.CalledProcessError as e:
            if "already exists" not in (e.stdout or ""):
                raise SetupError(f"could not create the DNS record: {e.stdout}") from e
        host_key = (state / "ssh_host_ed25519_key.pub").read_text().split()
        print(f"SSH for {os.environ.get('USER', '')} is served at {args.hostname}, keys only.")
        print("Host key for jomaa-ssh/known_hosts:")
        print(f"{args.hostname} {host_key[0]} {host_key[1]}")
        return 0
    except (SetupError, OSError, subprocess.SubprocessError) as e:
        print(f"setup failed: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

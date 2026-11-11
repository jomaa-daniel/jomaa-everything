#!/usr/bin/env python3
"""Serve SSH for this user through the hub's Cloudflare tunnel, keys only.

Runs a second sshd as this user on 127.0.0.1:2222 with password logins off,
The deployment manifest supplies the public SSH route and DNS record. The system sshd on port 22 is not touched. Safe to rerun.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

PORT = 2222
SERVICE = f"ssh://127.0.0.1:{PORT}"
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


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hostname", default="ssh.jomaa.org")
    args = parser.parse_args(argv)
    state = Path.home() / ".local/share/jomaa-ssh"
    unit_dir = Path.home() / ".config/systemd/user"
    try:
        if not SSHD.is_file():
            raise SetupError(f"{SSHD} not found; install openssh-server")
        keys = Path.home() / ".ssh/authorized_keys"
        if not keys.is_file() or not keys.read_text().strip():
            raise SetupError(f"{keys} is empty; passwords are off, so add a public key first")

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

        host_key = (state / "ssh_host_ed25519_key.pub").read_text().split()
        print("Keys-only SSH is listening on 127.0.0.1:2222; jomaa-deploy manages its public route.")
        print("Host key for jomaa-ssh/known_hosts:")
        print(f"{args.hostname} {host_key[0]} {host_key[1]}")
        return 0
    except (SetupError, OSError, subprocess.SubprocessError) as e:
        print(f"setup failed: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

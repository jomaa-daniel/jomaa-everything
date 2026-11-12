#!/usr/bin/env python3
"""Join jerry to the tailnet as the home LAN's subnet router and an exit node.

Installs Tailscale from its Ubuntu package repository, keeps IPv4 and IPv6
forwarding on, and runs `tailscale up` with the auth key from jomaa-tailscale/main.tf,
read from ~/.local/share/jomaa-tailscale/authkey and deleted afterwards.
Without that file, `tailscale up` prints a login URL instead. Uses sudo for
system changes. Safe to rerun.
"""
from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

LAN = "192.168.1.0/24"
TAG = "tag:jerry"
HOSTNAME = "jerry"
REPO = "https://pkgs.tailscale.com/stable/ubuntu"
KEYRING = Path("/usr/share/keyrings/tailscale-archive-keyring.gpg")
SOURCES = Path("/etc/apt/sources.list.d/tailscale.list")
SYSCTL = Path("/etc/sysctl.d/99-jomaa-tailscale.conf")
SYSCTL_TEXT = "net.ipv4.ip_forward = 1\nnet.ipv6.conf.all.forwarding = 1\n"
KEY_FILE = Path.home() / ".local/share/jomaa-tailscale/authkey"


class SetupError(Exception):
    pass


def run(*args: str, stdin: str | None = None) -> None:
    subprocess.run(args, check=True, text=True, input=stdin, timeout=600)


def write_root(path: Path, text: str) -> None:
    run("sudo", "tee", str(path), stdin=text)


def os_release(text: str) -> dict[str, str]:
    pairs = (line.split("=", 1) for line in text.splitlines() if "=" in line)
    return {key: value.strip('"') for key, value in pairs}


def apt_source(codename: str) -> str:
    return f"deb [signed-by={KEYRING}] {REPO} {codename} main\n"


def up_args(key_file: Path | None) -> list[str]:
    args = ["sudo", "tailscale", "up", "--reset",
            f"--hostname={HOSTNAME}",
            f"--advertise-tags={TAG}",
            f"--advertise-routes={LAN}",
            "--advertise-exit-node"]
    if key_file is not None:
        args += ["--force-reauth", f"--auth-key=file:{key_file}"]
    return args


def install(codename: str) -> None:
    run("sudo", "curl", "-fsSLo", str(KEYRING), f"{REPO}/{codename}.noarmor.gpg")
    write_root(SOURCES, apt_source(codename))
    run("sudo", "apt-get", "update")
    run("sudo", "apt-get", "install", "-y", "tailscale")


def main() -> int:
    try:
        release = os_release(Path("/etc/os-release").read_text())
        if release.get("ID") != "ubuntu" or not release.get("VERSION_CODENAME"):
            raise SetupError("this script installs Tailscale's Ubuntu packages; jerry runs Ubuntu")
        if shutil.which("tailscale") is None:
            install(release["VERSION_CODENAME"])
        write_root(SYSCTL, SYSCTL_TEXT)
        run("sudo", "sysctl", "-p", str(SYSCTL))
        run("sudo", "systemctl", "enable", "--now", "tailscaled")

        key_file = KEY_FILE if KEY_FILE.is_file() else None
        run(*up_args(key_file))
        if key_file is not None:
            key_file.unlink()
        run("tailscale", "status")
        return 0
    except (SetupError, OSError, subprocess.SubprocessError) as e:
        print(f"setup failed: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

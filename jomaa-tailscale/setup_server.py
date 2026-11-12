#!/usr/bin/env python3
"""Configure jerry's root-owned Tailscale setup. Run once with sudo access; safe to rerun.

Installs Tailscale from its Ubuntu package repository, keeps IPv4 and IPv6
forwarding on, keeps UDP GRO forwarding on for physical interfaces, joins the
tailnet as tag:jerry when jerry is not already joined with that tag (minting a
single-use auth key through tailnet.py), makes this user the tailscaled
operator, and turns on Tailscale auto-updates. Deployments apply node settings
and the tailnet policy afterwards without sudo.
"""
from __future__ import annotations

import getpass
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

CONFIG = json.loads((Path(__file__).parent / "config.json").read_text())
LAN = CONFIG["lan"]
TAG = CONFIG["tag"]
HOSTNAME = CONFIG["hostname"]
KEYRING = Path(CONFIG["apt"]["keyring"])
SOURCES = Path(CONFIG["apt"]["sourceList"])
SYSCTL = Path(CONFIG["sysctlFile"])
DISPATCHER = Path(CONFIG["gro"]["dispatcher"])
ETHTOOL = CONFIG["gro"]["ethtool"]
SYSCTL_TEXT = "net.ipv4.ip_forward = 1\nnet.ipv6.conf.all.forwarding = 1\n"
GRO_ARGS = ("rx-udp-gro-forwarding", "on", "rx-gro-list", "off")


class SetupError(Exception):
    pass


def run(*args: str) -> None:
    subprocess.run(args, check=True, text=True, timeout=CONFIG["commandTimeoutSeconds"])


def query(*args: str, check: bool = True) -> str:
    return subprocess.run(args, check=check, text=True, capture_output=True,
                          timeout=CONFIG["queryTimeoutSeconds"]).stdout


def write_root(path: Path, text: str, mode: str = "644") -> None:
    subprocess.run(["sudo", "tee", str(path)], check=True, text=True, input=text,
                   stdout=subprocess.DEVNULL, timeout=CONFIG["queryTimeoutSeconds"])
    run("sudo", "chmod", mode, str(path))


def dispatcher_script() -> str:
    return f"""#!/bin/sh
# Written by jomaa-tailscale/setup_server.py. Turns on UDP GRO forwarding for
# Tailscale's forwarded traffic whenever a physical interface comes up.
[ "$2" = up ] || exit 0
case "$1" in {"|".join(CONFIG["gro"]["skipInterfaces"])}) exit 0 ;; esac
{ETHTOOL} -K "$1" {" ".join(GRO_ARGS)} 2>/dev/null || true
"""


def default_device(route: str) -> str:
    words = route.split()
    return words[words.index("dev") + 1]


def os_release(text: str) -> dict[str, str]:
    pairs = (line.split("=", 1) for line in text.splitlines() if "=" in line)
    return {key: value.strip('"') for key, value in pairs}


def apt_source(codename: str) -> str:
    return f"deb [signed-by={KEYRING}] {CONFIG['apt']['repository']} {codename} main\n"


def node_args() -> list[str]:
    return [f"--hostname={HOSTNAME}", f"--advertise-routes={LAN}", "--advertise-exit-node"]


def join_args(key_file: Path) -> list[str]:
    return ["sudo", "tailscale", "up", "--reset", "--force-reauth", f"--auth-key=file:{key_file}",
            f"--advertise-tags={TAG}", *node_args()]


def set_args(operator: str) -> list[str]:
    return ["sudo", "tailscale", "set", *node_args(), f"--operator={operator}", "--auto-update"]


def joined(status: dict) -> bool:
    return status.get("BackendState") == "Running" and TAG in (status.get("Self") or {}).get("Tags", [])


def install(codename: str) -> None:
    run("sudo", "curl", "-fsSLo", str(KEYRING), f"{CONFIG['apt']['repository']}/{codename}.noarmor.gpg")
    write_root(SOURCES, apt_source(codename))
    run("sudo", "apt-get", "update")
    run("sudo", "apt-get", "install", "-y", "tailscale")


def join() -> None:
    import tailnet

    key = tailnet.api().create_auth_key()
    fd, name = tempfile.mkstemp(prefix="tailscale-authkey-")
    try:
        with os.fdopen(fd, "w") as file:
            file.write(key)
        run(*join_args(Path(name)))
    finally:
        Path(name).unlink(missing_ok=True)


def main() -> int:
    try:
        release = os_release(Path("/etc/os-release").read_text())
        if release.get("ID") != "ubuntu" or not release.get("VERSION_CODENAME"):
            raise SetupError("this script installs Tailscale's Ubuntu packages; jerry runs Ubuntu")
        if shutil.which("tailscale") is None:
            install(release["VERSION_CODENAME"])
        write_root(SYSCTL, SYSCTL_TEXT)
        run("sudo", "sysctl", "-p", str(SYSCTL))
        write_root(DISPATCHER, dispatcher_script(), mode="755")
        route = query("ip", "-o", "route", "get", CONFIG["routeProbeAddress"])
        run("sudo", ETHTOOL, "-K", default_device(route), *GRO_ARGS)
        run("sudo", "systemctl", "enable", "--now", "tailscaled")

        status = json.loads(query("tailscale", "status", "--json", check=False) or "{}")
        if not joined(status):
            join()
        run(*set_args(getpass.getuser()))
        run("tailscale", "status")
        return 0
    except (SetupError, OSError, ValueError, subprocess.SubprocessError) as e:
        print(f"setup failed: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

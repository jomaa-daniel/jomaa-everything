#!/usr/bin/env python3
"""Set up this machine to reach jerry over SSH through Cloudflare: `ssh jerry`.

If cloudflared is missing, installs it with Homebrew on macOS, or on Linux
downloads the pinned release to ~/.local/bin after checking GitHub's SHA-256
digest. Then pins jerry's tunnel host key from known_hosts next to this script
and adds a `jerry` entry to ~/.ssh/config. Safe to rerun; it replaces its own
entry. Windows uses setup_client.ps1.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import platform
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
BEGIN = "# BEGIN jomaa-ssh"
END = "# END jomaa-ssh"
# The version the hub's native setup uses.
CLOUDFLARED_VERSION = "2026.10.7"
LINUX_ARCH = {"x86_64": "amd64", "aarch64": "arm64", "arm64": "arm64", "armv7l": "arm"}


class SetupError(Exception):
    pass


def host_block(alias: str, hostname: str, user: str, cloudflared: str) -> str:
    return (f"{BEGIN}\nHost {alias}\n  HostName {hostname}\n  User {user}\n"
            f"  ProxyCommand {cloudflared} access ssh --hostname %h\n{END}\n")


def with_block(config: str, block: str) -> str:
    """config with its jomaa-ssh entry replaced by block, or block added at the top."""
    start, end = config.find(BEGIN), config.find(END)
    if start != -1 and end != -1:
        return config[:start] + block + config[end + len(END):].removeprefix("\n")
    # At the top, so a later `Host *` can't override it.
    return block + ("\n" + config if config else "")


def missing_lines(existing: str, wanted: str) -> list[str]:
    have = set(existing.splitlines())
    return [line for line in wanted.splitlines() if line.strip() and line not in have]


def download_linux_cloudflared(dest: Path) -> None:
    """Downloads the pinned Linux release, refusing it unless it matches GitHub's SHA-256 digest."""
    machine = platform.machine()
    if machine not in LINUX_ARCH:
        raise SetupError(f"no cloudflared download for {machine}; install it yourself")
    name = f"cloudflared-linux-{LINUX_ARCH[machine]}"
    request = urllib.request.Request(
        f"https://api.github.com/repos/cloudflare/cloudflared/releases/tags/{CLOUDFLARED_VERSION}",
        headers={"User-Agent": "jomaa-ssh-setup"})
    with urllib.request.urlopen(request, timeout=60) as response:
        asset = next((a for a in json.load(response)["assets"] if a["name"] == name), None)
    if asset is None or not str(asset.get("digest", "")).startswith("sha256:"):
        raise SetupError(f"cloudflared {CLOUDFLARED_VERSION} has no verified {name} download")
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(dest.name + ".download")
    try:
        with urllib.request.urlopen(asset["browser_download_url"], timeout=120) as source, tmp.open("wb") as out:
            shutil.copyfileobj(source, out)
        with tmp.open("rb") as f:
            if hashlib.file_digest(f, "sha256").hexdigest() != asset["digest"].removeprefix("sha256:"):
                raise SetupError(f"checksum mismatch for {name}")
        tmp.chmod(0o755)
        tmp.replace(dest)
    finally:
        tmp.unlink(missing_ok=True)


def find_cloudflared() -> str:
    found = shutil.which("cloudflared")
    if found:
        return found
    if platform.system() == "Linux":
        dest = Path.home() / ".local/bin/cloudflared"
        if not dest.is_file():
            download_linux_cloudflared(dest)
        return str(dest)
    brew = shutil.which("brew")
    if not brew:
        raise SetupError("cloudflared is not installed; install Homebrew, or cloudflared from "
                         "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/")
    subprocess.run([brew, "install", "cloudflared"], check=True)
    prefix = subprocess.run([brew, "--prefix"], check=True, text=True, capture_output=True).stdout.strip()
    return str(Path(prefix) / "bin/cloudflared")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--alias", default="jerry")
    parser.add_argument("--hostname", default="ssh.jomaa.org")
    parser.add_argument("--user", default="jerry")
    args = parser.parse_args(argv)
    ssh = Path.home() / ".ssh"
    try:
        cloudflared = find_cloudflared()
        ssh.mkdir(mode=0o700, exist_ok=True)
        known = ssh / "known_hosts"
        existing = known.read_text() if known.exists() else ""
        add = missing_lines(existing, (HERE / "known_hosts").read_text())
        if add:
            with known.open("a") as f:
                f.write(("" if existing.endswith("\n") or not existing else "\n") + "\n".join(add) + "\n")
        config = ssh / "config"
        current = config.read_text() if config.exists() else ""
        config.write_text(with_block(current, host_block(args.alias, args.hostname, args.user, cloudflared)))
        config.chmod(0o600)
        print(f"Ready: ssh {args.alias}")
        return 0
    except (SetupError, OSError, subprocess.SubprocessError, ValueError, KeyError) as e:
        print(f"setup failed: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

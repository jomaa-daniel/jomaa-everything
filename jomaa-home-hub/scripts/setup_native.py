#!/usr/bin/env python3
"""Install native hub services on Linux. Run with --help for options."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import secrets
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

import cloudflare
import hubctl

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / "native"
UNITS = Path.home() / ".config" / "systemd" / "user"
CLOUDFLARED_VERSION = "2026.10.7"


class SetupError(Exception):
    pass


def run(*args: str, capture: bool = False) -> str:
    result = subprocess.run(args, cwd=ROOT, text=True, check=True, stdout=subprocess.PIPE if capture else None)
    return result.stdout if capture else ""


def fetch_json(url: str):
    req = urllib.request.Request(url, headers={"User-Agent": "jomaa-home-hub-setup"})
    with urllib.request.urlopen(req, timeout=60) as response:
        return json.load(response)


def download(url: str, dest: Path, expected_sha256: str) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(dest.name + ".download")
    try:
        with urllib.request.urlopen(url, timeout=120) as source, tmp.open("wb") as out:
            shutil.copyfileobj(source, out)
        with tmp.open("rb") as f:
            digest = hashlib.file_digest(f, "sha256").hexdigest()
        if digest != expected_sha256:
            raise SetupError(f"checksum mismatch for {url}")
        tmp.replace(dest)
    finally:
        tmp.unlink(missing_ok=True)


def arch() -> str:
    machines = {"x86_64": "amd64", "aarch64": "arm64"}
    if platform.system() != "Linux" or platform.machine() not in machines:
        raise SetupError("native setup supports Linux x86_64 and arm64")
    return machines[platform.machine()]


def get_cloudflared() -> Path:
    binary = DATA / "cloudflared"
    if binary.is_file():
        return binary
    release = fetch_json("https://api.github.com/repos/cloudflare/cloudflared/releases/tags/" + CLOUDFLARED_VERSION)
    asset = next(x for x in release["assets"] if x["name"] == "cloudflared-linux-" + arch())
    digest = asset.get("digest", "")
    if not digest.startswith("sha256:"):
        raise SetupError("Cloudflare release does not provide a SHA-256 digest")
    download(asset["browser_download_url"], binary, digest.removeprefix("sha256:"))
    binary.chmod(0o755)
    return binary


def init_config(root: Path) -> None:
    env = root / ".env"
    if not env.exists():
        fd = os.open(env, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write("HUB_PASSWORD=" + secrets.token_urlsafe(32) + "\nGOVEE_API_KEY=\nHUB_URL=http://127.0.0.1:8080\n")
    if not (root / "config.json").exists():
        config = {"listen": "127.0.0.1:8080", "devices": [], "rooms": []}
        (root / "config.json").write_text(json.dumps(config, indent=2) + "\n")


def verify_boot() -> None:
    problems = hubctl.check_setup(ROOT, hubctl.load_env(ROOT / ".env"))
    for p in (ROOT / "dist/main.js", ROOT / "node_modules/@matter-server/ws-controller"):
        if not p.exists():
            problems.append(f"missing {p}; run python3 scripts/setup_native.py")
    if problems:
        raise SetupError("\n".join(problems))


def install_programs() -> None:
    for name in ("node", "npm", "systemctl", "loginctl"):
        if not shutil.which(name):
            raise SetupError(f"{name} is required; install it before running setup")
    version = run("node", "--version", capture=True).strip().lstrip("v")
    if tuple(int(n) for n in version.split(".")[:2]) < (22, 13):
        raise SetupError("Node.js 22.13 or newer is required")
    (DATA / "matter-data").mkdir(parents=True, exist_ok=True)
    # The hub and its Matter controller, at the versions package-lock.json pins.
    run("npm", "ci", "--no-audit", "--no-fund")
    run("npm", "run", "build")


def systemd_quote(value: str) -> str:
    return json.dumps(value.replace("%", "%%"))


def write_units(tunnel: bool) -> list[str]:
    UNITS.mkdir(parents=True, exist_ok=True)
    python = systemd_quote(sys.executable)
    setup = systemd_quote(str(ROOT / "scripts/setup_native.py"))
    boot = systemd_quote(str(ROOT / "scripts/boot_native.py"))
    units = {
        "jomaa-setup.service": f"[Unit]\nDescription=Check native hub setup\n[Service]\nType=oneshot\nExecStart={python} {setup} --boot\nRemainAfterExit=yes\n",
        "jomaa-hub.service": f"[Unit]\nDescription=Jomaa home hub\nRequires=jomaa-setup.service\nAfter=jomaa-setup.service network-online.target\n[Service]\nExecStart={python} {boot} hub\nRestart=on-failure\nRestartSec=5\n[Install]\nWantedBy=default.target\n",
    }
    if tunnel:
        units["jomaa-cloudflared.service"] = f"[Unit]\nDescription=Jomaa Cloudflare tunnel\nRequires=jomaa-setup.service\nWants=jomaa-hub.service\nAfter=jomaa-setup.service jomaa-hub.service network-online.target\n[Service]\nExecStart={python} {boot} tunnel\nRestart=on-failure\nRestartSec=5\n[Install]\nWantedBy=default.target\n"
    for name, content in units.items():
        (UNITS / name).write_text(content)
    return [name for name in units if name != "jomaa-setup.service"]


def setup_tunnel(hostname: str, name: str) -> None:
    settings = cloudflare.Settings(hostname, name)
    settings.require_configured()
    settings.validate()
    env = hubctl.load_env(ROOT / ".env")
    if len(env.get("HUB_PASSWORD", "")) < 16:
        raise SetupError("the public tunnel requires a HUB_PASSWORD of at least 16 characters")
    cf = str(get_cloudflared())
    cert = Path.home() / ".cloudflared/cert.pem"
    if not cert.exists():
        print("Authorize Cloudflare in your browser and select the domain.", flush=True)
        run(cf, "tunnel", "login")
    tunnels = json.loads(run(cf, "tunnel", "list", "--output", "json", capture=True)) or []
    # cloudflared's default list excludes deleted tunnels; its active entries
    # can still contain the Go zero timestamp in deleted_at.
    matches = [x for x in tunnels if x.get("name") == name]
    if not matches:
        run(cf, "tunnel", "create", name)
        tunnels = json.loads(run(cf, "tunnel", "list", "--output", "json", capture=True)) or []
        matches = [x for x in tunnels if x.get("name") == name]
    if len(matches) != 1:
        raise SetupError(f"expected one tunnel named {name!r}, found {len(matches)}")
    tunnel_id = matches[0]["id"]
    if not re.fullmatch(r"[0-9a-fA-F-]{36}", tunnel_id):
        raise SetupError("Cloudflare returned an invalid tunnel id")
    creds = Path.home() / ".cloudflared" / (tunnel_id + ".json")
    if not creds.is_file():
        raise SetupError(f"local credentials for {name!r} are missing: {creds}")
    config = DATA / "tunnel.yml"
    content = (f"tunnel: {json.dumps(tunnel_id)}\ncredentials-file: {json.dumps(str(creds))}\n"
               f"ingress:\n  - hostname: {json.dumps(settings.hostname)}\n    service: http://127.0.0.1:8080\n"
               "  - service: http_status:404\n")
    if config.exists() and config.read_text() != content:
        raise SetupError(f"{config} already exists with different settings; preserve or remove it manually")
    config.write_text(content)
    run(cf, "--config", str(config), "tunnel", "ingress", "validate")
    run(cf, "tunnel", "route", "dns", name, settings.hostname)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--boot", action="store_true", help="check the existing installation without changing it")
    parser.add_argument("--tunnel", metavar="HOSTNAME", help="set up a locally managed Cloudflare tunnel")
    parser.add_argument("--tunnel-name", default="jomaa-home-hub", help="Cloudflare tunnel name")
    args = parser.parse_args(argv)
    try:
        arch()
        if args.boot:
            verify_boot()
            return 0
        init_config(ROOT)
        problems = hubctl.check_setup(ROOT, hubctl.load_env(ROOT / ".env"))
        if problems:
            raise SetupError("\n".join(problems))
        install_programs()
        if args.tunnel:
            setup_tunnel(args.tunnel, args.tunnel_name)
        tunnel = (DATA / "tunnel.yml").is_file()
        units = write_units(tunnel)
        run("loginctl", "enable-linger", os.environ.get("USER") or str(os.getuid()))
        run("systemctl", "--user", "daemon-reload")
        run("systemctl", "--user", "enable", *units)
        run("systemctl", "--user", "restart", *units)
        hub = hubctl.hub_from_env(hubctl.load_env(ROOT / ".env"))
        hubctl.wait_for("hub", hub.healthy, timeout=60)
        hubctl.wait_for("matter connection", hub.matter_ready, timeout=90)
        print("Native services installed. Edit config.json to add devices; credentials are in .env.")
        return 0
    except (SetupError, OSError, subprocess.CalledProcessError, cloudflare.CloudflareError, hubctl.HubError, StopIteration) as e:
        print(f"setup failed: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

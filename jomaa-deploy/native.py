"""Provision persistent hub state and a locally managed Cloudflare tunnel."""
from __future__ import annotations

import hashlib
import json
import os
import platform
import re
import secrets
import shutil
import subprocess
import urllib.request
from pathlib import Path

import settings

CONFIG = settings.CONFIG


def run(*args: str, capture: bool = False) -> str:
    result = subprocess.run(args, text=True, check=True, timeout=CONFIG["commandTimeoutSeconds"],
                            stdout=subprocess.PIPE if capture else None)
    return result.stdout if capture else ""


def arch() -> str:
    machines = {"x86_64": "amd64", "aarch64": "arm64"}
    if platform.system() != "Linux" or platform.machine() not in machines:
        raise ValueError("native deployment supports Linux x86_64 and arm64")
    return machines[platform.machine()]


def get_cloudflared(data: Path) -> Path:
    binary = data / "cloudflared"
    if binary.is_file():
        return binary
    tunnel = CONFIG["tunnel"]
    request = urllib.request.Request(
        f"{CONFIG['github']['api']}/repos/{tunnel['cloudflaredRepository']}/releases/tags/"
        + tunnel["cloudflaredVersion"], headers={"User-Agent": CONFIG["userAgent"]})
    with urllib.request.urlopen(request, timeout=CONFIG["github"]["timeoutSeconds"]) as response:
        release = json.load(response)
    asset = next((x for x in release["assets"] if x["name"] == "cloudflared-linux-" + arch()), None)
    if asset is None or not asset.get("digest", "").startswith("sha256:"):
        raise ValueError("Cloudflare release does not provide a binary with a SHA-256 digest")
    temp = binary.with_name(binary.name + ".download")
    try:
        with urllib.request.urlopen(asset["browser_download_url"], timeout=tunnel["downloadTimeoutSeconds"]) as source, \
                temp.open("wb") as out:
            shutil.copyfileobj(source, out)
        with temp.open("rb") as file:
            digest = hashlib.file_digest(file, "sha256").hexdigest()
        if digest != asset["digest"].removeprefix("sha256:"):
            raise ValueError("cloudflared checksum mismatch")
        temp.chmod(0o755)
        temp.replace(binary)
    finally:
        temp.unlink(missing_ok=True)
    return binary


def init_config(root: Path) -> None:
    env = root / ".env"
    if not env.exists():
        fd = os.open(env, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, "w") as file:
            file.write("HUB_PASSWORD=" + secrets.token_urlsafe(32) + "\nGOVEE_API_KEY=\nHUB_URL=http://127.0.0.1:8080\n")
    if not (root / "config.json").exists():
        config = {"listen": "127.0.0.1:8080", "devices": [], "rooms": []}
        (root / "config.json").write_text(json.dumps(config, indent=2) + "\n")
    (root / "data/native/matter-data").mkdir(parents=True, exist_ok=True)


def setup_tunnel(data: Path, name: str) -> None:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", name):
        raise ValueError("invalid Cloudflare tunnel name")
    binary = str(get_cloudflared(data))
    config = data / "tunnel.yml"
    if config.exists():
        run(binary, "--config", str(config), "tunnel", "ingress", "validate")
        return
    cert = Path.home() / ".cloudflared/cert.pem"
    if not cert.exists():
        print("Authorize Cloudflare in your browser and select the domain.", flush=True)
        run(binary, "tunnel", "login")
    tunnels = json.loads(run(binary, "tunnel", "list", "--output", "json", capture=True)) or []
    matches = [t for t in tunnels if t.get("name") == name]
    if not matches:
        run(binary, "tunnel", "create", name)
        tunnels = json.loads(run(binary, "tunnel", "list", "--output", "json", capture=True)) or []
        matches = [t for t in tunnels if t.get("name") == name]
    if len(matches) != 1:
        raise ValueError(f"expected one tunnel named {name!r}, found {len(matches)}")
    tunnel_id = matches[0]["id"]
    if not re.fullmatch(r"[0-9a-fA-F-]{36}", tunnel_id):
        raise ValueError("Cloudflare returned an invalid tunnel id")
    creds = Path.home() / ".cloudflared" / (tunnel_id + ".json")
    if not creds.is_file():
        raise ValueError(f"local credentials for {name!r} are missing: {creds}")
    content = (f"tunnel: {json.dumps(tunnel_id)}\ncredentials-file: {json.dumps(str(creds))}\n"
               "ingress:\n  - service: http_status:404\n")
    config.write_text(content)
    run(binary, "--config", str(config), "tunnel", "ingress", "validate")


def provision(source: Path, env: dict[str, str], name: str) -> None:
    arch()
    for program in ("node", "npm", "systemctl", "loginctl"):
        if not shutil.which(program):
            raise ValueError(f"{program} is required; install it before deployment")
    version = run("node", "--version", capture=True).strip().lstrip("v")
    if tuple(int(n) for n in version.split(".")[:2]) < (22, 13):
        raise ValueError("Node.js 22.13 or newer is required")
    minimum = CONFIG["hubPasswordMinLength"]
    if len(env.get("HUB_PASSWORD", "")) < minimum:
        raise ValueError(f"the public hub requires a HUB_PASSWORD of at least {minimum} characters")
    if not env.get("CLOUDFLARE_API_TOKEN"):
        raise ValueError("CLOUDFLARE_API_TOKEN is required for managed DNS")
    config = json.loads((source / "jomaa-home-hub/config.json").read_text())
    if any(d.get("driver") == "govee" for d in config.get("devices", [])) and not env.get("GOVEE_API_KEY"):
        raise ValueError("config.json has Govee devices but GOVEE_API_KEY is not set")
    setup_tunnel(source / CONFIG["tunnel"]["directory"], name)
    run("loginctl", "enable-linger", os.environ.get("USER") or str(os.getuid()))

#!/usr/bin/env python3
"""Download the pinned, checksum-verified MediaMTX server and Video.js assets."""
import argparse
import hashlib
import io
import json
import platform
import sys
import tarfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "jomaa-deploy"))
import settings

CONFIG = json.loads((Path(__file__).resolve().parent / "config.json").read_text())
ARCHITECTURES = {"x86_64": "amd64", "aarch64": "arm64", "arm64": "arm64"}
BINARY_MEMBER = "mediamtx"


def download(url, checksum):
    with urllib.request.urlopen(url, timeout=CONFIG["downloadTimeoutSeconds"]) as response:
        data = response.read()
    if hashlib.sha256(data).hexdigest() != checksum:
        raise ValueError("download checksum does not match the pinned release")
    return data


def install_player():
    for asset in CONFIG["player"]["assets"]:
        destination = ROOT / asset["file"]
        if destination.is_file() and hashlib.sha256(destination.read_bytes()).hexdigest() == asset["sha256"]:
            continue
        data = download(asset["url"], asset["sha256"])
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)


def install_server():
    server = CONFIG["mediaMtx"]
    system = platform.system().lower()
    arch = ARCHITECTURES.get(platform.machine())
    target = f"{system}_{arch}"
    if target not in server["checksums"]:
        raise ValueError("MediaMTX is not configured for this platform")
    archive = f"mediamtx_{server['version']}_{target}.tar.gz"
    url = f"{settings.CONFIG['github']['remote']}/{server['repository']}/releases/download/{server['version']}/{archive}"
    data = download(url, server["checksums"][target])
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as package:
        member = package.extractfile(BINARY_MEMBER)
        if member is None:
            raise ValueError("MediaMTX archive has no executable")
        binary = member.read()
    destination = ROOT / server["binaryFile"]
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(binary)
    destination.chmod(0o755)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server", action="store_true")
    parser.add_argument("--player", action="store_true")
    args = parser.parse_args()
    if args.server: install_server()
    if args.player: install_player()


if __name__ == "__main__":
    main()

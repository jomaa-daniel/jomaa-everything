#!/usr/bin/env python3
"""Route the Jomaa home page and light controller through the native tunnel."""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HOSTNAME = "jomaa.org"
SERVICE = "http://127.0.0.1:8080"
PATH = r"^/(?:home(?:/.*)?|lights(?:/.*)?|api/(?:login|logout|targets(?:/.*)?))?$"
URL_PATHS = (
    "/", "/home", "/home/style.css", "/lights", "/lights/", "/lights/style.css",
    "/lights/app.js", "/api/login", "/api/logout", "/api/targets",
    "/api/targets/living-room/state", "/api/targets/living-room/command",
)


class PublishError(Exception):
    pass


def routed_service(binary: Path, config: Path, path: str) -> str:
    result = subprocess.run(
        [str(binary), "--config", str(config), "tunnel", "ingress", "rule", f"https://{HOSTNAME}{path}"],
        check=True, text=True, capture_output=True, timeout=30,
    )
    match = re.search(r"^\s*service: (\S+)\s*$", result.stdout, re.MULTILINE)
    return match.group(1) if match else ""


def panel_config(original: str) -> str:
    rule = re.compile(
        r'(^  - hostname: (?:"jomaa\.org"|jomaa\.org)\n)'
        r'(?:    path: [^\n]+\n)?'
        r'(    service: http://127\.0\.0\.1:8080\n)', re.MULTILINE,
    )
    matches = list(rule.finditer(original))
    if len(matches) != 1:
        raise PublishError("expected one jomaa.org ingress rule pointing to the hub")
    return rule.sub(lambda match: match[1] + f"    path: {PATH}\n" + match[2], original)


def publish(hub: Path) -> bool:
    config = hub / "data/native/tunnel.yml"
    binary = hub / "data/native/cloudflared"
    original = config.read_text()
    updated = panel_config(original)
    with tempfile.NamedTemporaryFile(mode="w", dir=config.parent, prefix=".panel-route-", delete=False) as file:
        temp = Path(file.name)
        file.write(updated)
    try:
        subprocess.run([str(binary), "--config", str(temp), "tunnel", "ingress", "validate"],
                       check=True, timeout=30)
        for path in URL_PATHS:
            if routed_service(binary, temp, path) != SERVICE:
                raise PublishError(f"{HOSTNAME}{path} does not reach the hub")
        if updated == original:
            return False
        os.replace(temp, config)
        try:
            subprocess.run(["systemctl", "--user", "restart", "jomaa-cloudflared.service"],
                           check=True, timeout=60)
        except (OSError, subprocess.SubprocessError):
            config.write_text(original)
            subprocess.run(["systemctl", "--user", "restart", "jomaa-cloudflared.service"],
                           check=True, timeout=60)
            raise
        return True
    finally:
        temp.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hub", type=Path, default=ROOT)
    args = parser.parse_args()
    try:
        changed = publish(args.hub)
        print("https://jomaa.org/lights is routed to the hub" + ("; tunnel restarted" if changed else ""))
        return 0
    except (OSError, PublishError, subprocess.SubprocessError) as error:
        print(f"panel routing failed: {error}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

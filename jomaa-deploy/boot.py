#!/usr/bin/env python3
"""Start a native service from the current repository release."""

import os
import sys
from pathlib import Path

import settings
from deploy import load_env

ROOT = Path(__file__).resolve().parent.parent / "jomaa-home-hub"
DATA = Path(__file__).resolve().parent.parent / settings.CONFIG["tunnel"]["directory"]


def main() -> None:
    if len(sys.argv) == 2 and sys.argv[1] == "hub":
        os.environ.update(load_env(ROOT / ".env"))
        # Bluetooth pairing talks to BlueZ over D-Bus.
        os.environ.setdefault("NOBLE_BINDINGS", "dbus")
    commands = {
        "hub": ["node", str(ROOT / "dist/main.js"), "--config", str(ROOT / "config.json"),
                "--matter-storage", str(DATA / "matter-data"),
                "--bluetooth-adapter", os.environ.get("MATTER_BLUETOOTH_ADAPTER", "0")],
        "tunnel": [str(DATA / "cloudflared"), "--config", str(DATA / "tunnel.yml"),
                   "tunnel", "--no-autoupdate", "run"],
    }
    if len(sys.argv) != 2 or sys.argv[1] not in commands:
        raise SystemExit("Usage: boot.py {hub|tunnel}")
    os.chdir(ROOT)
    command = commands[sys.argv[1]]
    os.execvpe(command[0], command, os.environ)


if __name__ == "__main__":
    main()

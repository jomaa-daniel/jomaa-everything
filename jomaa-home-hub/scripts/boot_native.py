#!/usr/bin/env python3
"""Start one of the native services; systemd supplies its environment."""

import os
import sys
from pathlib import Path

from hubctl import load_env

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / "native"


def main() -> None:
    if len(sys.argv) == 2 and sys.argv[1] in ("matter", "hub"):
        os.environ.update(load_env(ROOT / ".env"))
    commands = {
        "matter": [str(DATA / "matter/node_modules/.bin/matter-server"),
                   "--storage-path", str(DATA / "matter-data"), "--listen-address", "127.0.0.1",
                   "--bluetooth-adapter", os.environ.get("MATTER_BLUETOOTH_ADAPTER", "0")],
        "hub": [os.environ.get("JOMAA_HUB_BINARY", str(DATA / "hub")), "-config", str(ROOT / "config.json")],
        "tunnel": [str(DATA / "cloudflared"), "--config", str(DATA / "tunnel.yml"),
                   "tunnel", "--no-autoupdate", "run"],
    }
    if len(sys.argv) != 2 or sys.argv[1] not in commands:
        raise SystemExit("Usage: boot_native.py {matter|hub|tunnel}")
    if sys.argv[1] == "matter":
        os.environ.setdefault("NOBLE_BINDINGS", "dbus")
    os.chdir(ROOT)
    command = commands[sys.argv[1]]
    os.execvpe(command[0], command, os.environ)


if __name__ == "__main__":
    main()

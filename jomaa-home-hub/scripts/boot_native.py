#!/usr/bin/env python3
"""Start one of the native services; systemd supplies its environment."""

import os
import sys
from pathlib import Path

from hubctl import load_env

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / "native"


def main() -> None:
    if len(sys.argv) == 2 and sys.argv[1] == "hub":
        os.environ.update(load_env(ROOT / ".env"))
        # Bluetooth pairing talks to BlueZ over D-Bus.
        os.environ.setdefault("NOBLE_BINDINGS", "dbus")
    commands = {
        # The hub runs the Matter controller in-process, on the storage the
        # standalone Matter server used.
        "hub": ["node", str(ROOT / "dist/main.js"), "--config", str(ROOT / "config.json"),
                "--matter-storage", str(DATA / "matter-data"),
                "--bluetooth-adapter", os.environ.get("MATTER_BLUETOOTH_ADAPTER", "0")],
        "tunnel": [str(DATA / "cloudflared"), "--config", str(DATA / "tunnel.yml"),
                   "tunnel", "--no-autoupdate", "run"],
    }
    if len(sys.argv) != 2 or sys.argv[1] not in commands:
        raise SystemExit("Usage: boot_native.py {hub|tunnel}")
    os.chdir(ROOT)
    command = commands[sys.argv[1]]
    os.execvpe(command[0], command, os.environ)


if __name__ == "__main__":
    main()

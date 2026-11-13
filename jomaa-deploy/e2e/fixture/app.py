#!/usr/bin/env python3
"""A fixture module's process, driven by behavior.json in its folder.

  app.py build   "build": ok exits 0, fail exits 1, hang never returns
  app.py serve   "start": ok serves, crash exits 1, slow serves after half of healthWaitSeconds.
                 When "rollbackNeeds" names a file in the module folder, the process exits 1 without it.
                 GET /healthz answers per "health": ok, bad-json, 500 or hang; GET / reports the version.
  app.py run     "start": ok appends the version and revision to state/runs.log and copies the
                 inventory to state/inventory.json, crash exits 1
  app.py check   exits 0
"""
from __future__ import annotations

import json
import shutil
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

FOLDER = Path(__file__).resolve().parent
RELEASE = FOLDER.parent
BEHAVIOR = json.loads((FOLDER / "behavior.json").read_text())
DECLARATION = json.loads((FOLDER / "deploy.json").read_text())
SETTINGS = json.loads((RELEASE / "jomaa-deploy/config.json").read_text())


def hang() -> None:
    threading.Event().wait()


def build() -> int:
    if BEHAVIOR["build"] == "hang":
        hang()
    return 1 if BEHAVIOR["build"] == "fail" else 0


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args) -> None:
        pass

    def answer(self, status: int, body: bytes) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        path = urlsplit(self.path).path
        version = BEHAVIOR["version"]
        if path == DECLARATION["health"]["path"]:
            health = BEHAVIOR["health"]
            if health == "hang":
                hang()
            elif health == "bad-json":
                self.answer(200, b"not json")
            elif health == "500":
                self.answer(500, json.dumps({"ok": False, "version": version}).encode())
            else:
                self.answer(200, json.dumps({"ok": True, "version": version}).encode())
            return
        self.answer(200, json.dumps({"module": DECLARATION["name"], "version": version, "path": path}).encode())


def serve() -> int:
    needs = BEHAVIOR.get("rollbackNeeds")
    if needs and not (FOLDER / needs).exists():
        print(f"missing {needs}", file=sys.stderr)
        return 1
    if BEHAVIOR["start"] == "crash":
        return 1
    if BEHAVIOR["start"] == "slow":
        time.sleep(SETTINGS["healthWaitSeconds"] / 2)
    port = urlsplit(DECLARATION["origin"]).port
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True
    print(f"{DECLARATION['name']} {BEHAVIOR['version']} on port {port}", flush=True)
    server.serve_forever()
    return 0


def run() -> int:
    if BEHAVIOR["start"] == "crash":
        return 1
    state = FOLDER / "state"
    revision = (RELEASE / ".revision").read_text().strip()
    with (state / "runs.log").open("a") as log:
        log.write(f"{BEHAVIOR['version']} {revision}\n")
    inventory = DECLARATION.get("inventory")
    if inventory:
        shutil.copyfile(FOLDER / inventory, state / "inventory.json")
    return 0


def main() -> int:
    actions = {"build": build, "serve": serve, "run": run, "check": lambda: 0}
    if len(sys.argv) != 2 or sys.argv[1] not in actions:
        print("usage: app.py {build|serve|run|check}", file=sys.stderr)
        return 2
    return actions[sys.argv[1]]()


if __name__ == "__main__":
    sys.exit(main())

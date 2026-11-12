#!/usr/bin/env python3
"""Check, develop and control the home hub.

    hubctl.py check                 validate local config and secrets
    hubctl.py dev                   build and run the hub from source
    hubctl.py status                show health, devices, rooms and Matter nodes
    hubctl.py commission CODE       pair a Matter device (QR "MT:..." or manual code)
    hubctl.py wifi SSID             give the hub Wi-Fi credentials for pairing Matter devices
    hubctl.py thread DATASET        give the hub a Thread dataset for pairing Matter devices
    hubctl.py on|off TARGET         switch a device or room

Standard library only, so it runs without pip.
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

HUB_DIR = Path(__file__).resolve().parent.parent


class HubError(Exception):
    pass


# --- Settings ----------------------------------------------------------------


def load_env(path: Path) -> dict[str, str]:
    """Read KEY=value lines. Real environment variables win over the file."""
    values: dict[str, str] = {}
    if path.exists():
        for raw in path.read_text().splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            values[key.strip()] = value.strip().strip("'\"")
    for key in ("HUB_PASSWORD", "GOVEE_API_KEY", "HUB_URL"):
        if os.environ.get(key):
            values[key] = os.environ[key]
    return values


def check_setup(hub_dir: Path, env: dict[str, str]) -> list[str]:
    """Return a list of problems that would stop the hub from starting."""
    problems = []
    config_path = hub_dir / "config.json"
    if not config_path.exists():
        problems.append("config.json is missing: copy config.example.json and edit it")
        config = {}
    else:
        try:
            config = json.loads(config_path.read_text())
        except json.JSONDecodeError as e:
            problems.append(f"config.json is not valid JSON: {e}")
            config = {}
    password = env.get("HUB_PASSWORD", "")
    if not password:
        problems.append("HUB_PASSWORD is not set: copy .env.example to .env and set it")
    elif password == "change-me":
        problems.append("HUB_PASSWORD is still the placeholder from .env.example")
    uses_govee = any(d.get("driver") == "govee" for d in config.get("devices", []))
    if uses_govee and not env.get("GOVEE_API_KEY"):
        problems.append("config.json has Govee devices but GOVEE_API_KEY is not set")
    return problems


# --- Hub API -------------------------------------------------------------------


class Hub:
    def __init__(self, url: str, password: str):
        self.url = url.rstrip("/")
        self.password = password
        self.token: str | None = None

    def request(self, method: str, path: str, body: dict | None = None, timeout: float = 20) -> tuple[int, dict]:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.url + path, data=data, method=method)
        req.add_header("Content-Type", "application/json")
        if self.token:
            req.add_header("Authorization", f"Bearer {self.token}")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as res:
                return res.status, json.loads(res.read() or b"{}")
        except urllib.error.HTTPError as e:
            try:
                return e.code, json.loads(e.read() or b"{}")
            except json.JSONDecodeError:
                return e.code, {}
        except (urllib.error.URLError, OSError) as e:
            raise HubError(f"can't reach the hub at {self.url}: {e}") from e

    def login(self) -> None:
        status, body = self.request("POST", "/api/login", {"password": self.password})
        if status != 200:
            raise HubError(f"login failed: {body.get('error', status)}")
        self.token = body["token"]

    def call(self, method: str, path: str, body: dict | None = None, timeout: float = 20) -> dict:
        if self.token is None:
            self.login()
        status, out = self.request(method, path, body, timeout)
        if status >= 400:
            detail = out.get("error") or out.get("failed") or status
            raise HubError(f"{method} {path}: {detail}")
        return out

    def healthy(self) -> bool:
        try:
            status, _ = self.request("GET", "/healthz", timeout=2)
            return status == 200
        except HubError:
            return False

    def matter_ready(self) -> bool:
        try:
            status, health = self.request("GET", "/healthz", timeout=2)
            return status == 200 and bool(health.get("matterConnected"))
        except HubError:
            return False


def hub_from_env(env: dict[str, str]) -> Hub:
    return Hub(env.get("HUB_URL", "http://127.0.0.1:8080"), env.get("HUB_PASSWORD", ""))


# --- Commands -------------------------------------------------------------------


def cmd_check(env: dict[str, str], args) -> None:
    problems = check_setup(HUB_DIR, env)
    if problems:
        raise HubError("not ready:\n  - " + "\n  - ".join(problems))
    print("ready")


def cmd_dev(env: dict[str, str], args) -> None:
    problems = check_setup(HUB_DIR, env)
    if problems:
        raise HubError("not ready:\n  - " + "\n  - ".join(problems))
    if not shutil.which("npm"):
        raise HubError("node and npm are not installed")
    (HUB_DIR / "data" / "matter").mkdir(parents=True, exist_ok=True)
    for step in (["npm", "ci", "--no-audit", "--no-fund"], ["npm", "run", "build"]):
        if subprocess.run(step, cwd=HUB_DIR).returncode != 0:
            raise HubError(f"{' '.join(step)} failed")
    print("running the hub from source (Ctrl-C to stop)")
    try:
        subprocess.run(["node", "dist/main.js", "--config", "config.json", "--matter-storage", "data/matter"],
                       cwd=HUB_DIR, env={**os.environ, **env})
    except KeyboardInterrupt:
        pass


def cmd_status(env: dict[str, str], args) -> None:
    hub = hub_from_env(env)
    status, health = hub.request("GET", "/healthz", timeout=5)
    if status != 200:
        raise HubError(f"hub is unhealthy (HTTP {status})")
    print(f"hub: up at {hub.url}  matter: {'ready' if health.get('matterConnected') else 'NOT ready'}")
    for t in hub.call("GET", "/api/targets")["targets"]:
        members = f"  [{', '.join(t['members'])}]" if t.get("members") else ""
        print(f"  {t['kind']:<7} {t['id']:<24} {t['name']}{members}")
    if health.get("matterConnected"):
        nodes = hub.call("GET", "/api/matter/nodes")["nodes"]
        print(f"matter nodes: {len(nodes)}")
        for n in nodes:
            name = " ".join(x for x in (n.get("vendor"), n.get("product"), n.get("label")) if x)
            print(f"  node {n['nodeId']:<4} {'online ' if n['available'] else 'offline'} {name}")


def cmd_commission(env: dict[str, str], args) -> None:
    hub = hub_from_env(env)
    print("pairing (this can take a couple of minutes)...")
    out = hub.call("POST", "/api/matter/commission", {"code": args.code, "networkOnly": args.network_only}, timeout=330)
    node_id = out.get("node", {}).get("node_id")
    print(f"paired as node {node_id}. Add it to config.json:")
    print(json.dumps({"id": "new-device", "name": "New device", "driver": "matter", "nodeId": node_id, "endpoint": 1}))


def cmd_wifi(env: dict[str, str], args) -> None:
    password = getpass.getpass(f"Wi-Fi password for {args.ssid}: ")
    hub_from_env(env).call("POST", "/api/matter/wifi", {"ssid": args.ssid, "password": password})
    print("saved")


def cmd_thread(env: dict[str, str], args) -> None:
    hub_from_env(env).call("POST", "/api/matter/thread", {"dataset": args.dataset})
    print("saved")


def cmd_power(env: dict[str, str], args) -> None:
    out = hub_from_env(env).call("POST", f"/api/targets/{args.target}/command", {"on": args.command == "on"})
    if out["failed"]:
        raise HubError(f"{args.target}: {args.command} failed for {out['failed']}")
    print(f"{args.target}: {args.command}")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="hubctl.py", description="Check, develop and control the home hub.")
    sub = p.add_subparsers(dest="command", required=True)
    sub.add_parser("check").set_defaults(fn=cmd_check)
    sub.add_parser("dev").set_defaults(fn=cmd_dev)
    sub.add_parser("status").set_defaults(fn=cmd_status)
    com = sub.add_parser("commission")
    com.add_argument("code")
    com.add_argument("--network-only", action="store_true", help="device is already on the network; skip Bluetooth")
    com.set_defaults(fn=cmd_commission)
    wifi = sub.add_parser("wifi")
    wifi.add_argument("ssid")
    wifi.set_defaults(fn=cmd_wifi)
    thread = sub.add_parser("thread")
    thread.add_argument("dataset", help="hex dataset from your Thread border router")
    thread.set_defaults(fn=cmd_thread)
    for name in ("on", "off"):
        power = sub.add_parser(name)
        power.add_argument("target")
        power.set_defaults(fn=cmd_power)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    env = load_env(HUB_DIR / ".env")
    try:
        args.fn(env, args)
    except HubError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

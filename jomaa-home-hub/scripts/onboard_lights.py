#!/usr/bin/env python3
"""Discover, pair and register lights in the hub's local config.json."""

from __future__ import annotations

import argparse
import copy
import fcntl
import getpass
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import unicodedata
import warnings
from contextlib import contextmanager
from pathlib import Path

from hubctl import HUB_DIR, Hub, HubError, load_env

GOVEE_URL = "https://openapi.api.govee.com"
VALID_ID = re.compile(r"[a-z0-9][a-z0-9-]*\Z")
MAX_INTEGER = 2**53 - 1
VALIDATE_JS = """
import { readFileSync } from 'node:fs';
import { parseConfig } from './dist/config.js';
try { parseConfig(readFileSync(0, 'utf8')); }
catch (err) { console.error(err.message); process.exit(1); }
"""


class Cancelled(Exception):
    pass


def choose(title: str, labels: list[str]) -> int:
    """Select a numbered option, retrying invalid input and accepting q to cancel."""
    print(f"\n{title}")
    for index, label in enumerate(labels, 1):
        print(f"  {index}. {label}")
    while True:
        answer = input("Select a number (q to cancel): ").strip()
        if answer.casefold() == "q":
            raise Cancelled()
        if answer.isdecimal() and 1 <= int(answer) <= len(labels):
            return int(answer) - 1
        print(f"Enter a number from 1 to {len(labels)}.")


def unique_id(name: str, layout: dict, reserved: tuple[str, ...] = ()) -> str:
    """Generate a target ID from a display name that does not collide with targets."""
    ascii_name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower()
    base = re.sub(r"[^a-z0-9]+", "-", ascii_name).strip("-") or "light"
    used = {t["id"] for t in layout.get("devices", []) + layout.get("rooms", [])} | set(reserved)
    candidate = base
    suffix = 2
    while candidate in used:
        candidate = f"{base}-{suffix}"
        suffix += 1
    return candidate


def choose_room(args, layout: dict) -> None:
    rooms = layout.get("rooms", [])
    selection = choose("Choose a room", [r["name"] for r in rooms] + ["No room", "Create a room"])
    if selection < len(rooms):
        args.room = rooms[selection]["id"]
    elif selection == len(rooms) + 1:
        while not (name := input("New room name: ").strip()):
            print("Enter a room name.")
        args.room = unique_id(name, layout, (args.id,))
        args.room_name = name


def remember_inventory(root: Path, driver: str, devices: list[dict], dry_run: bool = False) -> None:
    """Persist discovered device metadata privately and atomically."""
    if dry_run:
        return
    directory = root / "data" / "light-inventory"
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    path = directory / f"{driver}.json"
    previous = path.read_bytes() if path.exists() else None
    save_layout(path, previous, {"driver": driver, "devices": devices})


def matter_inventory(root: Path, hub: Hub, dry_run: bool = False) -> list[dict]:
    nodes = hub.call("GET", "/api/matter/nodes")["nodes"]
    remember_inventory(root, "matter", nodes, dry_run)
    return nodes


def prompt_secret(prompt: str, secrets: list[str]) -> str:
    """Read a secret with terminal echo disabled and retain it for error redaction."""
    with warnings.catch_warnings():
        warnings.simplefilter("error", getpass.GetPassWarning)
        try:
            value = getpass.getpass(prompt)
        except getpass.GetPassWarning:
            raise HubError("secret prompts need an interactive terminal; connect with ssh -t jerry") from None
    secrets.append(value)
    return value


def positive_int(raw: str) -> int:
    value = int(raw)
    if not 0 < value <= MAX_INTEGER:
        raise argparse.ArgumentTypeError("must be a positive safe integer")
    return value


def validate_layout(root: Path, layout: dict) -> None:
    """Validate with the same parser the hub uses at startup."""
    if not (root / "dist/config.js").is_file():
        raise HubError("hub build is missing: run npm run build in the hub directory")
    result = subprocess.run(
        ["node", "--input-type=module", "-e", VALIDATE_JS], cwd=root,
        input=json.dumps(layout), capture_output=True, text=True,
    )
    if result.returncode:
        raise HubError(result.stderr.strip() or "config validation failed")


@contextmanager
def locked_layout(path: Path):
    """Lock the config directory and read the current file through any symlink."""
    path = path.resolve(strict=True)
    fd = os.open(path.parent, os.O_RDONLY)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(fd)
        raise HubError("another onboarding command is using this config directory") from None
    try:
        raw = path.read_bytes()
        layout = json.loads(raw)
        yield path, raw, layout
    finally:
        os.close(fd)


def save_layout(path: Path, previous: bytes | None, layout: dict) -> None:
    """Replace a JSON file atomically with a private file if it is still current."""
    fd, name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    tmp = Path(name)
    try:
        with os.fdopen(fd, "w") as stream:
            stream.write(json.dumps(layout, indent=2) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        current = path.read_bytes() if path.exists() else None
        if current != previous:
            raise HubError("config.json changed during onboarding; run the command again")
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def register(layout: dict, device: dict, room_id: str | None, room_name: str | None) -> dict:
    """Add a light and its room membership without replacing existing targets."""
    result = copy.deepcopy(layout)
    devices = result.setdefault("devices", [])
    rooms = result.setdefault("rooms", [])
    if any(t["id"] == device["id"] for t in devices + rooms):
        raise HubError(f"target {device['id']} already exists; choose a different --id")
    for other in devices:
        if other["driver"] != device["driver"]:
            continue
        if device["driver"] == "matter":
            same = (other["nodeId"], other.get("endpoint", 1)) == (device["nodeId"], device["endpoint"])
        else:
            same = other["device"].casefold() == device["device"].casefold()
        if same:
            raise HubError(f"this light is already registered as {other['id']}")
    devices.append(device)
    if room_id:
        if room_id == device["id"] or any(d["id"] == room_id for d in layout.get("devices", [])):
            raise HubError(f"room {room_id} conflicts with a device ID")
        room = next((r for r in rooms if r["id"] == room_id), None)
        if room is None:
            if not room_name or not room_name.strip():
                raise HubError(f"new room {room_id} needs --room-name")
            rooms.append({"id": room_id, "name": room_name.strip(), "members": [device["id"]]})
        else:
            if room_name and room_name.strip() != room["name"]:
                raise HubError(f"room {room_id} already has name {room['name']}")
            if device["id"] not in room["members"]:
                room["members"].append(device["id"])
    return result


def govee_devices(env: dict[str, str]) -> list[dict]:
    """Read the Govee account's device inventory."""
    key = env.get("GOVEE_API_KEY", "")
    if not key:
        raise HubError("GOVEE_API_KEY is not set in the hub's .env or environment")
    url = os.environ.get("GOVEE_BASE_URL", GOVEE_URL).rstrip("/")
    request = urllib.request.Request(url + "/router/api/v1/user/devices", headers={"Govee-API-Key": key})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            out = json.loads(response.read((1 << 20) + 1))
    except urllib.error.HTTPError as err:
        raise HubError(f"Govee discovery failed: HTTP {err.code}") from None
    except (urllib.error.URLError, OSError):
        raise HubError("can't reach Govee for device discovery") from None
    if not isinstance(out, dict) or out.get("code") != 200 or not isinstance(out.get("data"), list):
        raise HubError("Govee discovery returned an unsuccessful or invalid device list")
    if not all(isinstance(d, dict) for d in out["data"]):
        raise HubError("Govee discovery returned invalid devices")
    return out["data"]


def govee_light(raw: dict, device_id: str, name: str | None) -> dict:
    """Build a config entry for a Govee light the driver can fully control."""
    if raw.get("type") != "devices.types.light":
        raise HubError("device is not a Govee light")
    capabilities = raw.get("capabilities", [])
    if not isinstance(capabilities, list) or not all(isinstance(c, dict) for c in capabilities):
        raise HubError("Govee device has invalid capabilities")
    instances = {c["instance"] for c in capabilities if isinstance(c.get("instance"), str)}
    required = {"powerSwitch", "brightness", "colorRgb", "colorTemperatureK"}
    if not required.issubset(instances):
        raise HubError("light needs power, brightness, RGB and white temperature support")
    temperature = next(c for c in capabilities if c.get("instance") == "colorTemperatureK")
    parameters = temperature.get("parameters", {})
    bounds = parameters.get("range", {}) if isinstance(parameters, dict) else {}
    if not isinstance(bounds, dict):
        raise HubError("Govee light has no valid white temperature range")
    low, high = bounds.get("min"), bounds.get("max")
    if type(low) is not int or type(high) is not int or not 0 < low < high:
        raise HubError("Govee light has no valid white temperature range")
    if not isinstance(raw.get("sku"), str) or not isinstance(raw.get("device"), str):
        raise HubError("Govee light has no sku or device address")
    label = name or raw.get("deviceName")
    if not isinstance(label, str) or not label.strip():
        raise HubError("light needs --name")
    return {
        "id": device_id, "name": label.strip(), "driver": "govee",
        "sku": raw["sku"], "device": raw["device"], "minKelvin": low, "maxKelvin": high,
    }


def select_node(nodes: list[dict], node_id: int, endpoint: int | None, interactive: bool = False) -> int:
    node = next((n for n in nodes if n["nodeId"] == node_id), None)
    if node is None:
        raise HubError(f"Matter node {node_id} is not paired with this hub")
    if "lightEndpoints" not in node:
        raise HubError("hub API does not report light endpoints; deploy the current hub build")
    endpoints = node["lightEndpoints"]
    if not endpoints:
        raise HubError(f"Matter node {node_id} exposes no light or plug endpoints")
    if endpoint is None:
        if len(endpoints) != 1:
            if interactive:
                return endpoints[choose("Choose a light on this Matter device", [f"Light {ep}" for ep in endpoints])]
            raise HubError(f"node {node_id} has endpoints {endpoints}; select one with --endpoint")
        return endpoints[0]
    if endpoint not in endpoints:
        raise HubError(f"endpoint {endpoint} is not a light or plug; available endpoints: {endpoints}")
    return endpoint


def service_env() -> dict[str, str]:
    env = dict(os.environ)
    env.setdefault("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}")
    return env


def restart_command(mode: str) -> list[str]:
    if mode == "native":
        return ["systemctl", "--user", "restart", "jomaa-hub.service"]
    return ["docker", "compose", "up", "-d", "--no-deps", "--force-recreate", "hub"]


def check_service(root: Path, mode: str) -> None:
    if mode == "none":
        return
    cmd = (["systemctl", "--user", "is-active", "--quiet", "jomaa-hub.service"] if mode == "native"
           else ["docker", "compose", "ps", "--status", "running", "-q", "hub"])
    result = subprocess.run(cmd, cwd=root, env=service_env(), capture_output=True, text=True)
    if result.returncode or (mode == "docker" and not result.stdout.strip()):
        raise HubError(f"{mode} hub service is not running; start it or use --restart none")


def activate(root: Path, env: dict[str, str], mode: str, hub: Hub, device_id: str, room_id: str | None) -> None:
    """Restart the hub and verify registration and state without changing power."""
    if mode == "none":
        print("Restart the hub to activate this light.")
        return
    result = subprocess.run(restart_command(mode), cwd=root, env={**service_env(), **env},
                            capture_output=True, text=True)
    if result.returncode:
        raise HubError("config saved, but hub restart failed; inspect the hub service logs")
    deadline = time.monotonic() + 90
    while True:
        try:
            targets = hub.call("GET", "/api/targets")["targets"]
            if not any(t["id"] == device_id and t["kind"] != "room" for t in targets):
                raise HubError("light is missing from the running hub")
            if room_id and not any(t["id"] == room_id and device_id in t.get("members", []) for t in targets):
                raise HubError("room membership is missing from the running hub")
            state = hub.call("GET", f"/api/targets/{device_id}/state")
            if state.get("failed"):
                raise HubError(f"state could not be read: {state['failed']}")
            break
        except HubError as err:
            if time.monotonic() >= deadline:
                raise HubError(f"config saved, but activation could not be verified: {err}") from None
            time.sleep(2)
    print(f"{device_id} is active in the hub.")


def discover(args, env: dict[str, str], hub: Hub, layout: dict) -> None:
    if args.driver == "matter":
        if args.commissionable:
            print(json.dumps(hub.call("GET", "/api/matter/discover"), indent=2))
            return
        nodes = matter_inventory(args.hub_dir, hub)
        for node in nodes:
            node["registered"] = [d["id"] for d in layout.get("devices", [])
                                  if d["driver"] == "matter" and d["nodeId"] == node["nodeId"]]
        print(json.dumps({"nodes": nodes}, indent=2))
        return
    lights = []
    devices = govee_devices(env)
    remember_inventory(args.hub_dir, "govee", devices)
    for raw in devices:
        if raw.get("type") != "devices.types.light":
            continue
        entry = {k: raw.get(k) for k in ("sku", "device", "deviceName")}
        try:
            device = govee_light(raw, "discovered-light", None)
            entry.update({"supported": True, "minKelvin": device["minKelvin"], "maxKelvin": device["maxKelvin"]})
        except HubError as err:
            entry.update({"supported": False, "reason": str(err)})
        entry["registered"] = [d["id"] for d in layout.get("devices", [])
                               if d["driver"] == "govee" and d["device"].casefold() == str(raw.get("device", "")).casefold()]
        lights.append(entry)
    print(json.dumps({"lights": lights}, indent=2))


def onboard(args, root: Path, env: dict[str, str], hub: Hub, secrets: list[str]) -> None:
    with locked_layout(root / "config.json") as (path, previous, layout):
        validate_layout(root, layout)
        nodes = None
        generated_id = not args.id
        paired_name = False
        interactive = not args.id and not (args.command == "matter" and args.pair)
        if args.command == "govee":
            inventory = govee_devices(env)
            remember_inventory(root, "govee", inventory, args.dry_run)
            if args.device:
                raw = next((d for d in inventory if str(d.get("device", "")).casefold() == args.device.casefold()), None)
                if raw is None:
                    raise HubError("device not found in the Govee account; run discover govee")
            else:
                interactive = True
                registered = {d["device"].casefold() for d in layout.get("devices", []) if d["driver"] == "govee"}
                available = []
                for raw in inventory:
                    if str(raw.get("device", "")).casefold() in registered:
                        continue
                    try:
                        govee_light(raw, "candidate", args.name)
                    except HubError:
                        continue
                    available.append(raw)
                if not available:
                    print("No new supported Govee lights found. Add the light in the Govee app, then run this command again.")
                    return
                raw = available[choose("Choose a Govee light", [f"{d.get('deviceName') or args.name} ({d['sku']})" for d in available])]
                args.device = raw["device"]
            if interactive and not args.name:
                args.name = raw["deviceName"]
            args.id = args.id or unique_id(args.name or raw["deviceName"], layout)
            device = govee_light(raw, args.id, args.name)
        else:
            if not args.pair and not args.node_id:
                interactive = True
                nodes = matter_inventory(root, hub, args.dry_run)
                registered = {(d["nodeId"], d.get("endpoint", 1)) for d in layout.get("devices", []) if d["driver"] == "matter"}
                available = []
                for node in nodes:
                    if "lightEndpoints" not in node:
                        raise HubError("hub API does not report light endpoints; deploy the current hub build")
                    for endpoint in node["lightEndpoints"]:
                        if (node["nodeId"], endpoint) not in registered:
                            available.append((node, endpoint))
                labels = [f"{node.get('label') or node.get('product') or 'Matter device'} — light {ep}" for node, ep in available]
                selection = choose("Choose a Matter light", labels + ["Pair a new Matter device"])
                if selection == len(available):
                    args.pair = True
                else:
                    node, args.endpoint = available[selection]
                    args.node_id = node["nodeId"]
            if not args.name:
                if not args.pair:
                    interactive = True
                if args.node_id:
                    nodes = nodes if nodes is not None else matter_inventory(root, hub, args.dry_run)
                    node = next((n for n in nodes if n["nodeId"] == args.node_id), None)
                    if node is None:
                        raise HubError(f"Matter node {args.node_id} is not paired with this hub")
                    default = node.get("label") or node.get("product") or "Matter Light"
                else:
                    default = "Matter Light"
                if args.pair:
                    args.name = default
                    paired_name = True
                else:
                    args.name = default
            args.id = args.id or unique_id(args.name, layout)
            args.network_only = not (args.wifi or args.thread)
            device = {"id": args.id, "name": args.name.strip(), "driver": "matter",
                      "nodeId": args.node_id or MAX_INTEGER, "endpoint": args.endpoint or 1}
        if interactive and not args.room:
            choose_room(args, layout)
        candidate = register(layout, device, args.room, args.room_name)
        validate_layout(root, candidate)
        if interactive and not args.dry_run:
            room = next((r["name"] for r in candidate.get("rooms", []) if r["id"] == args.room), "No room")
            print(f"\nLight: {device['name']}\nRoom: {room}")
            action = "Save registration" if args.restart == "none" else "Save and activate"
            if args.command == "matter" and args.pair:
                action = "Pair and register"
            if choose("Finish onboarding", [action, "Cancel"]) == 1:
                raise Cancelled()
        if args.command == "matter" and args.pair and args.dry_run:
            print("Preview: pair a Matter device and register it with these fields (node and endpoint are discovered):")
            preview = copy.deepcopy(candidate)
            preview["devices"][-1].update({"nodeId": "assigned after pairing", "endpoint": args.endpoint or "auto"})
            print(json.dumps(preview, indent=2))
            return
        if not args.dry_run:
            check_service(root, args.restart)
            if args.restart != "none":
                hub.call("GET", "/api/targets")
        if args.command == "matter":
            if args.pair:
                if args.code_stdin:
                    code = sys.stdin.readline().strip()
                    secrets.append(code)
                else:
                    code = prompt_secret("Matter setup code (MT: QR payload or manual code): ", secrets).strip()
                if not code.startswith("MT:"):
                    code = re.sub(r"[\s-]", "", code)
                    secrets.append(code)
                if not code:
                    raise HubError("Matter setup code is required")
                if args.wifi:
                    password = prompt_secret(f"Wi-Fi password for {args.wifi}: ", secrets)
                    hub.call("POST", "/api/matter/wifi", {"ssid": args.wifi, "password": password})
                if args.thread:
                    dataset = prompt_secret("Thread operational dataset (hex): ", secrets).strip()
                    if not dataset or len(dataset) % 2 or not re.fullmatch(r"[0-9a-fA-F]+", dataset):
                        raise HubError("Thread dataset must be non-empty, even-length hex")
                    hub.call("POST", "/api/matter/thread", {"dataset": dataset})
                print("Pairing the Matter device…", flush=True)
                out = hub.call("POST", "/api/matter/commission", {"code": code, "networkOnly": args.network_only}, timeout=330)
                device["nodeId"] = out["node"]["node_id"]
                print(f"Paired node {device['nodeId']}; use --node-id {device['nodeId']} to register it again if needed.", flush=True)
            if args.pair or nodes is None:
                nodes = matter_inventory(root, hub, args.dry_run)
            if paired_name:
                node = next((n for n in nodes if n["nodeId"] == device["nodeId"]), None)
                if node is None:
                    raise HubError(f"Matter node {device['nodeId']} is not paired with this hub")
                args.name = node.get("label") or node.get("product") or "Matter Light"
                device["name"] = args.name
                if generated_id:
                    args.id = unique_id(args.name, layout, (args.room,) if args.room else ())
                    device["id"] = args.id
            device["endpoint"] = select_node(nodes, device["nodeId"], args.endpoint, interactive)
            candidate = register(layout, device, args.room, args.room_name)
            validate_layout(root, candidate)
        if args.dry_run:
            print(json.dumps(candidate, indent=2))
            return
        save_layout(path, previous, candidate)
        print(f"Registered {device['id']} in {path}.", flush=True)
        activate(root, env, args.restart, hub, device["id"], args.room)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hub-dir", type=Path, default=HUB_DIR, help="hub installation with config.json, .env and dist/")
    parser.add_argument("--url", help="hub API URL (default HUB_URL or http://127.0.0.1:8080)")
    sub = parser.add_subparsers(dest="command")
    discovery = sub.add_parser("discover", help="list account lights or paired Matter nodes")
    discovery.add_argument("driver", choices=["govee", "matter"])
    discovery.add_argument("--commissionable", action="store_true", help="scan the local network for Matter devices in pairing mode")
    for driver in ("matter", "govee"):
        command = sub.add_parser(driver, help=f"register a {driver} light")
        command.add_argument("--id", help="target ID; generated from the selected light's name")
        command.add_argument("--name", help="display name; defaults to the discovered name")
        command.add_argument("--room", help="room ID to join")
        command.add_argument("--room-name", help="display name when creating a room")
        command.add_argument("--dry-run", action="store_true", help="preview without pairing, saving credentials, writing or restarting")
        command.add_argument("--restart", choices=["native", "docker", "none"], default="native")
        if driver == "govee":
            command.add_argument("--device", help="device address; omit to choose a discovered light")
        else:
            source = command.add_mutually_exclusive_group()
            source.add_argument("--pair", action="store_true", help="prompt for a Matter setup code and pair")
            source.add_argument("--code-stdin", action="store_true", help="read a setup code from one stdin line and pair over the network without prompts")
            source.add_argument("--node-id", type=positive_int, help="register an already paired node")
            command.add_argument("--endpoint", type=positive_int, help="light endpoint; detected when the node has just one")
            command.add_argument("--network-only", action="store_true", help="pair a device already on the network")
            credentials = command.add_mutually_exclusive_group()
            credentials.add_argument("--wifi", metavar="SSID", help="prompt for Wi-Fi pairing credentials")
            credentials.add_argument("--thread", action="store_true", help="prompt for a Thread dataset")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command == "discover" and args.commissionable and args.driver != "matter":
        parser.error("--commissionable requires discover matter")
    if args.command and args.command != "discover":
        if (args.id and not VALID_ID.fullmatch(args.id)) or (args.room and not VALID_ID.fullmatch(args.room)):
            parser.error("IDs must be lowercase letters, digits and dashes")
        if args.name is not None and not args.name.strip():
            parser.error("--name must not be blank")
        if args.room_name and not args.room:
            parser.error("--room-name requires --room")
        if args.command == "matter":
            if args.code_stdin:
                args.pair = True
                if args.wifi or args.thread:
                    parser.error("--code-stdin pairs over the network without Wi-Fi or Thread credentials")
            if args.node_id and (args.network_only or args.wifi or args.thread):
                parser.error("pairing options require --pair")
            if args.network_only and (args.wifi or args.thread):
                parser.error("network-only pairing does not use Wi-Fi or Thread credentials")
    env = load_env(args.hub_dir / ".env")
    secrets = [env.get("HUB_PASSWORD", ""), env.get("GOVEE_API_KEY", "")]
    hub = Hub(args.url or env.get("HUB_URL", "http://127.0.0.1:8080"), env.get("HUB_PASSWORD", ""))
    try:
        if args.command is None:
            driver = ["govee", "matter"][choose("Choose a light provider", ["Govee", "Matter"])]
            args = parser.parse_args([*(argv if argv is not None else sys.argv[1:]), driver])
        if args.command == "discover":
            layout = {}
            if not args.commissionable:
                layout = json.loads((args.hub_dir / "config.json").read_text())
                validate_layout(args.hub_dir, layout)
            discover(args, env, hub, layout)
        else:
            onboard(args, args.hub_dir, env, hub, secrets)
    except Cancelled:
        print("Onboarding cancelled.")
        return 0
    except (HubError, OSError, ValueError, KeyError, TypeError) as err:
        message = str(err)
        for secret in sorted(filter(None, secrets), key=len, reverse=True):
            message = message.replace(secret, "[redacted]")
        print(f"error: {message}", file=sys.stderr)
        return 1
    except (KeyboardInterrupt, EOFError):
        print("Onboarding interrupted. Any completed pairing or registration remains saved.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

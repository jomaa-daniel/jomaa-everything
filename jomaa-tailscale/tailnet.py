#!/usr/bin/env python3
"""The tailnet policy, jerry's Tailscale node settings, and managed exit-node access.

    tailnet.py deploy                  during every activation, as the deployment user
    tailnet.py sync --database PATH    run by the hub after changes, periodically and at startup
    tailnet.py observe                 run by the hub to show users, devices and jerry's status

`deploy` fails when setup_server.py's root-owned configuration is missing or
outdated, applies node settings through `tailscale set` when they differ (this
user is the tailscaled operator), and syncs the tailnet policy with the
accounts that have exit-node access (access.py). `sync` runs the same sync for
the hub and prints its outcome as JSON. `observe` prints
the provider's users and devices, the policy's family members, and jerry's
local status as JSON; it changes nothing. Settings come from config.json; the
API token comes from jomaa-tailscale/.env and is never printed.
"""
from __future__ import annotations

import argparse
import getpass
import json
import re
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Callable

import access
import setup_server as host

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "jomaa-deploy"))
import settings as deploy_settings  # noqa: E402

ENV = HERE / ".env"
HUB = HERE.parent / "jomaa-home-hub"
CONFIG = host.CONFIG
EXIT_ROUTES = {"0.0.0.0/0", "::/0"}
PLACEHOLDERS = ("lan", "tag", "router")
ENV_KEYS = ("TAILSCALE_API_KEY",)
TOKEN = re.compile(r"tskey-[A-Za-z0-9_-]+")


class TailnetError(Exception):
    pass


def load_env(path: Path) -> dict[str, str]:
    values = {}
    if path.exists():
        for raw in path.read_text().splitlines():
            line = raw.strip()
            if line and not line.startswith("#") and "=" in line:
                key, _, value = line.partition("=")
                values[key.strip()] = value.strip().strip("'\"")
    return values


def fill(value: object, config: dict) -> object:
    if isinstance(value, str):
        for name in PLACEHOLDERS:
            value = value.replace("{" + name + "}", config[name])
        return value
    if isinstance(value, list):
        return [fill(item, config) for item in value]
    if isinstance(value, dict):
        return {fill(key, config): fill(item, config) for key, item in value.items()}
    return value


def template() -> dict:
    """policy.json with its placeholders filled; group:family is filled by access.render."""
    return fill(json.loads((HERE / "policy.json").read_text()), CONFIG)


def render_policy(policy: dict, config: dict, members: list[str]) -> dict:
    return access.render(fill(policy, config), members)


def scrub(text: str) -> str:
    """Removes anything shaped like a Tailscale key from text that may be shown or logged."""
    return TOKEN.sub("[redacted]", text)


def provider_message(body: bytes) -> str:
    try:
        value = json.loads(body)
    except ValueError:
        return ""
    message = value.get("message") if isinstance(value, dict) else None
    return scrub(message)[:300] if isinstance(message, str) else ""


class Tailscale:
    """The Tailscale API for the configured tailnet. Errors never contain the token."""

    def __init__(self, token: str, base: str = CONFIG["api"]):
        if not token.startswith("tskey-api-"):
            raise TailnetError("TAILSCALE_API_KEY in jomaa-tailscale/.env must be a tskey-api- access token")
        self.token = token
        self.base = base

    def request(self, method: str, path: str, body: dict | None = None) -> object:
        request = urllib.request.Request(
            self.base + path, method=method, data=None if body is None else json.dumps(body).encode(),
            headers={"Authorization": f"Bearer {self.token}", "Accept": "application/json",
                     "Content-Type": "application/json", "User-Agent": CONFIG["userAgent"]})
        try:
            with urllib.request.urlopen(request, timeout=CONFIG["apiTimeoutSeconds"]) as response:
                return json.loads(response.read())
        except urllib.error.HTTPError as error:
            with error:
                detail = provider_message(error.read())
            if error.code == 401:
                raise access.Rejected("Tailscale refused the API token (HTTP 401); replace TAILSCALE_API_KEY "
                                      "in jerry's jomaa-tailscale/.env") from None
            reason = f"Tailscale API {method} {path.split('?')[0]}: HTTP {error.code}" + (f": {detail}" if detail
                                                                                        else "")
            if 400 <= error.code < 500:
                raise access.Rejected(reason) from None
            raise access.Uncertain(reason) from None
        except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError) as error:
            reason = getattr(error, "reason", error)
            raise access.Uncertain(f"Tailscale API unreachable: {scrub(str(reason))[:200]}") from None
        except ValueError:
            raise access.Uncertain(f"Tailscale API {method} {path.split('?')[0]} returned malformed JSON") from None

    def policy(self) -> dict:
        value = self.request("GET", "/acl")
        if not isinstance(value, dict):
            raise access.Uncertain("Tailscale returned a policy that is not an object")
        return value

    def set_policy(self, policy: dict) -> None:
        self.request("POST", "/acl", policy)

    def users(self) -> list[dict]:
        return parse_users(self.request("GET", "/users"))

    def devices(self) -> list[dict]:
        return parse_devices(self.request("GET", "/devices?fields=all"))

    def create_auth_key(self) -> str:
        create = {"reusable": False, "ephemeral": False, "preauthorized": True, "tags": [host.TAG]}
        result = self.request("POST", "/keys", {"capabilities": {"devices": {"create": create}},
                                                "expirySeconds": CONFIG["authKeyExpirySeconds"],
                                                "description": host.HOSTNAME})
        if not isinstance(result, dict) or not isinstance(result.get("key"), str):
            raise TailnetError("Tailscale did not return an auth key")
        return result["key"]


def _items(value: object, key: str) -> list[dict]:
    items = value.get(key) if isinstance(value, dict) else None
    if not isinstance(items, list) or not all(isinstance(item, dict) for item in items):
        raise access.Uncertain(f"Tailscale returned a malformed {key} list")
    return items


def _field(item: dict, key: str, kind: type, what: str, required: bool = True) -> object:
    value = item.get(key)
    if value is None and not required:
        return None
    if not isinstance(value, kind) or isinstance(value, bool) is not (kind is bool):
        raise access.Uncertain(f"Tailscale returned a {what} without a valid {key}")
    return value


def parse_users(value: object) -> list[dict]:
    """Provider users with their stable ID, login name, membership type and role."""
    users = []
    for item in _items(value, "users"):
        user = {key: _field(item, key, str, "user") for key in ("id", "loginName", "displayName", "type", "role",
                                                                 "status")}
        user["lastSeen"] = _field(item, "lastSeen", str, "user", required=False)
        users.append(user)
    return users


def _routes(item: dict, key: str) -> list[str] | None:
    value = item.get(key)
    if value is None:
        return None
    if not isinstance(value, list) or not all(isinstance(route, str) for route in value):
        raise access.Uncertain(f"Tailscale returned a device without a valid {key}")
    return value


def parse_devices(value: object) -> list[dict]:
    """Provider devices; fields the provider omits stay None rather than being guessed."""
    devices = []
    for item in _items(value, "devices"):
        tags = item.get("tags") or []
        if not isinstance(tags, list) or not all(isinstance(tag, str) for tag in tags):
            raise access.Uncertain("Tailscale returned a device without valid tags")
        devices.append({
            "id": _field(item, "id", str, "device"),
            "name": _field(item, "name", str, "device"),
            "hostname": _field(item, "hostname", str, "device", required=False),
            "user": _field(item, "user", str, "device"),
            "os": _field(item, "os", str, "device", required=False),
            "tags": tags,
            "lastSeen": _field(item, "lastSeen", str, "device", required=False),
            "expires": _field(item, "expires", str, "device", required=False),
            "keyExpiryDisabled": _field(item, "keyExpiryDisabled", bool, "device", required=False),
            "authorized": _field(item, "authorized", bool, "device", required=False),
            "connectedToControl": _field(item, "connectedToControl", bool, "device", required=False),
            "advertisedRoutes": _routes(item, "advertisedRoutes"),
            "enabledRoutes": _routes(item, "enabledRoutes"),
        })
    return devices


def api(env: dict[str, str] | None = None) -> Tailscale:
    values = load_env(ENV) if env is None else env
    return Tailscale(values.get("TAILSCALE_API_KEY", ""))


def node_current(prefs: dict) -> bool:
    return (prefs.get("Hostname") == host.HOSTNAME
            and set(prefs.get("AdvertiseRoutes") or []) == {host.LAN, *EXIT_ROUTES})


def host_problems(read: Callable[[Path], str | None], prefs: dict, status: dict, user: str) -> list[str]:
    problems = []
    if read(host.SYSCTL) != host.SYSCTL_TEXT:
        problems.append(f"{host.SYSCTL} is missing or outdated")
    if read(host.DISPATCHER) != host.dispatcher_script():
        problems.append(f"{host.DISPATCHER} is missing or outdated")
    if not host.joined(status):
        problems.append(f"jerry is not joined with {host.TAG}")
    if prefs.get("OperatorUser") != user:
        problems.append(f"{user} is not the tailscaled operator")
    if not (prefs.get("AutoUpdate") or {}).get("Apply"):
        problems.append("Tailscale auto-updates are off")
    return problems


def read_file(path: Path) -> str | None:
    return path.read_text() if path.is_file() else None


def tailscale_json(*args: str) -> dict:
    return json.loads(host.query("tailscale", *args))


def local_status() -> tuple[dict, dict]:
    """jerry's `tailscale status --json` and `tailscale debug prefs`."""
    if shutil.which("tailscale") is None:
        raise TailnetError("Tailscale is not installed; run jomaa-tailscale/setup_server.py on jerry")
    return tailscale_json("status", "--json"), tailscale_json("debug", "prefs")


def hub_database() -> Path:
    """The hub's account database: accounts.databaseFile beside the hub's HEALTH_DB_PATH."""
    health = load_env(HUB / ".env").get("HEALTH_DB_PATH", "")
    if health == "" or health == ":memory:":
        raise TailnetError("jomaa-home-hub/.env must set HEALTH_DB_PATH to the hub's health database file")
    settings = json.loads((HUB / "settings.json").read_text())
    path = Path(health) if Path(health).is_absolute() else HUB / health
    return path.parent / settings["accounts"]["databaseFile"]


def sync(database: Path, provider: access.Provider) -> dict:
    """The access sync, holding the lock in the deployment directory that every sync shares."""
    return access.sync(database, provider, template(), deploy_settings.deploy_dir() / CONFIG["policyLockFile"],
                       CONFIG["lockTimeoutSeconds"], CONFIG["lockPollSeconds"], CONFIG["databaseTimeoutSeconds"])


def section(read: Callable[[], object]) -> dict:
    try:
        return {"ok": True, "value": read()}
    except (access.AccessError, TailnetError) as error:
        return {"ok": False, "error": scrub(str(error))}
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        return {"ok": False, "error": scrub(f"{type(error).__name__}: {error}")[:300]}


def server_status(status: dict, prefs: dict, devices: dict) -> dict:
    """jerry's connection, advertised routes and provider route approval, kept apart."""
    me = status.get("Self") or {}
    tailnet = (status.get("CurrentTailnet") or {}).get("Name")
    record = None
    if devices["ok"]:
        record = next((d for d in devices["value"] if host.TAG in d["tags"] and d["hostname"] == host.HOSTNAME), None)
    return {
        "hostname": host.HOSTNAME,
        "tag": host.TAG,
        "tailnet": tailnet if isinstance(tailnet, str) else None,
        "backendState": status.get("BackendState"),
        "online": me.get("Online") if isinstance(me.get("Online"), bool) else None,
        "tagged": host.joined(status),
        "advertisedRoutes": sorted(prefs.get("AdvertiseRoutes") or []),
        "approvedRoutes": None if record is None or record["enabledRoutes"] is None
        else sorted(record["enabledRoutes"]),
        "problems": host_problems(read_file, prefs, status, getpass.getuser()),
    }


def observe(provider: Tailscale, local: Callable[[], tuple[dict, dict]] = local_status) -> dict:
    users = section(provider.users)
    devices = section(provider.devices)

    def policy() -> dict:
        value = provider.policy()
        return {"family": sorted(access.family_members(value))}

    def server() -> dict:
        status, prefs = local()
        return server_status(status, prefs, devices)

    return {"observedAt": int(time.time() * 1000), "users": users, "devices": devices,
            "policy": section(policy), "server": section(server)}


def deploy() -> None:
    status, prefs = local_status()
    problems = host_problems(read_file, prefs, status, getpass.getuser())
    if problems:
        raise TailnetError("run jomaa-tailscale/setup_server.py on jerry with sudo: " + "; ".join(problems))
    if not node_current(prefs):
        subprocess.run(["tailscale", "set", *host.node_args()], check=True,
                       timeout=CONFIG["queryTimeoutSeconds"])
        print("Applied jerry's Tailscale node settings.")
    env = load_env(ENV)
    unknown = sorted(set(env) - set(ENV_KEYS))
    if unknown:
        raise TailnetError("jomaa-tailscale/.env has settings that are not read: " + ", ".join(unknown)
                           + ". Remove them; family access is managed at /tailscale.")
    outcome = sync(hub_database(), api(env))
    print(outcome["message"])
    if outcome["status"] == access.FAILED:
        raise TailnetError(outcome["message"])


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=("deploy", "sync", "observe"))
    parser.add_argument("--database", type=Path, help="sync: the hub's account database")
    args = parser.parse_args(argv)
    if args.command == "sync" and args.database is None:
        parser.error("sync requires --database")
    try:
        if args.command == "deploy":
            deploy()
        elif args.command == "sync":
            print(json.dumps(sync(args.database, api())))
        else:
            print(json.dumps(observe(api())))
        return 0
    except (TailnetError, access.AccessError, OSError, ValueError, KeyError, subprocess.SubprocessError,
            urllib.error.URLError) as e:
        message = scrub(str(e))
        if args.command == "deploy":
            print(f"tailnet deploy failed: {message}", file=sys.stderr)
        else:
            print(json.dumps({"status": access.FAILED, "message": message}))
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

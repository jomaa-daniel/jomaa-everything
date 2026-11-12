#!/usr/bin/env python3
"""Deploy the tailnet policy and jerry's Tailscale node settings.

`deploy` runs during every jomaa-deploy activation as the deployment user. It
fails when setup_server.py's root-owned configuration is missing or outdated,
applies node settings through `tailscale set` when they differ (this user is
the tailscaled operator), and replaces the tailnet policy when it differs from
policy.json with its placeholders and group:family filled in. Settings come
from config.json. Reads TAILSCALE_API_KEY and TAILSCALE_FAMILY (comma-separated
emails) from jomaa-tailscale/.env.
"""
from __future__ import annotations

import getpass
import json
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Callable

import setup_server as host

HERE = Path(__file__).parent
ENV = HERE / ".env"
CONFIG = host.CONFIG
EXIT_ROUTES = {"0.0.0.0/0", "::/0"}
PLACEHOLDERS = ("lan", "tag", "router")


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


def family(env: dict[str, str]) -> list[str]:
    return [email.strip() for email in env.get("TAILSCALE_FAMILY", "").split(",") if email.strip()]


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


def render_policy(template: dict, config: dict, members: list[str]) -> dict:
    base = fill(template, config)
    return {**base, "groups": {**base["groups"], "group:family": members},
            "tests": base["tests"] if members else []}


def desired_policy(env: dict[str, str]) -> dict:
    return render_policy(json.loads((HERE / "policy.json").read_text()), CONFIG, family(env))


class Tailscale:
    def __init__(self, token: str):
        if not token.startswith("tskey-api-"):
            raise TailnetError("TAILSCALE_API_KEY in jomaa-tailscale/.env must be a tskey-api- access token")
        self.token = token

    def request(self, method: str, path: str, body: dict | None = None) -> dict:
        request = urllib.request.Request(
            CONFIG["api"] + path, method=method, data=None if body is None else json.dumps(body).encode(),
            headers={"Authorization": f"Bearer {self.token}", "Accept": "application/json",
                     "Content-Type": "application/json", "User-Agent": CONFIG["userAgent"]})
        try:
            with urllib.request.urlopen(request, timeout=CONFIG["apiTimeoutSeconds"]) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            raise TailnetError(f"Tailscale API {method} {path}: {error.code} {error.read().decode()[:300]}") from error

    def policy(self) -> dict:
        return self.request("GET", "/acl")

    def set_policy(self, policy: dict) -> None:
        self.request("POST", "/acl", policy)

    def create_auth_key(self) -> str:
        create = {"reusable": False, "ephemeral": False, "preauthorized": True, "tags": [host.TAG]}
        result = self.request("POST", "/keys", {"capabilities": {"devices": {"create": create}},
                                                "expirySeconds": CONFIG["authKeyExpirySeconds"],
                                                "description": host.HOSTNAME})
        return result["key"]


def api(env: dict[str, str] | None = None) -> Tailscale:
    return Tailscale((load_env(ENV) if env is None else env).get("TAILSCALE_API_KEY", ""))


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


def deploy() -> None:
    if shutil.which("tailscale") is None:
        raise TailnetError("Tailscale is not installed; run jomaa-tailscale/setup_server.py on jerry")
    prefs = tailscale_json("debug", "prefs")
    problems = host_problems(read_file, prefs, tailscale_json("status", "--json"), getpass.getuser())
    if problems:
        raise TailnetError("run jomaa-tailscale/setup_server.py on jerry with sudo: " + "; ".join(problems))
    if not node_current(prefs):
        subprocess.run(["tailscale", "set", *host.node_args()], check=True,
                       timeout=CONFIG["queryTimeoutSeconds"])
        print("Applied jerry's Tailscale node settings.")
    env = load_env(ENV)
    desired = desired_policy(env)
    client = api(env)
    if client.policy() != desired:
        client.set_policy(desired)
        print("Updated the tailnet policy.")
    else:
        print("Tailnet policy is current.")


def main(argv: list[str]) -> int:
    if argv != ["deploy"]:
        print("usage: tailnet.py deploy", file=sys.stderr)
        return 2
    try:
        deploy()
        return 0
    except (TailnetError, OSError, ValueError, KeyError, subprocess.SubprocessError, urllib.error.URLError) as e:
        print(f"tailnet deploy failed: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

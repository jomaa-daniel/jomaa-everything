"""Test fixtures: temporary repositories of modules, a recording context and a simulated Cloudflare."""
from __future__ import annotations

import copy
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import deploy
import routing
import settings
from modules import Context

TUNNEL_ID = "4b03940e-11ab-48c6-b288-4c9deb2cc905"
TUNNEL_HEADER = f'tunnel: "{TUNNEL_ID}"\ncredentials-file: "/home/jerry/.cloudflared/private.json"\n'
TARGET = f"{TUNNEL_ID}.cfargotunnel.com"

APP = {"name": "app", "inputs": [], "checks": [["true"]], "state": ["app/.env"], "unit": "jomaa-app",
       "origin": "http://127.0.0.1:9001", "command": ["{python}", "{release}/app/server.py"],
       "build": [["build-app"]], "health": {"path": "/healthz", "json": {"ok": True}},
       "routes": [{"hostname": "app.example.org"},
                  {"hostname": "example.org", "path": "^/app(/.*)?$", "probes": ["/app"]}]}
WEB = {"name": "web", "inputs": [], "checks": [], "state": [], "unit": "jomaa-web",
       "origin": "http://127.0.0.1:9002", "command": ["{python}", "{release}/web/serve.py"], "build": [],
       "health": {"path": "/healthz", "json": {"ok": True}}, "routes": []}
SHELL = {"name": "shell", "inputs": [], "checks": [], "state": [], "origin": "ssh://127.0.0.1:2222",
         "routes": [{"hostname": "shell.example.org"}]}
TOOL = {"name": "tool", "inputs": [], "checks": [], "state": [], "build": [["tool-build"]],
        "command": ["tool-run"], "inventory": "inventory.json"}
BENCH = {"name": "bench", "inputs": [], "checks": [["true"]], "state": []}
CLASSES = {"app": ("Service", "class App(Service):\n    pass\n"),
           "web": ("Service, StaticSite",
                   "class Web(Service):\n    def children(self):\n        return StaticSite.discover(self)\n"),
           "shell": ("External", "class Shell(External):\n    pass\n"),
           "tool": ("Command", "class Tool(Command):\n    pass\n"),
           "bench": ("Checks", "class Bench(Checks):\n    pass\n")}
DECLARATIONS = {"app": APP, "web": WEB, "shell": SHELL, "tool": TOOL, "bench": BENCH}


class FakeCloudflare:
    """DNS records of one zone, with every mutation recorded."""

    def __init__(self, records=()):
        self.records = {str(i): {"id": str(i), **r} for i, r in enumerate(records, start=1)}
        self.next_id = len(self.records) + 1
        self.mutations = []
        self.broken: set[str] = set()

    def find_zone(self, host):
        if host in self.broken:
            raise OSError("zone lookup failed")
        return {"id": "zone"}

    def call(self, method, path, body=None, query=None):
        if method == "GET":
            return [copy.deepcopy(r) for r in self.records.values() if r["name"] == query["name"]]
        self.mutations.append((method, path, body))
        if method == "POST":
            record_id = str(self.next_id)
            self.next_id += 1
            self.records[record_id] = {"id": record_id, **body}
            return self.records[record_id]
        record_id = path.rsplit("/", 1)[1]
        if method == "DELETE":
            del self.records[record_id]
            return None
        self.records[record_id] = {"id": record_id, **body}
        return self.records[record_id]

    def hosts(self) -> set[str]:
        return {r["name"] for r in self.records.values()}


def cname(name: str, **values) -> dict:
    return {"type": "CNAME", "name": name, "content": TARGET, "proxied": True, "ttl": 1,
            "comment": routing.DNS_COMMENT, **values}


class FakeContext(Context):
    """Records commands instead of running them; health answers come from the unhealthy set."""

    def __init__(self, *args, cloudflare: FakeCloudflare, failing=(), unhealthy=(), **kwargs):
        super().__init__(*args, **kwargs)
        self.calls: list[tuple[str, ...]] = []
        self.failing = set(failing)
        self.unhealthy = set(unhealthy)
        self.cf = cloudflare

    def run(self, *args, cwd=None):
        self.calls.append(args)
        if args[0] in self.failing or args in self.failing:
            raise subprocess.CalledProcessError(1, args)

    def healthy(self, check):
        return check.get("host", check["url"]) not in self.unhealthy

    def wait_healthy(self, check):
        return self.healthy(check)

    def cloudflare(self, token):
        return self.cf


def render_only(binary, path, rules, probes, timeout):
    return routing.render(path.read_text(), rules)


class ModuleTestCase(unittest.TestCase):
    """A git repository of modules, a checkout with runtime state and a deployment directory."""

    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.repo = self.root / "repo"
        self.source = self.root / "source"
        self.deploy_dir = self.root / "deploy"
        self.unit_dir = self.root / "units"
        for path in (self.repo, self.source, self.deploy_dir, self.unit_dir):
            path.mkdir()
        self.git("init", "-q")
        self.git("config", "user.email", "test@example.org")
        self.git("config", "user.name", "Test")
        self.write("jomaa-deploy/deploy.py", "# deployment receiver\n")
        native = self.source / settings.CONFIG["tunnel"]["directory"]
        native.mkdir(parents=True)
        self.tunnel = native / "tunnel.yml"
        self.tunnel.write_text(TUNNEL_HEADER + "ingress:\n  - service: http_status:404\n")
        env = self.source / settings.CONFIG["cloudflare"]["env"]
        env.write_text("CLOUDFLARE_API_TOKEN=test-token\n")
        (self.source / "app").mkdir()
        (self.source / "app/.env").write_text("SECRET=1\n")
        self.cloudflare = FakeCloudflare()
        patch = mock.patch.object(routing, "prepare", side_effect=render_only)
        patch.start()
        self.addCleanup(patch.stop)

    def git(self, *args: str) -> str:
        return subprocess.run(["git", "-C", str(self.repo), *args], check=True, text=True,
                              stdout=subprocess.PIPE).stdout.strip()

    def write(self, path: str, content: str) -> None:
        file = self.repo / path
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(content)

    def add_module(self, directory: str, declaration: dict | None = None, classes: tuple[str, str] | None = None):
        names, body = classes or CLASSES[directory]
        self.write(f"{directory}/deploy_module.py", f"from modules import {names}\n\n\n{body}")
        self.write(f"{directory}/deploy.json", json.dumps(declaration or DECLARATIONS[directory], indent=2))

    def add_all(self):
        for directory in DECLARATIONS:
            self.add_module(directory)
        self.write("app/server.py", "# app\n")
        self.write("web/serve.py", "# web\n")
        self.write("web/one.example.org/index.html", "one")
        self.write("web/assets/logo.txt", "support folder")

    def commit(self, message: str = "change") -> str:
        self.git("add", "-A")
        self.git("commit", "-qm", message)
        return self.git("rev-parse", "HEAD")

    def context(self, sha: str, **kwargs) -> FakeContext:
        release = deploy.extract_release(self.repo, sha, self.deploy_dir)
        return FakeContext(self.source, self.deploy_dir, release, sha, self.repo, unit_dir=self.unit_dir,
                           cloudflare=self.cloudflare, **kwargs)

    @staticmethod
    def restarted(ctx: FakeContext) -> set[str]:
        return {call[3].removesuffix(".service") for call in ctx.calls if call[:3] == ("systemctl", "--user", "restart")}

    @staticmethod
    def built(ctx: FakeContext) -> set[str]:
        return {call[0] for call in ctx.calls if call[0] != "systemctl"}

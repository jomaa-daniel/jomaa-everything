#!/usr/bin/env python3
"""Container fault-injection harness for jomaa-deploy.

Usage: python3 jomaa-deploy/e2e/harness.py SUITE

runs scenario_SUITE.py against a fresh compose project of jerry, the fakes and the Actions runner, and
on a failing test collects journals, the deployment directory and the fakes request log into
artifactDirectory/SUITE/TEST. Scenario files subclass E2ETestCase and drive the Harness in self.h.
"""
from __future__ import annotations

import atexit
import copy
import hashlib
import hmac
import importlib.machinery
import importlib.util
import json
import os
import re
import secrets
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request
import uuid
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

E2E = Path(__file__).resolve().parent
DEPLOY_CODE = E2E.parent
CHECKOUT = DEPLOY_CODE.parent
CONFIG: dict = json.loads((E2E / "config.json").read_text())
DEPLOY_CONFIG: dict = json.loads((DEPLOY_CODE / "config.json").read_text())

sys.path.insert(0, str(DEPLOY_CODE))
import engine  # noqa: E402
import routing  # noqa: E402
import settings  # noqa: E402
from modules import KINDS, VERIFY_JOB  # noqa: E402
from modules import ingress  # noqa: E402

TIMEOUTS = CONFIG["timeouts"]
JERRY = CONFIG["jerry"]
FAKES = CONFIG["fakes"]
FIXTURE = CONFIG["fixture"]
TEMPLATES = E2E / "fixture"
APP = "app.py"
BEHAVIOR = "behavior.json"
DECLARATION = "deploy.json"
GITIGNORE_TEMPLATE = "gitignore"
WORKFLOW_PATH = ".github/workflows/deploy.yml"
WORKFLOW_JOBS = {"modules": "success", "deploy": None}
INGRESS_FILE = "ingress.json"
EDGE_FILE = "edge.json"
CA_FILE = "ca.pem"
CERTIFICATE_FILE = "edge.pem"
KEY_FILE = "edge.key"
SECRET_FILE = "webhook-secret"
ASSET_PREFIX = "cloudflared-linux"
GIT_IDENTITY = {"GIT_AUTHOR_NAME": "e2e", "GIT_AUTHOR_EMAIL": "e2e@example.test",
                "GIT_COMMITTER_NAME": "e2e", "GIT_COMMITTER_EMAIL": "e2e@example.test"}
STATUS = re.compile(r"^Deployment result: (\S+) \(([0-9a-f]{12})\)$", re.MULTILINE)
MODULE_LINE = re.compile(r"^  (\S+): (\S+)$")
INGRESS_LINE = re.compile(r"^  ingress: (.*)$", re.MULTILINE)
REPORTED = ("deployed", "partial")
HTTPS_PORT = 443


def load_wrapper():
    """The cloudflared wrapper as a Python module, for its constants and ingress matching."""
    loader = importlib.machinery.SourceFileLoader("e2e_cloudflared", str(E2E / "cloudflared"))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


WRAPPER = load_wrapper()


def templates() -> list[str]:
    """The fixture module folders in fixture/."""
    return sorted(p.parent.name for p in TEMPLATES.glob(f"*/{DECLARATION}"))


def merge(base: dict, changes: dict) -> dict:
    """base with changes applied recursively."""
    result = copy.deepcopy(base)
    for key, value in changes.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = merge(result[key], value)
        else:
            result[key] = copy.deepcopy(value)
    return result


def fixture_settings() -> dict:
    """The fixture repository's jomaa-deploy/config.json: the checkout's, pointed at the fakes and jerry."""
    fakes = f"{FAKES['port']}"
    return merge(merge(DEPLOY_CONFIG, FIXTURE["settings"]), {
        "repo": FIXTURE["repo"],
        "webhook": {"hostname": FIXTURE["webhookHostname"]},
        "github": {"api": f"http://{FAKES['githubHost']}:{fakes}", "remote": JERRY["gitRoot"]},
        "cloudflare": {"api": f"http://{FAKES['cloudflareHost']}:{fakes}{FAKES['cloudflarePath']}"},
    })


def check_job(name: str) -> str:
    return f"check ({name})"


def result_name(sha: str, run_id: int, attempt: int) -> str:
    return f"{sha}-{run_id}-{attempt}.json"


def wait_for(predicate, timeout: float, message: str):
    """Poll predicate until it returns a truthy value, or raise AssertionError with message."""
    deadline = time.monotonic() + timeout
    while True:
        value = predicate()
        if value:
            return value
        if time.monotonic() >= deadline:
            raise AssertionError(f"timed out after {timeout}s: {message}")
        time.sleep(TIMEOUTS["pollSeconds"])


@dataclass
class Result:
    """A finished command: exit code and decoded output."""
    code: int
    out: str
    err: str

    @property
    def output(self) -> str:
        return self.out + self.err


def run(args: list[str], *, input: bytes | str | None = None, check: bool = True, timeout: float | None = None,
        env: dict | None = None, cwd: Path | None = None) -> Result:
    data = input.encode() if isinstance(input, str) else input
    process = subprocess.run(args, input=data, capture_output=True, timeout=timeout or TIMEOUTS["execSeconds"],
                             env=env, cwd=cwd)
    result = Result(process.returncode, process.stdout.decode(errors="replace"),
                    process.stderr.decode(errors="replace"))
    if check and result.code:
        raise AssertionError(f"command failed ({result.code}): {shlex.join(args)}\n{result.output}")
    return result


@dataclass
class NotifyResult:
    """What notify.py exited with and printed."""
    code: int
    output: str
    sha: str
    run_id: int
    attempt: int
    status: str | None = None
    modules: dict[str, str] = field(default_factory=dict)
    ingress: dict | None = None

    @classmethod
    def parse(cls, result: Result, sha: str, run_id: int, attempt: int) -> NotifyResult:
        parsed = cls(result.code, result.output, sha, run_id, attempt)
        found = STATUS.search(result.out)
        if found:
            parsed.status = found[1]
            for line in result.out[found.end():].splitlines():
                module = MODULE_LINE.match(line)
                if module and module[1] != "ingress":
                    parsed.modules[module[1]] = module[2]
            ingress_line = INGRESS_LINE.search(result.out)
            if ingress_line:
                parsed.ingress = json.loads(ingress_line[1])
        return parsed


class Fakes:
    """Client of the fakes' /_control API, reached through its published port."""

    def __init__(self, url: str):
        self.url = url

    def call(self, method: str, path: str, body: object = None) -> object:
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(self.url + path, data=data, method=method,
                                         headers={"Content-Type": "application/json"})
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(request, timeout=TIMEOUTS["httpSeconds"]) as response:
            return json.load(response)

    def control(self, **change: object) -> None:
        """Merge a change into the fakes' state; the keys are listed in fakes.py."""
        self.call("POST", "/_control", change)

    def reset(self) -> None:
        """Clear runs, jobs, faults, the request log and every DNS record, the deployment's included."""
        self.call("POST", "/_control/reset", {})

    def clear_faults(self) -> None:
        self.control(clearFaults=True)

    def state(self) -> dict:
        return self.call("GET", "/_control")

    def set_run(self, run_id: int, run: dict | None) -> None:
        self.control(runs={str(run_id): run})

    def set_jobs(self, run_id: int, attempt: int, jobs: dict[str, str | None] | None) -> None:
        """The jobs of one run attempt by name and conclusion, None for a job still running."""
        listed = None if jobs is None else [{"name": name, "conclusion": value} for name, value in jobs.items()]
        self.control(jobs={f"{run_id}/{attempt}": listed})

    def set_github_fault(self, endpoint: str, fault: int | str | None) -> None:
        """endpoint: run, jobs, release or asset; fault: 500, "hang" or None."""
        self.control(github={endpoint: fault})

    def set_release(self, digest: str | None = None, missing_asset: bool = False) -> None:
        self.control(release={"digest": digest, "missingAsset": missing_asset})

    def set_dns_fault(self, host: str, fault: int | str | None) -> None:
        """fault: 500, "hang", "success-false" or None, for every Cloudflare request about host."""
        self.control(dns={host: fault})

    def set_missing_zones(self, *zones: str) -> None:
        self.control(missingZones=list(zones))

    def seed_records(self, *records: dict) -> None:
        """Add DNS records as they are; clear_faults removes them again."""
        self.control(records=list(records))

    def requests(self, since: int = 0) -> list[dict]:
        return self.state()["requests"][since:]

    def mark(self) -> int:
        """The current length of the request log, for requests(since=...)."""
        return len(self.state()["requests"])

    def records(self) -> list[dict]:
        return self.state()["records"]


class FixtureRepo:
    """The fixture git repository on the host that the harness pushes to jerry's bare repository."""

    def __init__(self, path: Path, config: dict):
        self.root = path
        self.config = config

    def git(self, *args: str, input: bytes | str | None = None, check: bool = True) -> Result:
        return run(["git", "-C", str(self.root), *args], input=input, check=check,
                   env={**os.environ, **GIT_IDENTITY})

    def build(self) -> str:
        """Copy the deployment code and static pages under test, add the fixture modules and commit."""
        self.root.mkdir(parents=True)
        for folder in FIXTURE["copy"]:
            listed = run(["git", "-C", str(CHECKOUT), "ls-files", "-z", "--cached", "--others", "--exclude-standard",
                          "--", folder]).out.split("\0")
            for name in filter(None, listed):
                source = CHECKOUT / name
                if not source.is_file() or source.is_relative_to(E2E):
                    continue
                target = self.root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, target)
        self.write("jomaa-deploy/config.json", json.dumps(self.config, indent=2) + "\n")
        for template in templates():
            self.add_module(template)
        shutil.copyfile(TEMPLATES / GITIGNORE_TEMPLATE, self.root / ".gitignore")
        self.git("init", "-q", "-b", "main")
        return self.commit("Fixture repository")

    def path(self, rel: str) -> Path:
        return self.root / rel

    def read(self, rel: str) -> str:
        return self.path(rel).read_text()

    def write(self, rel: str, content: str) -> None:
        target = self.path(rel)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)

    def remove(self, rel: str) -> None:
        target = self.path(rel)
        if target.is_dir() and not target.is_symlink():
            shutil.rmtree(target)
        else:
            target.unlink()

    def exists(self, rel: str) -> bool:
        return self.path(rel).exists()

    def behavior(self, folder: str) -> dict:
        return json.loads(self.read(f"{folder}/{BEHAVIOR}"))

    def set_behavior(self, folder: str, **changes: object) -> dict:
        """Change keys of a module's behavior.json: version, build, start, health, rollbackNeeds."""
        behavior = {**self.behavior(folder), **changes}
        self.write(f"{folder}/{BEHAVIOR}", json.dumps(behavior) + "\n")
        return behavior

    def declaration(self, folder: str) -> dict:
        return json.loads(self.read(f"{folder}/{DECLARATION}"))

    def set_declaration(self, folder: str, declaration: dict) -> None:
        self.write(f"{folder}/{DECLARATION}", json.dumps(declaration, indent=2) + "\n")

    def update_declaration(self, folder: str, **changes: object) -> dict:
        declaration = {**self.declaration(folder), **changes}
        self.set_declaration(folder, declaration)
        return declaration

    def add_module(self, folder: str, template: str | None = None, **changes: object) -> None:
        """Copy a fixture template folder, with app.py when it has behavior.json, and change its declaration.

        A copy under another folder name gets its state paths moved into the new folder.
        """
        source = TEMPLATES / (template or folder)
        shutil.copytree(source, self.path(folder))
        if (source / BEHAVIOR).exists():
            shutil.copyfile(TEMPLATES / APP, self.path(f"{folder}/{APP}"))
        if template is not None and template != folder:
            declaration = self.declaration(folder)
            text = json.dumps(declaration).replace(f'"{template}/', f'"{folder}/').replace(
                f"{{release}}/{template}/", f"{{release}}/{folder}/")
            self.set_declaration(folder, json.loads(text))
        if changes:
            self.update_declaration(folder, **changes)

    def remove_module(self, folder: str) -> None:
        self.remove(folder)

    def commit(self, message: str) -> str:
        self.git("add", "-A")
        self.git("commit", "-q", "--allow-empty", "-m", message)
        return self.head

    @property
    def head(self) -> str:
        return self.git("rev-parse", "HEAD").out.strip()

    def show(self, sha: str, rel: str) -> str | None:
        result = self.git("show", f"{sha}:{rel}", check=False)
        return result.out if result.code == 0 else None

    def archive(self, sha: str) -> bytes:
        return subprocess.run(["git", "-C", str(self.root), "archive", "--format=tar", sha], check=True,
                              capture_output=True, timeout=TIMEOUTS["execSeconds"]).stdout

    def state_paths(self) -> list[str]:
        paths = []
        for declaration in sorted(self.root.glob(f"*/{DECLARATION}")):
            if (declaration.parent / engine.ENTRY).is_file():
                paths += json.loads(declaration.read_text()).get("state", [])
        return paths


class Harness:
    """One compose project: jerry, the fakes and the Actions runner, and the fixture repository."""

    def __init__(self, suite: str):
        self.suite = suite
        self.project = f"{CONFIG['project']}-{re.sub(r'[^a-z0-9]', '', suite.lower())}-{secrets.token_hex(3)}"
        self.work = Path(tempfile.mkdtemp(prefix=f"{self.project}-"))
        self.settings = fixture_settings()
        self.repo = FixtureRepo(self.work / "repo", self.settings)
        self.fakes: Fakes | None = None
        self.token = secrets.token_hex(24)
        self.tunnel_id = str(uuid.uuid4())
        self.secret: str | None = None
        self.runs: dict[str, tuple[int, int]] = {}
        self.next_run = 1000
        self.last_notify: NotifyResult | None = None
        self.last_result: dict | None = None
        self.actions_checkouts: set[str] = set()
        self.executor = ThreadPoolExecutor()
        self.started = False
        home = JERRY["home"]
        self.deploy_dir = self.settings["deployDirectory"].replace("~", home, 1)
        self.unit_dir = self.settings["unitDirectory"].replace("~", home, 1)
        self.checkout = JERRY["checkout"]
        self.native = f"{self.checkout}/{self.settings['tunnel']['directory']}"
        self.bare = f"{JERRY['gitRoot']}/{FIXTURE['repo']}.git"
        self.matrices: dict[str, list[str]] = {}
        self.containers: dict[str, str] = {}

    # Compose project

    def compose_env(self) -> dict[str, str]:
        return {**os.environ,
                "E2E_JERRY_IMAGE": CONFIG["image"]["tag"],
                "E2E_PYTHON_IMAGE": CONFIG["image"]["python"],
                "E2E_WEBHOOK_HOST": FIXTURE["webhookHostname"],
                "E2E_FAKES_PORT": str(FAKES["port"]),
                "E2E_FAKES_HANG_SECONDS": str(FAKES["hangSeconds"]),
                "E2E_FAKES_CLOUDFLARE_PATH": FAKES["cloudflarePath"],
                "E2E_GITHUB_HOST": FAKES["githubHost"],
                "E2E_CLOUDFLARE_HOST": FAKES["cloudflareHost"],
                "E2E_ACTIONS_CA": CONFIG["actions"]["caFile"]}

    def compose(self, *args: str, check: bool = True, input: bytes | str | None = None,
                timeout: float | None = None) -> Result:
        return run(["docker", "compose", "-p", self.project, "-f", str(E2E / "compose.yaml"), *args],
                   check=check, input=input, timeout=timeout, env=self.compose_env())

    def build_image(self) -> None:
        tunnel = DEPLOY_CONFIG["tunnel"]
        cloudflared = (f"{DEPLOY_CONFIG['github']['remote']}/{tunnel['cloudflaredRepository']}/releases/download/"
                       f"{tunnel['cloudflaredVersion']}/{ASSET_PREFIX}")
        args = {"BASE_IMAGE": CONFIG["image"]["base"], "NODE_VERSION": CONFIG["image"]["nodeVersion"],
                "NODE_DIST": CONFIG["image"]["nodeDist"], "CLOUDFLARED_URL": cloudflared,
                "CLOUDFLARED_PATH": JERRY["cloudflared"], "JERRY_USER": JERRY["user"],
                "JERRY_UID": str(JERRY["uid"]), "GIT_ROOT": JERRY["gitRoot"],
                "EDGE_DIRECTORY": JERRY["edgeDirectory"], "EDGE_CONFIG_ENV": WRAPPER.EDGE_ENV,
                "EDGE_CONFIG": self.edge_config}
        context = self.work / "context"
        context.mkdir(exist_ok=True)
        command = ["docker", "build", "-q", "-t", CONFIG["image"]["tag"], "-f", str(E2E / "Dockerfile")]
        for key, value in args.items():
            command += ["--build-arg", f"{key}={value}"]
        run([*command, str(context)], timeout=TIMEOUTS["buildSeconds"])

    @property
    def dns_target(self) -> str:
        """The CNAME content of this tunnel's DNS records."""
        return routing.DNS(None, self.tunnel_id).target

    @property
    def edge_config(self) -> str:
        return f"{JERRY['edgeDirectory']}/{EDGE_FILE}"

    def up(self) -> None:
        """Build the image, start the project, wait for systemd and prepare the edge, fakes and git remote."""
        self.build_image()
        self.started = True
        self.compose("up", "-d", "--quiet-pull", timeout=TIMEOUTS["buildSeconds"])
        self.wait_ready()
        port = self.compose("port", "fakes", str(FAKES["port"])).out.strip().rsplit(":", 1)[1]
        self.fakes = Fakes(f"http://127.0.0.1:{port}")
        wait_for(self.fakes_ready, TIMEOUTS["bootSeconds"], "the fakes did not answer")
        self.fakes.control(token=self.token)
        self.setup_edge()
        self.exec_as_jerry("git", "init", "-q", "--bare", "-b", "main", self.bare)
        self.repo.build()
        self.push()

    def fakes_ready(self) -> bool:
        try:
            self.fakes.state()
            return True
        except (OSError, ValueError):
            return False

    def down(self) -> None:
        if self.started:
            self.started = False
            self.compose("down", "-v", "--remove-orphans", "-t", "0", check=False)
        self.executor.shutdown(wait=False, cancel_futures=True)
        shutil.rmtree(self.work, ignore_errors=True)

    def wait_ready(self) -> None:
        """Wait for jerry's systemd and the deployment user's manager."""
        def system() -> bool:
            state = self.exec("jerry", "systemctl", "is-system-running", check=False).out.strip()
            return state in ("running", "degraded")

        def user() -> bool:
            state = self.systemctl_user("is-system-running").out.strip()
            return state in ("running", "degraded")

        wait_for(system, TIMEOUTS["bootSeconds"], "jerry's systemd did not finish starting")
        wait_for(user, TIMEOUTS["bootSeconds"], f"the user manager of {JERRY['user']} did not start")

    def container(self, service: str) -> str:
        if service not in self.containers:
            self.containers[service] = self.compose("ps", "-q", service).out.strip()
        return self.containers[service]

    def exec(self, service: str, *command: str, user: str | None = None, env: dict[str, str] | None = None,
             input: bytes | str | None = None, check: bool = True, timeout: float | None = None,
             cwd: str | None = None) -> Result:
        args = ["exec", "-T"]
        if user:
            args += ["-u", user]
        for key, value in (env or {}).items():
            args += ["-e", f"{key}={value}"]
        if cwd:
            args += ["-w", cwd]
        return self.compose(*args, service, *command, check=check, input=input, timeout=timeout)

    def jerry_env(self) -> dict[str, str]:
        runtime = f"/run/user/{JERRY['uid']}"
        return {"HOME": JERRY["home"], "USER": JERRY["user"], "LOGNAME": JERRY["user"],
                "XDG_RUNTIME_DIR": runtime, "DBUS_SESSION_BUS_ADDRESS": f"unix:path={runtime}/bus",
                WRAPPER.EDGE_ENV: self.edge_config}

    def exec_as_jerry(self, *command: str, input: bytes | str | None = None, check: bool = True,
                      timeout: float | None = None, cwd: str | None = None, env: dict[str, str] | None = None
                      ) -> Result:
        return self.exec("jerry", *command, user=JERRY["user"], env={**self.jerry_env(), **(env or {})},
                         input=input, check=check, timeout=timeout, cwd=cwd)

    def exec_root(self, *command: str, input: bytes | str | None = None, check: bool = True,
                  timeout: float | None = None) -> Result:
        return self.exec("jerry", *command, input=input, check=check, timeout=timeout)

    def systemctl_user(self, *args: str, check: bool = False) -> Result:
        return self.exec_as_jerry("systemctl", "--user", *args, check=check)

    def unit_property(self, unit: str, name: str) -> str:
        """One property of a user unit, such as ExecMainStartTimestamp or ActiveState."""
        return self.systemctl_user("show", "-p", name, "--value", unit, check=True).out.strip()

    def unit_active(self, unit: str) -> bool:
        return self.systemctl_user("is-active", unit).out.strip() == "active"

    def processes(self, pattern: str) -> list[int]:
        """PIDs of the deployment user's processes whose command line matches pattern."""
        found = self.exec_root("pgrep", "-u", JERRY["user"], "-f", pattern, check=False).out.split()
        return [int(pid) for pid in found]

    def kill_activation(self, signal: str = "KILL", timeout: float | None = None) -> list[int]:
        """Wait for the running `deploy.py activate` child and send it signal."""
        pids = wait_for(lambda: self.processes("deploy.py activate"), timeout or TIMEOUTS["execSeconds"],
                        "no activation is running")
        self.exec_root("kill", f"-{signal}", *map(str, pids), check=False)
        return pids

    def kill_receiver(self, signal: str = "KILL") -> None:
        self.systemctl_user("kill", "-s", signal, self.settings["receiverUnit"], check=True)

    def restart_jerry(self) -> None:
        """Reboot jerry: restart the container and wait for systemd and the user manager."""
        self.compose("restart", "jerry", timeout=TIMEOUTS["bootSeconds"])
        self.wait_ready()

    # Files on jerry

    def deploy_path(self, rel: str = "") -> str:
        return f"{self.deploy_dir}/{rel}" if rel else self.deploy_dir

    def source_path(self, rel: str = "") -> str:
        return f"{self.checkout}/{rel}" if rel else self.checkout

    def read_file(self, path: str) -> str | None:
        """A file on jerry by absolute path, or None when it does not exist."""
        result = self.exec_as_jerry("cat", path, check=False)
        return result.out if result.code == 0 else None

    def read(self, rel: str) -> str | None:
        """A file in the deployment directory, or None when it does not exist."""
        return self.read_file(self.deploy_path(rel))

    def read_json(self, rel: str) -> object:
        text = self.read(rel)
        return None if text is None else json.loads(text)

    def exists(self, path: str) -> bool:
        return self.exec_as_jerry("test", "-e", path, check=False).code == 0

    def listdir(self, path: str) -> list[str]:
        result = self.exec_as_jerry("ls", "-A", path, check=False)
        return result.out.split() if result.code == 0 else []

    def resolve(self, path: str) -> str | None:
        """Where a path on jerry resolves to, or None when it does not exist."""
        result = self.exec_as_jerry("readlink", "-e", path, check=False)
        return result.out.strip() if result.code == 0 else None

    def write_file(self, path: str, content: str) -> None:
        self.exec_as_jerry("sh", "-c", 'mkdir -p "$(dirname "$1")" && cat > "$1"', "sh", path, input=content)

    def remove_file(self, path: str) -> None:
        self.exec_as_jerry("rm", "-rf", path)

    def record(self, name: str) -> dict | None:
        return self.read_json(f"modules/{name}/{engine.RECORD}")

    def stored_result(self, sha: str, run_id: int, attempt: int) -> dict | None:
        return self.read_json(f"results/{result_name(sha, run_id, attempt)}")

    # Edge certificate and settings

    def setup_edge(self) -> None:
        """Create a test CA and the edge certificate on jerry, the edge settings, and trust the CA in actions."""
        host = FIXTURE["webhookHostname"]
        parent = host.split(".", 1)[1]
        days = str(CONFIG["edge"]["certificateDays"])
        script = """set -e
cd "$1"
printf '[req]\\ndistinguished_name=dn\\nx509_extensions=ext\\nprompt=no\\n[dn]\\nCN=jomaa-e2e-ca\\n[ext]\\n%s\\n%s\\n%s\\n' \\
  'basicConstraints=critical,CA:TRUE' 'keyUsage=critical,keyCertSign,cRLSign' 'subjectKeyIdentifier=hash' > ca.cnf
printf '[req]\\ndistinguished_name=dn\\nprompt=no\\n[dn]\\nCN=%s\\n' "$2" > leaf.cnf
printf '%s\\n' "subjectAltName=DNS:$2,DNS:*.$3,DNS:$3" 'basicConstraints=CA:FALSE' \\
  'keyUsage=critical,digitalSignature,keyEncipherment' 'extendedKeyUsage=serverAuth' \\
  'subjectKeyIdentifier=hash' 'authorityKeyIdentifier=keyid' > leaf.ext
openssl req -x509 -config ca.cnf -newkey rsa:2048 -nodes -keyout ca.key -out "$5" -days "$4" 2>/dev/null
openssl req -new -config leaf.cnf -newkey rsa:2048 -nodes -keyout "$7" -out leaf.csr 2>/dev/null
openssl x509 -req -in leaf.csr -CA "$5" -CAkey ca.key -CAcreateserial -extfile leaf.ext -days "$4" -out "$6" 2>/dev/null
rm -f ca.key ca.cnf leaf.cnf leaf.ext leaf.csr ca.srl
chown "$8" "$6" "$7"
chmod 600 "$7"
"""
        self.exec_root("sh", "-c", script, "sh", JERRY["edgeDirectory"], host, parent, days, CA_FILE,
                       CERTIFICATE_FILE, KEY_FILE, JERRY["user"])
        edge = {"cloudflared": JERRY["cloudflared"], "certificate": f"{JERRY['edgeDirectory']}/{CERTIFICATE_FILE}",
                "key": f"{JERRY['edgeDirectory']}/{KEY_FILE}", "port": CONFIG["edge"]["port"],
                "originTimeoutSeconds": CONFIG["edge"]["originTimeoutSeconds"]}
        self.exec_root("sh", "-c", 'cat > "$1"', "sh", self.edge_config, input=json.dumps(edge))
        ca = self.exec_root("cat", f"{JERRY['edgeDirectory']}/{CA_FILE}").out
        self.exec("actions", "sh", "-c", 'mkdir -p "$(dirname "$1")" && cat > "$1"', "sh",
                  CONFIG["actions"]["caFile"], input=ca)

    # Git remote, checkout and installation

    def push(self, force: bool = False, ref: str = "main", commit: str = "HEAD") -> Result:
        """Push a commit of the fixture repository to a branch of jerry's bare repository."""
        remote = f"ext::docker exec -i -u {JERRY['user']} {self.container('jerry')} %s {self.bare}"
        args = ["-c", "protocol.ext.allow=always", "push", "-q"]
        if force:
            args.append("--force")
        return self.repo.git(*args, remote, f"{commit}:refs/heads/{ref}")

    def prepare_checkout(self) -> None:
        """Clone main into jerry's checkout and add the untracked state: the environment file with the
        Cloudflare token, the state paths, the tunnel configuration and its credentials file."""
        if not self.exists(self.checkout):
            self.exec_as_jerry("git", "clone", "-q", self.bare, self.checkout)
        password = secrets.token_urlsafe(self.settings["hubPasswordMinLength"])
        self.write_file(self.source_path(self.settings["cloudflare"]["env"]),
                        f"HUB_PASSWORD={password}\nCLOUDFLARE_API_TOKEN={self.token}\n")
        for path in self.repo.state_paths():
            self.exec_as_jerry("mkdir", "-p", self.source_path(path))
        credentials = f"{JERRY['home']}/.cloudflared/{self.tunnel_id}.json"
        self.write_file(credentials, json.dumps({"AccountTag": secrets.token_hex(16), "TunnelID": self.tunnel_id,
                                                 "TunnelSecret": secrets.token_urlsafe(32)}))
        self.write_file(f"{self.native}/tunnel.yml",
                        f'tunnel: "{self.tunnel_id}"\ncredentials-file: "{credentials}"\n'
                        "ingress:\n  - service: http_status:404\n")

    def install(self, *args: str, check: bool = False) -> Result:
        """Run deploy.py install as the deployment user in the checkout and record the activation it printed."""
        result = self.exec_as_jerry("python3", "jomaa-deploy/deploy.py", "install", "--repo", FIXTURE["repo"], *args,
                                    cwd=self.checkout, check=check)
        printed = self.printed_activation(result.out)
        if printed is not None:
            self.last_result = printed
        return result

    @staticmethod
    def printed_activation(output: str) -> dict | None:
        start = output.find("{\n")
        if start < 0:
            return None
        try:
            value, _ = json.JSONDecoder().raw_decode(output[start:])
        except json.JSONDecodeError:
            return None
        return value if isinstance(value, dict) and "status" in value else None

    def ensure_installed(self) -> None:
        """Install the fixture repository's main on jerry once."""
        if self.exists(self.deploy_path("current")):
            return
        self.prepare_checkout()
        result = self.install()
        if result.code:
            raise AssertionError(f"installation failed:\n{result.output}")

    def webhook_secret(self) -> str:
        if self.secret is None:
            secret = self.read(SECRET_FILE)
            if secret is None:
                raise AssertionError("the deployment receiver has no webhook secret; install first")
            self.secret = secret.strip()
        return self.secret

    # Workflow runs and notify.py

    def matrix(self, sha: str) -> list[str]:
        """Modules with checks at a revision, as the workflow's modules job lists them."""
        if sha not in self.matrices:
            folder = Path(tempfile.mkdtemp(dir=self.work, prefix="matrix-"))
            subprocess.run(["tar", "-x", "-C", str(folder)], input=self.repo.archive(sha), check=True)
            listed = run([sys.executable, str(folder / "jomaa-deploy/deploy.py"), "modules", "--json"],
                         env={**os.environ, "JOMAA_DEPLOY_SOURCE": str(folder)}, check=False)
            self.matrices[sha] = json.loads(listed.out) if listed.code == 0 else []
            shutil.rmtree(folder, ignore_errors=True)
        return self.matrices[sha]

    def default_jobs(self, sha: str) -> dict[str, str | None]:
        """Every job of a successful workflow run at a revision, with deploy still running."""
        jobs: dict[str, str | None] = {VERIFY_JOB: "success", **WORKFLOW_JOBS}
        jobs.update({check_job(name): "success" for name in self.matrix(sha)})
        return jobs

    def new_run(self) -> int:
        self.next_run += 1
        return self.next_run

    def run_json(self, run_id: int, sha: str, attempt: int) -> dict:
        return {"id": run_id, "event": "push", "head_branch": "main", "head_sha": sha, "path": WORKFLOW_PATH,
                "run_attempt": attempt, "repository": {"full_name": FIXTURE["repo"]}, "status": "in_progress",
                "conclusion": None}

    def prepare_run(self, sha: str, run_id: int | None, attempt: int | None, jobs: dict | None,
                    run: dict | None) -> tuple[int, int]:
        """Set the fake workflow run and its attempt's jobs; jobs and run change the defaults, None removes."""
        if run_id is None:
            run_id = self.new_run()
        attempt = attempt or 1
        self.runs[sha] = (run_id, attempt)
        self.fakes.set_run(run_id, {**self.run_json(run_id, sha, attempt), **(run or {})})
        listed = self.default_jobs(sha)
        for name, value in (jobs or {}).items():
            if value is None:
                listed.pop(name, None)
            else:
                listed[name] = value
        self.fakes.set_jobs(run_id, attempt, listed)
        return run_id, attempt

    def checkout_in_actions(self, sha: str) -> str:
        """The revision checked out in the actions container, as actions/checkout leaves it."""
        folder = f"{CONFIG['actions']['checkouts']}/{sha}"
        if sha not in self.actions_checkouts:
            self.exec("actions", "sh", "-c", 'mkdir -p "$1" && tar -x -C "$1"', "sh", folder,
                      input=self.repo.archive(sha))
            self.actions_checkouts.add(sha)
        return folder

    def webhook_url(self) -> str | None:
        """JOMAA_DEPLOY_URL for notify.py when the edge does not listen on the HTTPS port."""
        port = CONFIG["edge"]["port"]
        return None if port == HTTPS_PORT else f"https://{FIXTURE['webhookHostname']}:{port}{settings.WEBHOOK_PATH}"

    def notify(self, sha: str | None = None, run_id: int | None = None, attempt: int | None = None, *,
               jobs: dict[str, str | None] | None = None, run: dict | None = None, secret: str | None = None,
               env: dict[str, str] | None = None, prepare: bool = True) -> NotifyResult:
        """Run the real notify.py in the actions container for a workflow run attempt.

        sha defaults to the fixture head, run_id to a new run and attempt to 1. The fake run and its jobs
        are set first unless prepare is False; jobs and run override the defaults.
        """
        sha = sha or self.repo.head
        if prepare:
            run_id, attempt = self.prepare_run(sha, run_id, attempt, jobs, run)
        elif run_id is None or attempt is None:
            raise ValueError("notify without prepare needs run_id and attempt")
        folder = self.checkout_in_actions(sha)
        variables = {"GITHUB_REPOSITORY": FIXTURE["repo"], "GITHUB_SHA": sha, "GITHUB_RUN_ID": str(run_id),
                     "GITHUB_RUN_ATTEMPT": str(attempt), "JOMAA_DEPLOY_SECRET": secret or self.webhook_secret()}
        if self.webhook_url():
            variables["JOMAA_DEPLOY_URL"] = self.webhook_url()
        notify = self.settings["notify"]
        timeout = notify["deadlineSeconds"] + notify["requestTimeoutSeconds"] + TIMEOUTS["notifyMarginSeconds"]
        result = self.exec("actions", "python3", f"{folder}/jomaa-deploy/notify.py", env={**variables, **(env or {})},
                           check=False, timeout=timeout)
        parsed = NotifyResult.parse(result, sha, run_id, attempt)
        self.last_notify = parsed
        if parsed.status in REPORTED:
            stored = self.stored_result(sha, run_id, attempt)
            if stored is not None:
                self.last_result = stored
        return parsed

    def start_notify(self, *args, **kwargs) -> Future:
        """notify() in the background; the future's result() is its NotifyResult."""
        return self.executor.submit(self.notify, *args, **kwargs)

    def signed_request(self, sha: str, run_id: int, attempt: int, *, repo: str | None = None,
                       timestamp: int | None = None, secret: str | None = None) -> tuple[bytes, str]:
        """A deployment request body and its signature, as notify.py signs it."""
        payload = {"repo": repo or FIXTURE["repo"], "sha": sha, "run_id": run_id, "attempt": attempt,
                   "timestamp": int(time.time()) if timestamp is None else timestamp}
        body = json.dumps(payload, separators=(",", ":")).encode()
        key = (secret or self.webhook_secret()).encode()
        return body, "sha256=" + hmac.new(key, body, hashlib.sha256).hexdigest()

    def edge_request(self, host: str, path: str, method: str = "GET", body: bytes = b"",
                     headers: dict[str, str] | None = None) -> tuple[int | None, str]:
        """An HTTPS request through the edge from the actions container, with host as the Host header."""
        script = """import http.client, json, ssl, sys
connect, port, host, path, method, headers, timeout = sys.argv[1:8]
body = sys.stdin.buffer.read()
try:
    connection = http.client.HTTPSConnection(connect, int(port), context=ssl.create_default_context(),
                                             timeout=float(timeout))
    connection.request(method, path, body=body or None, headers={"Host": host, **json.loads(headers)})
    response = connection.getresponse()
    print(json.dumps({"status": response.status, "body": response.read().decode(errors="replace")}))
except OSError as error:
    print(json.dumps({"status": None, "body": f"{type(error).__name__}: {error}"}))
"""
        result = self.exec("actions", "python3", "-c", script, FIXTURE["webhookHostname"],
                           str(CONFIG["edge"]["port"]), host, path, method, json.dumps(headers or {}),
                           str(self.settings["notify"]["requestTimeoutSeconds"]), input=body,
                           timeout=self.settings["notify"]["requestTimeoutSeconds"] + TIMEOUTS["notifyMarginSeconds"])
        answer = json.loads(result.out)
        return answer["status"], answer["body"]

    def wait_edge(self, host: str, path: str = "/", status: int = 200, timeout: float | None = None) -> str:
        """Wait until a GET through the edge answers status, and return its body."""
        def answered() -> str | None:
            code, body = self.edge_request(host, path)
            return body if code == status else None

        return wait_for(answered, timeout or TIMEOUTS["bootSeconds"], f"https://{host}{path} did not answer {status}")

    def post_raw(self, body: bytes, signature: str | None = None,
                 headers: dict[str, str] | None = None) -> tuple[int | None, str]:
        """POST a body to the receiver URL through the edge, with an optional X-Jomaa-Signature."""
        sent = {"Content-Type": "application/json", **({"X-Jomaa-Signature": signature} if signature else {}),
                **(headers or {})}
        return self.edge_request(FIXTURE["webhookHostname"], settings.WEBHOOK_PATH, "POST", body, sent)

    def http(self, url: str, host: str | None = None) -> tuple[int | None, str]:
        """A GET from inside jerry, such as a service origin, with an optional Host header."""
        script = """import json, sys, urllib.error, urllib.request
url, host, timeout = sys.argv[1:4]
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
try:
    with opener.open(urllib.request.Request(url, headers={"Host": host} if host else {}), timeout=float(timeout)) as r:
        print(json.dumps({"status": r.status, "body": r.read().decode(errors="replace")}))
except urllib.error.HTTPError as error:
    print(json.dumps({"status": error.code, "body": error.read().decode(errors="replace")}))
except OSError as error:
    print(json.dumps({"status": None, "body": f"{type(error).__name__}: {error}"}))
"""
        result = self.exec_as_jerry("python3", "-c", script, url, host or "", str(TIMEOUTS["httpSeconds"]))
        answer = json.loads(result.out)
        return answer["status"], answer["body"]

    def version(self, folder: str) -> str | None:
        """The version a fixture service answers on / at its origin."""
        status, body = self.http(self.repo.declaration(folder)["origin"] + "/")
        try:
            return json.loads(body)["version"] if status == 200 else None
        except (ValueError, KeyError):
            return None

    # The oracle

    def probe(self) -> dict:
        spec = {"deploy": self.deploy_dir, "source": self.checkout,
                "tunnelDirectory": self.settings["tunnel"]["directory"],
                "webhookHost": FIXTURE["webhookHostname"], "webhookPath": settings.WEBHOOK_PATH,
                "recordFile": engine.RECORD, "siteMap": self.settings["siteMap"], "ingressFile": INGRESS_FILE,
                "timeout": TIMEOUTS["httpSeconds"], "validateTimeout": self.settings["tunnel"]["validateTimeoutSeconds"]}
        result = self.exec_as_jerry("python3", "-", json.dumps(spec), input=(E2E / "probe.py").read_text())
        return json.loads(result.out)

    def committed_version(self, revision: str, directory: str) -> str | None:
        text = self.repo.show(revision, f"{directory}/{BEHAVIOR}")
        return None if text is None else json.loads(text)["version"]

    def invariants(self) -> None:
        """Check the section 4 oracle of the design; raise AssertionError listing every violation."""
        facts = self.probe()
        problems: list[str] = []
        live: list[dict] = []
        for name, record in facts["records"].items():
            if not isinstance(record, dict) or "unreadable" in record:
                problems.append(f"modules/{name}/{engine.RECORD} does not parse: {record}")
                continue
            if record.get("declaration") is not None:
                live.append(record)
            if record.get("failed"):
                continue
            revision = record.get("revision")
            current = facts["pointers"][name]["current"]
            if current != f"releases/{revision}":
                problems.append(f"{name}: modules/{name}/current resolves to {current}, not releases/{revision}")
            if facts["releases"].get(revision) != revision:
                problems.append(f"{name}: releases/{revision}/.revision is {facts['releases'].get(revision)!r}")
        for record in live:
            if record["kind"] != "Service":
                continue
            declaration = record["declaration"]
            unit = declaration["unit"]
            if facts["units"].get(unit) != "active":
                problems.append(f"{record['name']}: unit {unit} is {facts['units'].get(unit)!r}, not active")
            health = facts["health"].get(record["name"], {})
            try:
                answer = json.loads(health.get("body") or "")
            except ValueError:
                answer = None
            expected = declaration["health"]["json"]
            if health.get("status") != 200 or not isinstance(answer, dict) or any(
                    answer.get(k) != v for k, v in expected.items()):
                problems.append(f"{record['name']}: health check {declaration['health']['path']} answered "
                                f"{health.get('status')} {health.get('body')!r}, expected 200 with {expected}")
                continue
            version = self.committed_version(record["revision"], record["directory"]) if record["revision"] else None
            if version is not None and answer.get("version") != version:
                problems.append(f"{record['name']}: answers version {answer.get('version')!r}, but "
                                f"{record['revision'][:12]} committed {version!r}")
        sites = facts["sites"] if isinstance(facts["sites"], dict) else {}
        expected_sites = {r["name"]: f"{self.deploy_dir}/releases/{r['revision']}/{r['directory']}/{r['name']}"
                          for r in live if r["kind"] == "StaticSite" and r.get("revision")}
        if set(sites) != set(expected_sites):
            problems.append(f"{self.settings['siteMap']} lists {sorted(sites)}, live sites are {sorted(expected_sites)}")
        for host, folder in sites.items():
            answer = facts["siteAnswers"].get(host, {})
            if host in expected_sites and folder != expected_sites[host]:
                problems.append(f"site {host} is served from {folder}, not {expected_sites[host]}")
            if not answer.get("folderExists"):
                problems.append(f"site {host}: folder {folder} does not exist")
            if answer.get("status") != 200:
                problems.append(f"site {host}: / answered {answer.get('status')} {answer.get('body', '')[:200]!r}")
        if facts["validate"]["code"] != 0:
            problems.append(f"tunnel.yml fails cloudflared ingress validate: {facts['validate']['output']}")
        modules = []
        for record in live:
            try:
                modules.append(KINDS[record["kind"]].from_record(record))
            except (KeyError, TypeError, ValueError) as error:
                problems.append(f"{record['name']}: the live declaration does not load: {error}")
        routes, _ = ingress.ordered_routes(modules, self.settings)
        for host, path, origin in ingress.rules(routes, self.settings)[1]:
            service = facts["rules"].get(f"{host} {path}")
            if service != origin:
                problems.append(f"route https://{host}{path} reaches {service!r} with cloudflared ingress rule, "
                                f"not {origin}")
        hosts = set((facts["ingress"] or {}).get("hosts", []))
        managed = {r["name"] for r in self.fakes.records() if r.get("comment") == routing.DNS_COMMENT}
        failed = {h for h, s in ((self.last_result or {}).get("ingress") or {}).get("dns", {}).items()
                  if s == "failed"}
        if managed - failed != hosts - failed:
            problems.append(f"managed DNS records {sorted(managed - failed)} differ from {INGRESS_FILE} hosts "
                            f"{sorted(hosts - failed)} (failed hosts {sorted(failed)} excluded)")
        revision = facts["currentRevision"]
        if revision is None or facts["current"] != f"releases/{revision}":
            problems.append(f"current resolves to {facts['current']} with .revision {revision!r}")
        if not facts["lockFree"]:
            problems.append("deploy.lock is held")
        for name, value in facts["releases"].items():
            if value != name:
                problems.append(f"releases/{name} has .revision {value!r}")
        notified = self.last_notify
        if notified is not None and notified.status in REPORTED:
            stored = facts["results"].get(result_name(notified.sha, notified.run_id, notified.attempt))
            if stored is None:
                problems.append(f"notify.py printed {notified.status} but results/"
                                f"{result_name(notified.sha, notified.run_id, notified.attempt)} does not exist")
            elif stored.get("status") != notified.status or (notified.status == "partial" and (
                    stored.get("modules") != notified.modules or stored.get("ingress") != notified.ingress)):
                problems.append(f"notify.py printed {notified.status} {notified.modules} {notified.ingress}, "
                                f"the stored result is {stored}")
        if problems:
            raise AssertionError("invariants violated:\n  " + "\n  ".join(problems))

    def converge(self, jobs: dict[str, str | None] | None = None, force: bool = False) -> NotifyResult:
        """Clear the faults, push the fixture head and start a new attempt of its run; it must report deployed."""
        self.fakes.clear_faults()
        self.push(force=force)
        sha = self.repo.head
        run_id, attempt = self.runs.get(sha, (None, 0))
        result = self.notify(sha, run_id, attempt + 1 if run_id else None, jobs=jobs)
        if result.status != "deployed":
            raise AssertionError(f"convergence reported {result.status}, exit {result.code}:\n{result.output}")
        self.invariants()
        return result

    def begin_test(self) -> None:
        self.last_notify = None

    # Failure artifacts

    def collect_artifacts(self, destination: Path) -> None:
        """Journals, the deployment directory and units, tunnel files, compose logs and the fakes state."""
        destination.mkdir(parents=True, exist_ok=True)
        tree = (f"find {shlex.quote(self.deploy_dir)} {shlex.quote(self.unit_dir)} {shlex.quote(self.native)} "
                "-printf '%M %u %10s %TY-%Tm-%Td %TH:%TM:%TS %p %l\\n'")
        commands = {
            "journal.txt": lambda: self.exec_root("journalctl", "--no-pager", "-o", "short-precise",
                                                  check=False).output,
            "user-units.txt": lambda: self.systemctl_user("list-units", "--all", "--no-pager").output,
            "deploy-tree.txt": lambda: self.exec_root("sh", "-c", tree, check=False).output,
            "processes.txt": lambda: self.exec_root("ps", "auxf", check=False).output,
            "compose.txt": lambda: self.compose("logs", "--no-color", "--timestamps", check=False).output,
            "fakes.json": lambda: json.dumps(self.fakes.state(), indent=2) if self.fakes else "",
        }
        for name, collect in commands.items():
            try:
                (destination / name).write_text(collect())
            except Exception as error:  # noqa: BLE001
                (destination / name).write_text(f"could not collect: {type(error).__name__}: {error}\n")
        script = ('tar -C "$1" -cf - --exclude=./releases --exclude=./git-cache . 2>/dev/null; '
                  'exit 0')
        try:
            archive = subprocess.run(["docker", "compose", "-p", self.project, "-f", str(E2E / "compose.yaml"),
                                      "exec", "-T", "jerry", "sh", "-c", script, "sh", self.deploy_dir],
                                     capture_output=True, env=self.compose_env(), timeout=TIMEOUTS["execSeconds"])
            (destination / "deploy-directory.tar").write_bytes(archive.stdout)
        except (OSError, subprocess.SubprocessError) as error:
            (destination / "deploy-directory.tar.txt").write_text(f"could not collect: {error}\n")


_SESSION: Harness | None = None


def session(suite: str | None = None) -> Harness:
    """The compose project of this process, started on first use and stopped at exit."""
    global _SESSION
    if _SESSION is None:
        _SESSION = Harness(suite or Path(sys.argv[0]).stem)
        atexit.register(_SESSION.down)
        _SESSION.up()
    return _SESSION


class E2ETestCase(unittest.TestCase):
    """Base class of scenario tests: self.h is the shared Harness, and the oracle runs after every test.

    Tests of one file share jerry and run in name order. With install = True the fixture main is
    installed before the first test.
    """

    h: Harness
    install = True

    @classmethod
    def setUpClass(cls) -> None:
        cls.h = session()
        if cls.install:
            cls.h.ensure_installed()

    def setUp(self) -> None:
        self.h.begin_test()

    def tearDown(self) -> None:
        self.h.invariants()


class ArtifactResult(unittest.TextTestResult):
    """Collects artifacts of the shared Harness when a test fails or errors."""

    directory: Path

    def collect(self, test: unittest.TestCase) -> None:
        if _SESSION is not None and _SESSION.started:
            name = re.sub(r"[^A-Za-z0-9_.-]", "_", test.id())
            _SESSION.collect_artifacts(self.directory / name)
            self.stream.writeln(f"artifacts: {self.directory / name}")

    def addFailure(self, test, err) -> None:
        super().addFailure(test, err)
        self.collect(test)

    def addError(self, test, err) -> None:
        super().addError(test, err)
        self.collect(test)


def main(argv: list[str]) -> int:
    if len(argv) != 2 or not (E2E / f"scenario_{argv[1]}.py").is_file():
        suites = sorted(p.stem.removeprefix("scenario_") for p in E2E.glob("scenario_*.py"))
        print(f"usage: harness.py SUITE, one of: {', '.join(suites)}", file=sys.stderr)
        return 2
    suite = argv[1]
    sys.path.insert(0, str(E2E))
    scenarios = importlib.import_module(f"scenario_{suite}")
    tests = unittest.defaultTestLoader.loadTestsFromModule(scenarios)
    artifacts = CHECKOUT / CONFIG["artifactDirectory"]
    artifacts.mkdir(parents=True, exist_ok=True)
    (artifacts / ".gitignore").write_text("*\n")
    ArtifactResult.directory = artifacts / suite
    shutil.rmtree(ArtifactResult.directory, ignore_errors=True)
    try:
        try:
            session(suite)
        except BaseException:
            if _SESSION is not None and _SESSION.started:
                _SESSION.collect_artifacts(ArtifactResult.directory / "setup")
                print(f"artifacts: {ArtifactResult.directory / 'setup'}", file=sys.stderr)
            raise
        outcome = unittest.TextTestRunner(verbosity=2, resultclass=ArtifactResult).run(tests)
    finally:
        if _SESSION is not None:
            _SESSION.down()
    return 0 if outcome.wasSuccessful() else 1


if __name__ == "__main__":
    sys.modules["harness"] = sys.modules[__name__]
    sys.exit(main(sys.argv))

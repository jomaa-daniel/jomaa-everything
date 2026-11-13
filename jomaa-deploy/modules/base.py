"""The module contract: declarations, fingerprints and the context modules deploy in."""
from __future__ import annotations

import abc
import hashlib
import hmac
import inspect
import json
import math
import os
import re
import secrets
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit

import settings
from cloudflare_api import Cloudflare

DECLARATION = "deploy.json"
VERIFY_JOB = "verify"
HOSTNAME = re.compile(r"(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}")
NAME = re.compile(r"[a-z0-9][a-z0-9.-]*")
PLACEHOLDER = re.compile(r"\{(release|python|home)\}")


class DeployError(Exception):
    pass


def relative_path(value: object) -> str:
    if (not isinstance(value, str) or not value or Path(value).is_absolute()
            or any(part in ("", ".", "..") or part.startswith(".") for part in value.split("/"))):
        raise ValueError(f"expected a repository-relative path: {value!r}")
    return value


def hostname(value: object) -> str:
    if not isinstance(value, str) or not HOSTNAME.fullmatch(value):
        raise ValueError(f"invalid hostname: {value!r}")
    return value


def local_url(value: object, schemes: tuple[str, ...]) -> str:
    if not isinstance(value, str):
        raise ValueError("origins must be strings")
    parsed = urlsplit(value)
    if (parsed.scheme not in schemes or parsed.hostname not in ("localhost", "127.0.0.1")
            or parsed.username or parsed.password or parsed.fragment or not parsed.port
            or parsed.path or parsed.query):
        raise ValueError(f"expected a loopback origin with a port: {value!r}")
    return value


def command(value: object) -> list[str]:
    if not isinstance(value, list) or not value or any(not isinstance(x, str) or not x or "\n" in x for x in value):
        raise ValueError("commands must be nonempty arrays of arguments")
    for argument in value:
        if re.search(r"\{(?!release\}|python\}|home\})", argument):
            raise ValueError(f"unknown command placeholder: {argument}")
    return value


def commands(value: object, what: str) -> list[list[str]]:
    if not isinstance(value, list):
        raise ValueError(f"{what} must be an array of commands")
    return [command(item) for item in value]


def expand(arguments: list[str], release: Path) -> list[str]:
    values = {"release": str(release), "python": sys.executable, "home": str(Path.home())}
    return [PLACEHOLDER.sub(lambda m: values[m[1]], arg) for arg in arguments]


def routes(value: object) -> list[dict]:
    """Validate route declarations: a hostname, an optional anchored path and probe paths."""
    if not isinstance(value, list):
        raise ValueError("routes must be an array")
    seen = set()
    for route in value:
        if not isinstance(route, dict) or "hostname" not in route or set(route) - {"hostname", "path", "probes"}:
            raise ValueError("routes declare a hostname and optionally a path and probes")
        host = hostname(route["hostname"])
        pattern = route.get("path")
        if pattern is not None:
            if not isinstance(pattern, str) or not pattern.startswith("^") or not pattern.endswith("$"):
                raise ValueError("route paths must be anchored regular expressions")
            re.compile(pattern)
        if (host, pattern) in seen:
            raise ValueError(f"duplicate route: {host} {pattern}")
        seen.add((host, pattern))
        probes = route.get("probes", ["/"] if pattern is None else [])
        if not isinstance(probes, list) or not probes or any(
                not isinstance(p, str) or not p.startswith("/") or "?" in p or "#" in p
                or (pattern is not None and re.search(pattern, p) is None) for p in probes):
            raise ValueError(f"route needs matching probe paths: {host}")
        if host == settings.CONFIG["webhook"]["hostname"] and settings.WEBHOOK_PATH in probes:
            raise ValueError(f"{settings.WEBHOOK_PATH} is reserved for the deployment receiver")
    return value


def switch_link(link: Path, destination: Path) -> None:
    link.parent.mkdir(parents=True, exist_ok=True)
    tmp = link.with_name(link.name + ".new")
    tmp.unlink(missing_ok=True)
    tmp.symlink_to(destination, target_is_directory=True)
    os.replace(tmp, link)


def atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, prefix=".deploy-", delete=False) as file:
        temp = Path(file.name)
        file.write(content)
    try:
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def quote(value: str) -> str:
    return json.dumps(value.replace("%", "%%"))


def unit_text(arguments: list[str], working_directory: Path, environment: dict[str, str]) -> str:
    """A systemd user unit that runs and restarts one command."""
    lines = [f"Environment={quote(f'{key}={value}')}\n" for key, value in environment.items()]
    return ("[Unit]\nDescription=Jomaa deployed service\nAfter=network-online.target\n"
            "[Service]\nType=simple\n" + "".join(lines)
            + f"WorkingDirectory={str(working_directory).replace('%', '%%')}\n"
            f"ExecStart={' '.join(quote(arg) for arg in arguments)}\nRestart=always\nRestartSec=2\n"
            "[Install]\nWantedBy=default.target\n")


def state_key(path: Path, length: int) -> bytes:
    """The private key of state input digests, created with mode 0600 when it is missing."""
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, temp = tempfile.mkstemp(dir=path.parent, prefix=".deploy-")
        try:
            with os.fdopen(fd, "wb") as file:
                file.write(secrets.token_bytes(length))
            try:
                os.link(temp, path)
            except FileExistsError:
                pass
        finally:
            os.unlink(temp)
    if path.stat().st_mode & 0o044:
        raise DeployError(f"{path} is readable by group or others")
    key = path.read_bytes()
    if len(key) < length:
        raise DeployError(f"{path} holds fewer than {length} bytes")
    return key


class SiteMap:
    """The host to directory map that the static server re-reads when it changes."""

    def __init__(self, path: Path):
        self.path = path

    def load(self) -> dict[str, str]:
        return json.loads(self.path.read_text()) if self.path.exists() else {}

    def set(self, host: str, directory: Path | None) -> None:
        sites = self.load()
        if directory is None:
            sites.pop(host, None)
        else:
            sites[host] = str(directory)
        atomic_write(self.path, json.dumps(dict(sorted(sites.items())), indent=2) + "\n")


class Context:
    """Paths, settings, commands and health checks shared by modules during one activation."""

    def __init__(self, source: Path, deploy_dir: Path, release: Path, sha: str, repo: Path,
                 config: dict | None = None, unit_dir: Path | None = None):
        self.source = source
        self.deploy_dir = deploy_dir
        self.release = release
        self.sha = sha
        self.repo = repo
        self.config = config or settings.CONFIG
        self.unit_dir = unit_dir or settings.path(self.config["unitDirectory"])
        self.sites = SiteMap(settings.site_map(deploy_dir))
        self.inventory: dict | None = None
        self.deadline = math.inf
        self.key: bytes | None = None

    def begin(self) -> None:
        """Start the per-module time budget."""
        self.deadline = time.monotonic() + self.config["moduleTimeoutSeconds"]

    def timeout(self, limit: float) -> float:
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("the module ran out of time")
        return min(limit, remaining)

    def run(self, *args: str, cwd: Path | None = None) -> None:
        subprocess.run(args, cwd=cwd, check=True, timeout=self.timeout(self.config["commandTimeoutSeconds"]))

    def systemctl(self, *args: str) -> None:
        self.run("systemctl", "--user", *args)

    def state_key(self) -> bytes:
        if self.key is None:
            self.key = state_key(self.deploy_dir / self.config["stateInputKeyFile"],
                                 self.config["stateInputKeyBytes"])
        return self.key

    def release_of(self, revision: str) -> Path:
        return self.deploy_dir / "releases" / revision

    def pointer(self, name: str) -> Path:
        return self.deploy_dir / "modules" / name / "current"

    def cloudflare(self, token: str) -> Cloudflare:
        return Cloudflare(token, self.config["cloudflare"]["api"], self.config["cloudflare"]["timeoutSeconds"])

    def healthy(self, check: dict) -> bool:
        """One HTTP request: status 200 and, when given, matching JSON fields."""
        try:
            headers = {"User-Agent": self.config["userAgent"]}
            if "host" in check:
                headers["Host"] = check["host"]
            request = urllib.request.Request(check["url"], headers=headers)
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            with opener.open(request, timeout=self.config["healthRequestTimeoutSeconds"]) as response:
                if response.status != 200:
                    return False
                if check.get("json"):
                    result = json.load(response)
                    return isinstance(result, dict) and all(result.get(k) == v for k, v in check["json"].items())
                return True
        except (OSError, ValueError):
            return False

    def wait_healthy(self, check: dict) -> bool:
        deadline = time.monotonic() + self.timeout(self.config["healthWaitSeconds"])
        while True:
            if self.healthy(check):
                return True
            if time.monotonic() >= deadline:
                return False
            time.sleep(1)


def git_object(repo: Path, sha: str, path: str) -> str:
    result = subprocess.run(["git", "-C", str(repo), "rev-parse", "--verify", "--quiet", f"{sha}:{path}"],
                            capture_output=True, text=True, timeout=settings.CONFIG["gitTimeoutSeconds"])
    if result.returncode:
        raise ValueError(f"{path} does not exist at {sha[:12]}")
    return result.stdout.strip()


def tree_entries(repo: Path, sha: str, directory: str) -> list[tuple[str, str]]:
    """(path, object id) of each top-level entry of a folder at a revision."""
    result = subprocess.run(["git", "-C", str(repo), "ls-tree", sha, f"{directory}/"], capture_output=True,
                            text=True, check=True, timeout=settings.CONFIG["gitTimeoutSeconds"])
    entries = [(line.split("\t", 1)[1], line.split()[2]) for line in result.stdout.splitlines()]
    if not entries:
        raise ValueError(f"{directory} does not exist at {sha[:12]}")
    return entries


class Module(abc.ABC):
    """A deployable part of the repository, declared by <directory>/deploy.json.

    Defining a subclass registers it. The engine imports every top-level
    deploy_module.py and instantiates the registered classes defined there.
    """

    registry: list[type[Module]] = []
    kind = "Module"
    phase = 0
    always = False
    job: str | None = None
    keys: tuple[str, ...] = ("name", "inputs", "checks", "state", "stateInputs")

    def __init_subclass__(cls, **kwargs: object) -> None:
        super().__init_subclass__(**kwargs)
        if not inspect.isabstract(cls):
            Module.registry.append(cls)

    def __init__(self, directory: str, declaration: object, root: Path | None = None):
        self.directory = relative_path(directory)
        self.root = root
        self.record: dict | None = None
        if not isinstance(declaration, dict) or set(declaration) != set(self.keys):
            raise ValueError(f"{directory}/{DECLARATION} requires exactly: {', '.join(self.keys)}")
        self.declaration = declaration
        self.validate()

    @classmethod
    def load(cls, root: Path, directory: str) -> Module:
        return cls(directory, json.loads((root / directory / DECLARATION).read_text()), root)

    @classmethod
    def from_record(cls, record: dict) -> Module:
        return cls(record["directory"], record["declaration"])

    @property
    def name(self) -> str:
        return self.declaration["name"]

    @property
    def inputs(self) -> list[str]:
        return self.declaration.get("inputs", [])

    @property
    def checks(self) -> list[list[str]]:
        return self.declaration.get("checks", [])

    @property
    def state(self) -> list[str]:
        return self.declaration.get("state", [])

    @property
    def state_inputs(self) -> list[str]:
        return self.declaration.get("stateInputs", [])

    name_pattern = NAME

    def validate(self) -> None:
        name = self.declaration["name"]
        if not isinstance(name, str) or not self.name_pattern.fullmatch(name):
            raise ValueError(f"invalid module name: {name!r}")
        if "inputs" in self.keys:
            if not isinstance(self.inputs, list):
                raise ValueError("inputs must be an array of paths")
            for path in self.inputs:
                relative_path(path)
        if "checks" in self.keys:
            commands(self.checks, "checks")
        if "state" in self.keys:
            state = self.state
            if not isinstance(state, list) or len(set(map(str, state))) != len(state):
                raise ValueError("state must be a list of unique paths")
            for entry in state:
                if (not isinstance(entry, str) or Path(entry).is_absolute()
                        or any(x in ("", ".", "..") for x in entry.split("/"))
                        or not entry.startswith(self.directory + "/")):
                    raise ValueError(f"state paths must be inside {self.directory}: {entry!r}")
                if any(other != entry and other.startswith(entry + "/") for other in state):
                    raise ValueError("state paths cannot contain one another")
        if "stateInputs" in self.keys:
            files = self.state_inputs
            if not isinstance(files, list) or len(set(map(str, files))) != len(files):
                raise ValueError("stateInputs must be a list of unique paths")
            for entry in files:
                if (not isinstance(entry, str) or Path(entry).is_absolute()
                        or any(x in ("", ".", "..") for x in entry.split("/"))):
                    raise ValueError(f"stateInputs must be repository-relative paths: {entry!r}")

    def paths(self) -> list[str]:
        """Repository paths whose content the module deploys."""
        return [self.directory, *self.inputs]

    def objects(self, repo: Path, sha: str) -> dict[str, str]:
        """Git object ids of the folder's top-level entries, except those its children own, and of inputs."""
        owned = {path for child in self.children() for path in child.paths()}
        ids = {path: oid for path, oid in tree_entries(repo, sha, self.directory) if path not in owned}
        ids.update({path: git_object(repo, sha, path) for path in self.inputs})
        return ids

    def code(self, release: Path) -> dict[str, str]:
        """SHA-256 of each source file inside the release that defines a class of this module, by path."""
        root = release.resolve()
        found = {}
        for cls in type(self).__mro__:
            try:
                source = inspect.getsourcefile(cls)
            except TypeError:
                continue
            path = Path(source).resolve() if source is not None else None
            if path is not None and path.is_relative_to(root):
                found[path.relative_to(root).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
        return found

    def state_digests(self, ctx: Context) -> dict[str, str]:
        """HMAC-SHA256 of each stateInputs file of the checkout, or of b"missing" when it is absent."""
        digests = {}
        for name in self.state_inputs:
            path = ctx.source / name
            content = path.read_bytes() if path.exists() else b"missing"
            digests[name] = hmac.new(ctx.state_key(), content, hashlib.sha256).hexdigest()
        return digests

    def fingerprint(self, ctx: Context) -> str:
        content = json.dumps({"kind": self.kind, "objects": self.objects(ctx.repo, ctx.sha),
                              "code": self.code(ctx.release), "stateInputs": self.state_digests(ctx),
                              "declaration": self.declaration}, sort_keys=True)
        return hashlib.sha256(content.encode()).hexdigest()

    def check_job(self) -> str | None:
        """The GitHub Actions job whose success makes the module eligible, if it has checks."""
        if self.job is not None:
            return self.job
        return f"check ({self.name})" if self.checks else None

    def routes(self) -> list[dict]:
        """Public routes: hostname, optional path, declared probes (or None) and origin."""
        return []

    def children(self) -> list[Module]:
        return []

    def build(self, ctx: Context, release: Path) -> None:
        pass

    def activate(self, ctx: Context, release: Path) -> None:
        pass

    def verify(self, ctx: Context) -> bool:
        return True

    def rollback(self, ctx: Context) -> str:
        """Restore self.record's version after a failed activation and return the module status."""
        return "failed"

    def remove(self, ctx: Context, record: dict) -> None:
        pass


def declared_routes(module: Module, origin: str) -> list[dict]:
    return [{"hostname": r["hostname"], **({"path": r["path"]} if "path" in r else {}),
             "probes": r.get("probes"), "origin": origin} for r in module.declaration["routes"]]

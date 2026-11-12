"""Discover static sites, validate service declarations and generate ingress."""
from __future__ import annotations

import json
import re
from pathlib import Path
from urllib.parse import urlsplit

HOSTNAME = re.compile(r"(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}")
WEBHOOK_PATH = "/deploy"
WEBHOOK_PORT = 8091
STATIC_ORIGIN = "http://127.0.0.1:8090"


def relative_path(value: object) -> str:
    if (not isinstance(value, str) or not value or Path(value).is_absolute()
            or any(part in ("", ".", "..") or part.startswith(".") for part in value.split("/"))):
        raise ValueError(f"expected a repository-relative path: {value!r}")
    return value


def hostname(value: object) -> str:
    if not isinstance(value, str) or not HOSTNAME.fullmatch(value):
        raise ValueError(f"invalid hostname: {value!r}")
    return value


def local_url(value: object, schemes: tuple[str, ...]) -> None:
    if not isinstance(value, str):
        raise ValueError("origin and health URLs must be strings")
    parsed = urlsplit(value)
    if (parsed.scheme not in schemes or parsed.hostname not in ("localhost", "127.0.0.1")
            or parsed.username or parsed.password or parsed.fragment or not parsed.port):
        raise ValueError(f"expected a loopback URL with a port: {value!r}")


def commands(value: object) -> None:
    if not isinstance(value, list) or not value or any(not isinstance(x, str) or not x or "\n" in x for x in value):
        raise ValueError("commands must be nonempty arrays of arguments")
    for argument in value:
        if re.search(r"\{(?!release\}|python\}|home\})", argument):
            raise ValueError(f"unknown command placeholder: {argument}")


def discover_sites(root: Path) -> list[dict]:
    """Publish direct static-page directories named with their full hostname."""
    directory = root / "jomaa-static-pages"
    if not directory.is_dir():
        return []
    routes = []
    for folder in sorted(directory.iterdir()):
        if folder.name.startswith(".") or "." not in folder.name or not (folder.is_dir() or folder.is_symlink()):
            continue
        host = hostname(folder.name)
        if folder.is_symlink():
            raise ValueError(f"site directory cannot be a symlink: {folder.name}")
        index = folder / "index.html"
        if not index.is_file() or not index.resolve().is_relative_to(folder.resolve()):
            raise ValueError(f"discovered site needs an index.html inside its folder: {host}")
        routes.append({"hostname": host, "service": "static", "site": f"jomaa-static-pages/{host}"})
    return routes


def load(root: Path) -> dict:
    path = root / "jomaa-deploy/deploy.json"
    config = json.loads(path.read_text())
    if not isinstance(config, dict) or set(config) != {"checks", "provision", "state", "webhook", "services", "routes"}:
        raise ValueError("deploy.json requires checks, provision, state, webhook, services and routes")
    for field in ("checks", "provision"):
        if not isinstance(config[field], list):
            raise ValueError(f"{field} must be an array")
        for step in config[field]:
            if not isinstance(step, dict) or set(step) != {"directory", "command"}:
                raise ValueError(f"{field} entries require a directory and command")
            directory = relative_path(step["directory"])
            if not (root / directory).is_dir():
                raise ValueError(f"missing {field} directory: {directory}")
            commands(step["command"])
    hostname(config["webhook"])
    state = config["state"]
    if not isinstance(state, list) or any(not isinstance(x, str) for x in state) or len(set(state)) != len(state):
        raise ValueError("state must be a list of unique paths")
    for entry in state:
        # State paths include private dotfiles.
        if (not isinstance(entry, str) or Path(entry).is_absolute() or not entry
                or any(x in ("", ".", "..") for x in entry.split("/"))):
            raise ValueError(f"invalid state path: {entry!r}")
        if not entry.startswith("jomaa-") or entry.startswith("jomaa-deploy/"):
            raise ValueError("state must belong to a project outside jomaa-deploy")
        if any(other != entry and other.startswith(entry + "/") for other in state):
            raise ValueError("state paths cannot contain one another")
    services = config["services"]
    if not isinstance(services, dict) or not services:
        raise ValueError("services must be a nonempty object")
    units = set()
    for name, service in services.items():
        if not re.fullmatch(r"[a-z][a-z0-9-]*", name) or not isinstance(service, dict):
            raise ValueError(f"invalid service: {name}")
        if set(service) - {"origin", "unit", "directory", "command", "build", "health"}:
            raise ValueError(f"unknown fields in service {name}")
        local_url(service.get("origin"), ("http", "https", "ssh", "tcp"))
        if urlsplit(service["origin"]).path or urlsplit(service["origin"]).query:
            raise ValueError("origins cannot contain paths or queries")
        if "unit" not in service:
            if set(service) != {"origin"}:
                raise ValueError("external services declare only an origin")
            continue
        unit = service["unit"]
        if (not isinstance(unit, str) or not re.fullmatch(r"jomaa-[a-z0-9-]+", unit)
                or unit in ("jomaa-deploy", "jomaa-cloudflared") or unit in units):
            raise ValueError(f"invalid or duplicate unit: {unit}")
        units.add(unit)
        directory = relative_path(service.get("directory"))
        if not (root / directory).is_dir():
            raise ValueError(f"missing service directory: {directory}")
        commands(service.get("command"))
        if not isinstance(service.get("build", []), list):
            raise ValueError("build must be an array of commands")
        for command in service.get("build", []):
            commands(command)
        health = service.get("health")
        if not isinstance(health, dict) or set(health) - {"url", "host", "json"}:
            raise ValueError(f"service {name} needs a health check")
        local_url(health.get("url"), ("http", "https"))
        if "host" in health:
            hostname(health["host"])
        if "json" in health and not isinstance(health["json"], dict):
            raise ValueError("health.json must be an object of expected response fields")
    routes = config["routes"]
    if not isinstance(routes, list) or not routes:
        raise ValueError("routes must be a nonempty array")
    seen, whole_hosts = set(), set()
    for route in routes:
        if not isinstance(route, dict) or set(route) - {"hostname", "service", "path", "probes"}:
            raise ValueError("invalid route fields")
        host = hostname(route.get("hostname"))
        service = route.get("service")
        if not isinstance(service, str) or service not in services:
            raise ValueError(f"unknown route service: {service}")
        pattern = route.get("path")
        if pattern is not None:
            if not isinstance(pattern, str) or not pattern.startswith("^") or not pattern.endswith("$"):
                raise ValueError("route paths must be anchored regular expressions")
            re.compile(pattern)
        key = (host, pattern)
        if key in seen or host in whole_hosts:
            raise ValueError(f"duplicate or unreachable route: {host} {pattern}")
        seen.add(key)
        if pattern is None:
            whole_hosts.add(host)
        probes = route.get("probes", ["/"] if pattern is None else [])
        if not isinstance(probes, list) or not probes or any(
                not isinstance(p, str) or not p.startswith("/") or "?" in p or "#" in p
                or (pattern is not None and re.search(pattern, p) is None) for p in probes):
            raise ValueError(f"route needs matching probe paths: {host}")
        if host == config["webhook"] and any(p == WEBHOOK_PATH for p in probes):
            raise ValueError("/deploy is reserved for the deployment receiver")
        if services[service]["origin"] == STATIC_ORIGIN:
            raise ValueError("static site routes are discovered from hostname directories")
    discovered = discover_sites(root)
    if discovered and (services.get("static", {}).get("origin") != STATIC_ORIGIN
                       or "unit" not in services["static"]):
        raise ValueError("discovered sites require the managed static service")
    for route in discovered:
        host = route["hostname"]
        if host in whole_hosts or host == config["webhook"]:
            raise ValueError(f"discovered site conflicts with a service hostname: {host}")
    config["routes"] = [*routes, *discovered]
    return config


def ingress(config: dict) -> list[dict]:
    rules = [{"hostname": config["webhook"], "path": "^/deploy$",
              "service": f"http://127.0.0.1:{WEBHOOK_PORT}"}]
    for route in config["routes"]:
        rule = {"hostname": route["hostname"], "service": config["services"][route["service"]]["origin"]}
        if "path" in route:
            rule["path"] = route["path"]
        rules.append(rule)
    return [*rules, {"service": "http_status:404"}]


def expand(command: list[str], release: Path) -> list[str]:
    import sys

    values = {"release": str(release), "python": sys.executable, "home": str(Path.home())}
    return [re.sub(r"\{(release|python|home)\}", lambda m: values[m[1]], arg) for arg in command]

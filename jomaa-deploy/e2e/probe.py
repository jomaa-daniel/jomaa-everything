"""Report the deployment state on jerry as JSON; harness.py runs it as the deployment user for invariants().

Usage: python3 - SPEC < probe.py, where SPEC is a JSON object with deploy, source, tunnelDirectory,
webhookHost, webhookPath, recordFile, siteMap, ingressFile, timeout and validateTimeout.
"""
from __future__ import annotations

import fcntl
import json
import re
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

SPEC = json.loads(sys.argv[1])
DEPLOY = Path(SPEC["deploy"])
SOURCE = Path(SPEC["source"])
TIMEOUT = SPEC["timeout"]
SERVICE = re.compile(r"^\s*service: (\S+)\s*$", re.MULTILINE)


def relative(path: Path) -> str | None:
    """The resolved target of a pointer, relative to the deployment directory."""
    if not path.exists():
        return None
    target = path.resolve()
    try:
        return str(target.relative_to(DEPLOY.resolve()))
    except ValueError:
        return str(target)


def read_json(path: Path) -> object:
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as error:
        return {"unreadable": f"{type(error).__name__}: {error}"}


def get(url: str, host: str | None = None) -> dict:
    headers = {"Host": host} if host else {}
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(urllib.request.Request(url, headers=headers), timeout=TIMEOUT) as response:
            return {"status": response.status, "body": response.read().decode(errors="replace")}
    except urllib.error.HTTPError as error:
        return {"status": error.code, "body": error.read().decode(errors="replace")}
    except (OSError, ValueError) as error:
        return {"status": None, "body": f"{type(error).__name__}: {error}"}


def lock_free() -> bool:
    with (DEPLOY / "deploy.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return False
        fcntl.flock(lock, fcntl.LOCK_UN)
        return True


def cloudflared(*args: str) -> subprocess.CompletedProcess:
    native = SOURCE / SPEC["tunnelDirectory"]
    return subprocess.run([str(native / "cloudflared"), "--config", str(native / "tunnel.yml"), "tunnel", *args],
                          capture_output=True, text=True, timeout=SPEC["validateTimeout"])


def main() -> None:
    facts: dict = {"records": {}, "pointers": {}, "units": {}, "health": {}, "siteAnswers": {}, "rules": {},
                   "results": {}}
    probes = {(SPEC["webhookHost"], SPEC["webhookPath"])}
    for path in sorted((DEPLOY / "modules").glob("*/")):
        record = read_json(path / SPEC["recordFile"])
        facts["records"][path.name] = record
        facts["pointers"][path.name] = {"current": relative(path / "current"),
                                        "previous": relative(path / "previous")}
        if not isinstance(record, dict) or not isinstance(record.get("declaration"), dict):
            continue
        declaration = record["declaration"]
        if record.get("kind") == "Service":
            unit = declaration["unit"]
            facts["units"][unit] = subprocess.run(["systemctl", "--user", "is-active", unit], capture_output=True,
                                                  text=True).stdout.strip()
            facts["health"][record["name"]] = get(declaration["origin"] + declaration["health"]["path"])
        if record.get("kind") == "StaticSite":
            probes.add((declaration["name"], "/"))
        for route in declaration.get("routes", []):
            for probe in route.get("probes") or ["/"]:
                probes.add((route["hostname"], probe))
    releases = DEPLOY / "releases"
    facts["releases"] = {r.name: (r / ".revision").read_text().strip() if (r / ".revision").is_file() else None
                         for r in sorted(releases.iterdir())} if releases.is_dir() else {}
    facts["current"] = relative(DEPLOY / "current")
    facts["currentRevision"] = ((DEPLOY / "current/.revision").read_text().strip()
                                if (DEPLOY / "current/.revision").is_file() else None)
    facts["lockFree"] = lock_free()
    sites = read_json(DEPLOY / SPEC["siteMap"])
    facts["sites"] = sites
    origins = {r["declaration"]["name"]: r["declaration"]["origin"] for r in facts["records"].values()
               if isinstance(r, dict) and r.get("kind") == "StaticSite" and isinstance(r.get("declaration"), dict)}
    if isinstance(sites, dict):
        for host, folder in sites.items():
            answer = get(origins[host] + "/", host) if host in origins else {"status": None, "body": "no record"}
            facts["siteAnswers"][host] = {**answer, "folderExists": Path(folder).is_dir()}
    facts["ingress"] = read_json(DEPLOY / SPEC["ingressFile"])
    validate = cloudflared("ingress", "validate")
    facts["validate"] = {"code": validate.returncode, "output": validate.stdout + validate.stderr}
    for host, probe in sorted(probes):
        rule = cloudflared("ingress", "rule", f"https://{host}{probe}")
        found = SERVICE.search(rule.stdout)
        facts["rules"][f"{host} {probe}"] = found[1] if rule.returncode == 0 and found else None
    for stored in sorted((DEPLOY / "results").glob("*.json")):
        facts["results"][stored.name] = read_json(stored)
    facts["tunnelYml"] = (SOURCE / SPEC["tunnelDirectory"] / "tunnel.yml").read_text()
    print(json.dumps(facts))


main()

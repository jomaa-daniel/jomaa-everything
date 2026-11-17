#!/usr/bin/env python3
"""Run every check the hub must pass. Exits non-zero if any fail.

    verify.py           everything: dependencies, format, types, lint, tests, audit, Python tests
    verify.py --fast    format, types and lint only (used by the pre-commit hook)

Tools are pinned in package-lock.json, so every machine runs the same versions.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

HUB_DIR = Path(__file__).resolve().parent.parent
AUDIT_FILE = HUB_DIR / "audit.json"
SEVERITIES = ("info", "low", "moderate", "high", "critical")


def run(cmd: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, cwd=HUB_DIR, capture_output=True, text=True)


def check_cmd(*cmd: str):
    def check() -> str | None:
        out = run(list(cmd))
        return None if out.returncode == 0 else (out.stdout + out.stderr).strip()

    return check


def unaccepted(report: dict, level: str, accepted: list[str]) -> list[str]:
    """Advisories in an npm audit JSON report at or above level that are not accepted."""
    found = set()
    for vulnerability in report.get("vulnerabilities", {}).values():
        for via in vulnerability.get("via", []):
            if not isinstance(via, dict) or SEVERITIES.index(via["severity"]) < SEVERITIES.index(level):
                continue
            advisory = via["url"].rstrip("/").rsplit("/", 1)[-1]
            if advisory not in accepted:
                found.add(f"{advisory} ({via['severity']}): {via['name']} {via['title']}")
    return sorted(found)


def check_audit() -> str | None:
    settings = json.loads(AUDIT_FILE.read_text())
    if settings["level"] not in SEVERITIES:
        return f"audit.json level must be one of {', '.join(SEVERITIES)}"
    out = run(["npm", "audit", "--omit=dev", "--json"])
    try:
        report = json.loads(out.stdout)
    except json.JSONDecodeError:
        return (out.stdout + out.stderr).strip()
    if "error" in report:
        return json.dumps(report["error"])
    found = unaccepted(report, settings["level"], settings["acceptedAdvisories"])
    return "\n".join(found) if found else None


def check_installed() -> str | None:
    if not shutil.which("npm"):
        return "npm is not installed"
    if not (HUB_DIR / "node_modules").is_dir():
        return "dependencies are missing: run npm ci in jomaa-home-hub"
    return None


def checks(fast: bool) -> list[tuple[str, object]]:
    steps = [
        ("prettier", check_cmd("npx", "prettier", "--check", ".", "../jomaa-static-pages/device-panel")),
        ("tsc", check_cmd("npx", "tsc", "-p", "tsconfig.json", "--noEmit")),
        ("eslint", check_cmd("npx", "eslint", ".")),
    ]
    if fast:
        return [("dependencies installed", check_installed), *steps]
    return [
        # Installs exactly what package-lock.json lists, failing if it is out of date.
        ("npm ci", check_cmd("npm", "ci", "--no-audit", "--no-fund")),
        *steps,
        ("node tests", check_cmd("npm", "test")),
        ("npm audit", check_audit),
        ("python tests", check_cmd(sys.executable, "-m", "unittest", "discover", "-s", "scripts", "-q")),
    ]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--fast", action="store_true", help="skip installing, tests and the audit")
    args = parser.parse_args(argv)

    failed = []
    for name, check in checks(args.fast):
        start = time.monotonic()
        problem = check()
        took = time.monotonic() - start
        if problem:
            failed.append(name)
            print(f"FAIL  {name} ({took:.1f}s)\n{problem}\n", flush=True)
        else:
            print(f"ok    {name} ({took:.1f}s)", flush=True)
    if failed:
        print(f"\n{len(failed)} check(s) failed: {', '.join(failed)}")
        return 1
    print("\nall checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())

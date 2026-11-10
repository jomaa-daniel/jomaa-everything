#!/usr/bin/env python3
"""Run every check the hub must pass. Exits non-zero if any fail.

    verify.py           everything: dependencies, format, types, lint, tests, audit, Python tests
    verify.py --fast    format, types and lint only (used by the pre-commit hook)

Tools are pinned in package-lock.json, so every machine runs the same versions.
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import time
from pathlib import Path

HUB_DIR = Path(__file__).resolve().parent.parent


def run(cmd: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, cwd=HUB_DIR, capture_output=True, text=True)


def check_cmd(*cmd: str):
    def check() -> str | None:
        out = run(list(cmd))
        return None if out.returncode == 0 else (out.stdout + out.stderr).strip()

    return check


def check_installed() -> str | None:
    if not shutil.which("npm"):
        return "npm is not installed"
    if not (HUB_DIR / "node_modules").is_dir():
        return "dependencies are missing: run npm ci in jomaa-home-hub"
    return None


def checks(fast: bool) -> list[tuple[str, object]]:
    steps = [
        ("prettier", check_cmd("npx", "prettier", "--check", ".")),
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
        ("npm audit", check_cmd("npm", "audit", "--omit=dev", "--audit-level=high")),
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

#!/usr/bin/env python3
"""Run the repository checks declared in deploy.json."""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import manifest


def main() -> int:
    root = Path(__file__).resolve().parent.parent
    try:
        config = manifest.load(root)
        failures = []
        for check in config["checks"]:
            command = manifest.expand(check["command"], root)
            print(f"Checking {check['directory']}: {' '.join(command)}", flush=True)
            if subprocess.run(command, cwd=root / check["directory"]).returncode:
                failures.append(check["directory"])
        if failures:
            print("Checks failed: " + ", ".join(failures), file=sys.stderr)
            return 1
        print("All deployment checks passed.")
        return 0
    except (OSError, ValueError) as error:
        print(f"Verification failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

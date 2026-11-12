#!/usr/bin/env python3
"""Run the checks of every discovered module, or of the named modules or GitHub Actions job."""
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

import engine
from modules.base import expand


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("names", nargs="*", help="modules to check; every module when omitted")
    parser.add_argument("--job", help="check the modules whose checks run in this GitHub Actions job")
    args = parser.parse_args(argv)
    root = Path(__file__).resolve().parent.parent
    try:
        modules, failures = engine.discover(root)
        for directory, error in failures.items():
            print(f"{directory} failed to load: {error}", file=sys.stderr)
        selected = [m for m in modules if (not args.names or m.name in args.names)
                    and (args.job is None or m.check_job() == args.job)]
        unknown = set(args.names) - {m.name for m in modules}
        if unknown:
            raise ValueError("unknown modules: " + ", ".join(sorted(unknown)))
        failed = [] if args.names or args.job else list(failures)
        for module in selected:
            for check in module.checks:
                command = expand(check, root)
                print(f"Checking {module.name}: {' '.join(command)}", flush=True)
                if subprocess.run(command, cwd=root / module.directory).returncode:
                    failed.append(module.name)
        if failed:
            print("Checks failed: " + ", ".join(dict.fromkeys(failed)), file=sys.stderr)
            return 1
        print("All deployment checks passed.")
        return 0
    except (OSError, ValueError) as error:
        print(f"Verification failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

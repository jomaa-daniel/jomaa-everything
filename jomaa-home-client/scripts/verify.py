#!/usr/bin/env python3
"""Run every check the phone apps must pass. Exits non-zero if any fail.

    verify.py              Android unit tests, strict lint, builds
    verify.py --emulator   also the Android emulator tests (needs a running emulator)

Android needs JDK 17 and the Android SDK (JAVA_HOME and ANDROID_HOME set).
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import time
from pathlib import Path

CLIENT_DIR = Path(__file__).resolve().parent.parent


def run(name: str, cmd: list[str], cwd: Path) -> bool:
    start = time.monotonic()
    result = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    took = time.monotonic() - start
    if result.returncode == 0:
        print(f"ok    {name} ({took:.0f}s)", flush=True)
        return True
    print(f"FAIL  {name} ({took:.0f}s)\n{(result.stdout + result.stderr)[-4000:]}\n", flush=True)
    return False


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--emulator", action="store_true", help="also run the Android emulator tests")
    args = parser.parse_args()

    android = CLIENT_DIR / "android"
    tasks = [":app:testDebugUnitTest", ":app:lintDebug", ":app:assembleDebug", ":app:assembleDebugAndroidTest"]
    if args.emulator:
        tasks.append(":app:connectedDebugAndroidTest")
    results = [
        run("python scripts compile", [sys.executable, "-m", "py_compile", *map(str, (CLIENT_DIR / "scripts").glob("*.py"))], CLIENT_DIR),
        run("android: " + " ".join(t.removeprefix(":app:") for t in tasks), ["./gradlew", "--no-daemon", "-q", *tasks], android),
    ]
    failed = results.count(False)
    print("\nall checks passed" if not failed else f"\n{failed} check(s) failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

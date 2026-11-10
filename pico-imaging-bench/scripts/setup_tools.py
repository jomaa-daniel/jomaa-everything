#!/usr/bin/env python3
"""Create isolated USB tools, including on servers without pip or ensurepip."""
from __future__ import annotations

import argparse
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import urllib.request
import venv
import zipfile

PACKAGES = {"mpremote": "1.29.0", "pyserial": "3.5", "platformdirs": "4.14.5"}


def setup(directory: Path):
    if directory.exists():
        raise ValueError("choose a new tools directory")
    directory.mkdir(parents=True, mode=0o700)
    venv.EnvBuilder(with_pip=False).create(directory)
    python = directory / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
    target = Path(subprocess.check_output([str(python), "-c",
                                          "import sysconfig; print(sysconfig.get_paths()['purelib'])"], text=True).strip())
    for package, version in PACKAGES.items():
        with urllib.request.urlopen("https://pypi.org/pypi/%s/%s/json" % (package, version), timeout=30) as response:
            metadata = json.load(response)
        wheels = [item for item in metadata["urls"] if item["filename"].endswith("-none-any.whl")]
        if len(wheels) != 1:
            raise ValueError("expected one universal wheel for " + package)
        wheel = wheels[0]
        with urllib.request.urlopen(wheel["url"], timeout=30) as response:
            payload = response.read()
        if hashlib.sha256(payload).hexdigest() != wheel["digests"]["sha256"]:
            raise ValueError("wheel integrity check failed")
        with zipfile.ZipFile(io.BytesIO(payload)) as archive:
            for info in archive.infolist():
                name = Path(info.filename)
                if name.is_absolute() or ".." in name.parts or (info.external_attr >> 16) & 0o170000 == 0o120000:
                    raise ValueError("unsafe wheel member")
                if ".data" in name.parts:
                    raise ValueError("unsupported wheel layout")
            archive.extractall(target)
        print("Installed %s %s" % (package, version), flush=True)
    subprocess.run([str(python), "-c", "import mpremote, serial, platformdirs"], check=True)
    print("Use:", python)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--venv", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        setup(args.venv.resolve())
        return 0
    except Exception as error:
        print("Tool setup failed (%s). Remove the incomplete tools directory before retrying." % type(error).__name__, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Run MediaMTX with camera sources from the hub's private environment."""
import copy
import json
import os
import sys
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "jomaa-deploy"))
import settings

CONFIG = json.loads((ROOT / "jomaa-cameras/config.json").read_text())
DECLARATION = json.loads((ROOT / "jomaa-cameras/deploy.json").read_text())
SOURCE_SCHEMES = ("rtsp", "rtsps", "http", "https", "rtmp", "srt")


def runtime_config(config, environment, origin):
    server = copy.deepcopy(config["server"])
    address = urlsplit(origin)
    server["metricsAddress"] = f"{address.hostname}:{address.port}"
    paths = {}
    for camera in config["cameras"]:
        source = environment.get(camera["sourceEnv"], "")
        if not source:
            continue
        parsed = urlsplit(source)
        if parsed.scheme not in SOURCE_SCHEMES or not parsed.hostname or parsed.fragment:
            raise ValueError(f"Invalid source URL for {camera['id']}")
        paths[camera["id"]] = {"source": "publisher"}
    server["paths"] = paths
    return server


def main():
    environment = {**os.environ, **settings.load_env(ROOT / settings.CONFIG["cloudflare"]["env"])}
    runtime = runtime_config(CONFIG, environment, DECLARATION["origin"])
    for camera in CONFIG["cameras"]:
        source = environment.get(camera["sourceEnv"], "")
        if source:
            environment[f"MTX_PATHS_{camera['id'].upper()}_SOURCE"] = source
    path = ROOT / CONFIG["mediaMtx"]["runtimeConfigFile"]
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as file:
        json.dump(runtime, file)
    path.chmod(0o600)
    binary = ROOT / CONFIG["mediaMtx"]["binaryFile"]
    os.chdir(path.parent)
    os.execve(str(binary), [str(binary), str(path)], environment)


if __name__ == "__main__":
    main()

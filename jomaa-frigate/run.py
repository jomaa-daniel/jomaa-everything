#!/usr/bin/env python3
"""Generate Frigate's camera configuration and supervise its private container."""
from __future__ import annotations

import copy
import json
import os
import signal
import subprocess
import sys
import threading
import tempfile
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent.parent
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "jomaa-deploy"))
import container
import settings

CONFIG = json.loads((HERE / "config.json").read_text())
DECLARATION = json.loads((HERE / "deploy.json").read_text())
CONFIG_NAME = "config.yml"
CONFIG_MOUNT = "/config"
MEDIA_MOUNT = "/media/frigate"
VERSION_PATH = "/api/version"


def cameras_config():
    hub = json.loads((ROOT / CONFIG["hubSettingsFile"]).read_text())
    return json.loads((ROOT / hub["cameraConfigFile"]).read_text())


def runtime_config(config: dict, cameras: dict, environment: dict) -> tuple[dict, dict]:
    runtime = copy.deepcopy(config["engine"])
    runtime["cameras"] = {}
    secrets = {}
    if not config["enabled"]:
        return runtime, secrets
    for camera in cameras["cameras"]:
        if not camera["monitoring"]["enabled"]:
            continue
        source = environment.get(camera["sourceEnv"], "")
        if not source:
            continue
        parsed = urlsplit(source)
        if (parsed.scheme not in ("rtsp", "rtsps", "http", "https", "rtmp", "srt")
                or not parsed.hostname or parsed.fragment or any(char in source for char in "\r\n\x00")):
            raise ValueError(f"Invalid source for camera {camera['id']}")
        env_key = f"FRIGATE_{camera['sourceEnv']}"
        secrets[env_key] = source
        overrides = copy.deepcopy(camera["monitoring"]["config"])
        if "inputs" in overrides.get("ffmpeg", {}):
            raise ValueError("Camera inputs come from sourceEnv")
        overrides.setdefault("ffmpeg", {})["inputs"] = [
            {"path": "{" + env_key + "}", "roles": ["detect", "record"]}]
        runtime["cameras"][camera["id"]] = overrides
    return runtime, secrets


def private_write(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.parent.chmod(0o700)
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as file:
        temporary = Path(file.name)
        file.write(value)
    try:
        temporary.chmod(0o600)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def write_runtime(runtime: dict, secrets: dict) -> tuple[dict[str, Path], Path]:
    directory = settings.path(CONFIG["configDirectory"])
    media = settings.path(CONFIG["mediaDirectory"])
    if not directory.is_absolute() or not media.is_absolute():
        raise ValueError("Frigate persistent directories must be absolute or home-relative")
    private_write(directory / CONFIG_NAME, json.dumps(runtime))
    media.mkdir(parents=True, exist_ok=True)
    media.chmod(0o700)
    env_file = ROOT / CONFIG["environmentFile"]
    private_write(env_file, "".join(f"{key}={value}\n" for key, value in secrets.items()))
    return {CONFIG_MOUNT: directory, MEDIA_MOUNT: media}, env_file


def main() -> None:
    environment = {**os.environ, **settings.load_env(ROOT / settings.CONFIG["cloudflare"]["env"])}
    runtime, secrets = runtime_config(CONFIG, cameras_config(), environment)
    expected = bool(runtime["cameras"])
    if sys.argv[1:] == ["--prepare"]:
        container.validate(CONFIG["container"])
        if expected:
            container.prepare(CONFIG["container"])
        return
    if sys.argv[1:]:
        raise SystemExit("Usage: run.py [--prepare]")
    child = None
    if expected:
        container.clear_stopped_service(CONFIG["container"])
        mounts, env_file = write_runtime(runtime, secrets)
        child = subprocess.Popen(container.arguments(CONFIG["container"], mounts, env_file),
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    stopped = threading.Event()
    origin = CONFIG["container"]["ports"]["api"]["origin"]

    def healthy() -> bool:
        if not expected:
            return True
        if child is None or child.poll() is not None:
            return False
        try:
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            with opener.open(origin + VERSION_PATH, timeout=CONFIG["health"]["requestTimeoutSeconds"]) as response:
                return response.status == 200
        except (OSError, urllib.error.URLError):
            return False

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path != DECLARATION["health"]["path"]:
                self.send_error(404)
                return
            ready = healthy()
            state = ("ready" if ready else "unavailable") if expected else (
                "unconfigured" if CONFIG["enabled"] else "disabled")
            body = json.dumps({"ok": ready, "state": state}).encode()
            self.send_response(200 if ready else 503)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_):
            pass

    address = urlsplit(DECLARATION["origin"])
    server = ThreadingHTTPServer((address.hostname, address.port), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stopped.set())
    try:
        while not stopped.wait(CONFIG["health"]["pollSeconds"]):
            if child is not None and child.poll() is not None:
                raise RuntimeError("Frigate container stopped")
    finally:
        server.shutdown()
        server.server_close()
        if child is not None:
            container.stop(CONFIG["container"])
            child.wait(timeout=CONFIG["container"]["stopTimeoutSeconds"])
        (ROOT / CONFIG["environmentFile"]).unlink(missing_ok=True)


if __name__ == "__main__":
    main()

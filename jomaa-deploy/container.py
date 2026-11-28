"""Arguments and lifecycle operations for a configured OCI container runtime."""
from __future__ import annotations

import re
import json
import subprocess
from pathlib import Path
from urllib.parse import urlsplit

MANAGED_LABEL = "org.jomaa.managed-container"


def validate(config: dict) -> None:
    if not config["command"] or any(not isinstance(arg, str) or not arg for arg in config["command"]):
        raise ValueError("container.command must be a nonempty argument list")
    if not re.fullmatch(r"[a-zA-Z0-9_./:@-]+@sha256:[a-f0-9]{64}", config["image"]):
        raise ValueError("container.image must be pinned by digest")
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]*", config["name"]):
        raise ValueError("invalid container.name")
    for port in config["ports"].values():
        origin = urlsplit(port["origin"])
        if (origin.scheme != "http" or origin.hostname != "127.0.0.1" or not origin.port
                or origin.username or origin.password or origin.path or origin.query or origin.fragment
                or not isinstance(port["containerPort"], int) or not 0 < port["containerPort"] < 65536):
            raise ValueError("container ports must publish HTTP on loopback")
    for key in ("stopTimeoutSeconds", "pullTimeoutSeconds", "cpus"):
        if not isinstance(config[key], (float, int)) or config[key] <= 0:
            raise ValueError(f"container.{key} must be positive")


def arguments(config: dict, mounts: dict[str, Path], environment_file: Path) -> list[str]:
    """Run one removable container with loopback ports and explicitly granted mounts."""
    validate(config)
    args = [*config["command"], "run", "--rm", "--name", config["name"],
            "--label", f"{MANAGED_LABEL}={config['name']}",
            "--shm-size", config["sharedMemory"], "--cpus", str(config["cpus"]),
            "--memory", config["memory"], "--env-file", str(environment_file)]
    for port in config["ports"].values():
        origin = urlsplit(port["origin"])
        args.extend(["--publish", f"{origin.hostname}:{origin.port}:{port['containerPort']}"])
    for target, source in mounts.items():
        if not target.startswith("/") or "," in target or "," in str(source):
            raise ValueError("invalid container mount")
        args.extend(["--mount", f"type=bind,source={source.resolve()},target={target}"])
    for target, size in config["tmpfs"].items():
        if not target.startswith("/") or not isinstance(size, int) or size <= 0:
            raise ValueError("invalid container tmpfs")
        args.extend(["--tmpfs", f"{target}:size={size}"])
    for device in config["devices"]:
        args.extend(["--device", device])
    return [*args, config["image"]]


def prepare(config: dict) -> None:
    validate(config)
    subprocess.run([*config["command"], "pull", config["image"]], check=True,
                   timeout=config["pullTimeoutSeconds"])


def stop(config: dict) -> None:
    subprocess.run([*config["command"], "stop", "--time", str(config["stopTimeoutSeconds"]), config["name"]],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                   timeout=config["stopTimeoutSeconds"] + config["pullTimeoutSeconds"], check=False)


def clear_stopped_service(config: dict) -> None:
    """Remove a remaining container owned by this configured service."""
    result = subprocess.run([*config["command"], "inspect", "--format", "{{json .Config.Labels}}", config["name"]],
                            capture_output=True, text=True, timeout=config["pullTimeoutSeconds"], check=False)
    if result.returncode:
        return
    labels = json.loads(result.stdout)
    if not isinstance(labels, dict) or labels.get(MANAGED_LABEL) != config["name"]:
        raise RuntimeError("Configured container name is already in use by an unmanaged container")
    stop(config)
    subprocess.run([*config["command"], "rm", "--force", config["name"]], check=False,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=config["pullTimeoutSeconds"])

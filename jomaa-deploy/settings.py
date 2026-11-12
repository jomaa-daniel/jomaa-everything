"""Read the deployment settings in config.json."""
from __future__ import annotations

import json
import os
from pathlib import Path

CONFIG_FILE = Path(__file__).resolve().parent / "config.json"
CONFIG: dict = json.loads(CONFIG_FILE.read_text())
WEBHOOK_PATH = "/deploy"


def path(value: str) -> Path:
    """Expand a leading ~/ in a configured path."""
    return Path(value).expanduser()


def deploy_dir() -> Path:
    """The deployment directory, from JOMAA_DEPLOY_HOME or deployDirectory."""
    return Path(os.environ.get("JOMAA_DEPLOY_HOME") or path(CONFIG["deployDirectory"])).resolve()


def site_map(deploy: Path) -> Path:
    return deploy / CONFIG["siteMap"]


def load_env(path: Path) -> dict[str, str]:
    """Values from an environment file, overridden by the process environment."""
    values = {}
    if path.exists():
        for raw in path.read_text().splitlines():
            line = raw.strip()
            if line and not line.startswith("#") and "=" in line:
                key, _, value = line.partition("=")
                values[key.strip()] = value.strip().strip("'\"")
    return {**values, **os.environ}

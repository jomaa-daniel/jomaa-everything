"""Shared installation catalog and per-node deployment declarations."""
from __future__ import annotations

import copy
import json
import re
from pathlib import Path

NODE_ID = re.compile(r"[a-z0-9][a-z0-9-]*")
ENV_NAME = re.compile(r"[A-Z][A-Z0-9_]*")
HOSTNAME = re.compile(r"(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}")
NODE_KEYS = {"id", "name", "enabled", "mode", "hostname", "tunnelName", "secretEnv", "deploySecret",
             "scopes", "publicRoutes", "modules", "moduleOverrides"}
TRANSPORT_KEYS = {"requestTimeoutSeconds", "maxRequestBytes", "maxResponseBytes", "delegationLifetimeSeconds",
                  "secretMinLength", "replayLimit"}


def names(value: object, what: str) -> list[str]:
    if (not isinstance(value, list) or any(not isinstance(v, str) or not v for v in value)
            or len(set(value)) != len(value)):
        raise ValueError(f"{what} must be unique nonempty strings")
    return value


def parse(value: object) -> dict:
    if not isinstance(value, dict) or set(value) != {"defaultNode", "identityFile", "transport", "nodes"}:
        raise ValueError("node catalog requires defaultNode, identityFile, transport and nodes")
    identity = value["identityFile"]
    if not isinstance(identity, str) or not identity or Path(identity).name != identity or identity in (".", ".."):
        raise ValueError("identityFile must be a file name")
    transport = value["transport"]
    if (not isinstance(transport, dict) or set(transport) != TRANSPORT_KEYS
            or any(type(v) is not int or v < 1 for v in transport.values())):
        raise ValueError("transport requires positive whole-number bounds")
    if transport["secretMinLength"] < 32:
        raise ValueError("transport.secretMinLength must be at least 32")
    entries = value["nodes"]
    if not isinstance(entries, list) or not entries:
        raise ValueError("nodes must be a nonempty list")
    ids, hosts, tunnels, secrets, deploy_secrets = set(), set(), set(), set(), set()
    for node in entries:
        if not isinstance(node, dict) or set(node) != NODE_KEYS:
            raise ValueError("each node requires exactly " + ", ".join(sorted(NODE_KEYS)))
        if not isinstance(node["id"], str) or not NODE_ID.fullmatch(node["id"]) or node["id"] in ids:
            raise ValueError("node IDs must be unique lowercase letters, digits and dashes")
        ids.add(node["id"])
        if not isinstance(node["name"], str) or not node["name"].strip() or type(node["enabled"]) is not bool:
            raise ValueError("node requires a name and boolean enabled")
        if node["mode"] not in ("gateway", "node"):
            raise ValueError("node mode must be gateway or node")
        for key, seen, pattern in (("hostname", hosts, HOSTNAME), ("tunnelName", tunnels, re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]*")),
                                   ("secretEnv", secrets, ENV_NAME), ("deploySecret", deploy_secrets, ENV_NAME)):
            field = node[key]
            if field is None and key != "deploySecret" and node["mode"] == "gateway":
                continue
            if not isinstance(field, str) or not pattern.fullmatch(field) or field in seen:
                raise ValueError(f"node {key} must be valid and unique")
            seen.add(field)
        names(node["scopes"], "node scopes")
        public = node["publicRoutes"]
        if (not isinstance(public, list) or any(not isinstance(route, list) or len(route) != 2
                or not isinstance(route[0], str) or not re.fullmatch(r"[A-Z]+", route[0])
                or not isinstance(route[1], str) or not route[1].startswith("/")
                or "?" in route[1] or "#" in route[1] for route in public)):
            raise ValueError("publicRoutes must be exact method/path pairs")
        if node["modules"] is None:
            if node["mode"] != "gateway":
                raise ValueError("nodes require an explicit module allowlist")
        else:
            names(node["modules"], "node modules")
        overrides = node["moduleOverrides"]
        if not isinstance(overrides, dict) or any(not isinstance(v, dict) for v in overrides.values()):
            raise ValueError("moduleOverrides must map module names to declaration fields")
        if node["modules"] is not None and set(overrides) - set(node["modules"]):
            raise ValueError("moduleOverrides may only name selected modules")
    gateways = [n for n in entries if n["mode"] == "gateway"]
    if len(gateways) != 1 or gateways[0]["id"] != value["defaultNode"] or not gateways[0]["enabled"]:
        raise ValueError("defaultNode must name the single enabled gateway")
    return value


def catalog(config: dict) -> dict:
    root = Path(__file__).resolve().parent.parent
    return parse(json.loads((root / config["nodesFile"]).read_text()))


def get(config: dict, node_id: str | None = None, deploy_dir: Path | None = None) -> dict:
    data = catalog(config)
    if node_id is None and deploy_dir is not None:
        identity = deploy_dir / data["identityFile"]
        if identity.exists():
            stored = json.loads(identity.read_text())
            if not isinstance(stored, dict) or set(stored) != {"node"} or not isinstance(stored["node"], str):
                raise ValueError("invalid installation node identity")
            node_id = stored["node"]
    node_id = data["defaultNode"] if node_id is None else node_id
    node = next((n for n in data["nodes"] if n["id"] == node_id), None)
    if node is None:
        raise ValueError(f"unknown node: {node_id}")
    resolved = copy.deepcopy(node)
    if resolved["hostname"] is None:
        resolved["hostname"] = config["webhook"]["hostname"]
    if resolved["tunnelName"] is None:
        resolved["tunnelName"] = config["tunnel"]["name"]
    return resolved


def configuration(config: dict, node: dict) -> dict:
    result = copy.deepcopy(config)
    result["webhook"]["hostname"] = node["hostname"]
    result["tunnel"]["name"] = node["tunnelName"]
    return result


def select(modules: list, node: dict) -> list:
    """Select allowed modules and validate their fully resolved declarations."""
    allowed = node["modules"]
    available = {m.name for m in modules}
    if allowed is not None and set(allowed) - available:
        raise ValueError("node selects unknown modules: " + ", ".join(sorted(set(allowed) - available)))
    if set(node["moduleOverrides"]) - available:
        raise ValueError("node overrides unknown modules")

    def resolve(value):
        if isinstance(value, str):
            for key in ("hostname", "id"):
                value = value.replace("{node." + key + "}", node[key])
            if "{node." in value:
                raise ValueError("unknown node placeholder")
            return value
        if isinstance(value, list):
            return [resolve(v) for v in value]
        if isinstance(value, dict):
            return {k: resolve(v) for k, v in value.items()}
        return value

    selected = []
    for module in modules:
        if allowed is not None and module.name not in allowed:
            continue
        override = node["moduleOverrides"].get(module.name, {})
        if set(override) & {"name", "checks", "inputs", "state"}:
            raise ValueError("node overrides cannot change module identity, checks, inputs or state")
        if override:
            module = type(module)(module.directory, {**module.declaration, **resolve(override)}, module.root)
        selected.append(module)
    return selected

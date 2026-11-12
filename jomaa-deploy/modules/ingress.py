"""Tunnel ingress, DNS and the route inventory, built from the live module declarations."""
from __future__ import annotations

import json
import re
import sys

import routing
import settings
from modules.base import Context, Module, atomic_write, expand, unit_text

RECEIVER = "deployment receiver"
NOT_FOUND = {"service": "http_status:404"}
FAILED_DNS = ("conflict", "failed")


def ordered_routes(modules: list[Module], config: dict) -> tuple[list[tuple[str, dict]], list[str]]:
    """Routes in module name order with static sites last; the first claim of a hostname and path wins.

    A whole-host route moves after the last path route for the same hostname.
    """
    claimed = {(config["webhook"]["hostname"], f"^{re.escape(settings.WEBHOOK_PATH)}$"): RECEIVER}
    accepted, conflicts = [], []
    for module in sorted(modules, key=lambda m: (m.kind == "StaticSite", m.name)):
        for route in module.routes():
            key = (route["hostname"], route.get("path"))
            if key in claimed:
                conflicts.append(f"{route['hostname']} {route.get('path') or ''}".strip()
                                 + f": {module.name} conflicts with {claimed[key]}")
                continue
            claimed[key] = module.name
            accepted.append((module.name, route))
    last_path = {route["hostname"]: i for i, (_, route) in enumerate(accepted) if "path" in route}

    def position(item: tuple[int, tuple[str, dict]]) -> float:
        i, (_, route) = item
        last = last_path.get(route["hostname"], -1)
        return last + 0.5 if "path" not in route and last > i else i

    return [entry for _, entry in sorted(enumerate(accepted), key=position)], conflicts


def rules(routes: list[tuple[str, dict]], config: dict) -> tuple[list[dict], list[tuple[str, str, str]]]:
    """cloudflared ingress rules, receiver first and 404 last, and the requests that validate them."""
    host = config["webhook"]["hostname"]
    receiver = f"http://127.0.0.1:{config['webhook']['port']}"
    result = [{"hostname": host, "path": f"^{re.escape(settings.WEBHOOK_PATH)}$", "service": receiver}]
    probes = [(host, settings.WEBHOOK_PATH, receiver)]
    for _, route in routes:
        rule = {"hostname": route["hostname"], "service": route["origin"]}
        if "path" in route:
            rule["path"] = route["path"]
        result.append(rule)
        probes.extend((route["hostname"], probe, route["origin"]) for probe in route["probes"] or ["/"])
    return [*result, NOT_FOUND], probes


def tunnel_unit(ctx: Context) -> str:
    current = ctx.deploy_dir / "current"
    return unit_text(expand(["{python}", "{release}/jomaa-deploy/boot.py", "tunnel"], current),
                     current / "jomaa-deploy", {})


def apply(ctx: Context, modules: list[Module]) -> dict:
    """Update the tunnel when its ingress or unit changed, then reconcile DNS host by host."""
    config = ctx.config
    routes, conflicts = ordered_routes(modules, config)
    result: dict = {"tunnel": "unchanged", "conflicts": conflicts, "dns": {}}
    native = ctx.source / config["tunnel"]["directory"]
    tunnel = native / "tunnel.yml"
    unit_name = config["tunnel"]["unit"] + ".service"
    try:
        ingress, probes = rules(routes, config)
        content = routing.prepare(native / "cloudflared", tunnel, ingress, probes,
                                  config["tunnel"]["validateTimeoutSeconds"])
        unit_path = ctx.unit_dir / unit_name
        unit = tunnel_unit(ctx)
        content_changed = content != tunnel.read_text()
        unit_changed = not unit_path.exists() or unit_path.read_text() != unit
        if content_changed:
            atomic_write(tunnel, content)
        if unit_changed:
            ctx.unit_dir.mkdir(parents=True, exist_ok=True)
            unit_path.write_text(unit)
            ctx.systemctl("daemon-reload")
        if content_changed or unit_changed:
            ctx.systemctl("enable", unit_name)
            ctx.systemctl("restart", unit_name)
            result["tunnel"] = "updated"
    except Exception as error:
        print(f"tunnel ingress failed: {error}", file=sys.stderr, flush=True)
        result["tunnel"] = "failed"
    desired = {config["webhook"]["hostname"], *(route["hostname"] for _, route in routes)}
    hosts_file = ctx.deploy_dir / "ingress.json"
    previous = set(json.loads(hosts_file.read_text())["hosts"]) if hosts_file.exists() else set()
    try:
        token = settings.load_env(ctx.source / config["cloudflare"]["env"]).get("CLOUDFLARE_API_TOKEN", "")
        dns = routing.DNS(ctx.cloudflare(token), routing.tunnel_id(tunnel))
        result["dns"] = dns.reconcile(desired, previous)
    except Exception as error:
        print(f"DNS reconciliation failed: {error}", file=sys.stderr, flush=True)
        result["dns"] = {host: "failed" for host in sorted(desired | previous)}
    kept = desired | {host for host in previous - desired if result["dns"].get(host) == "failed"}
    atomic_write(hosts_file, json.dumps({"hosts": sorted(kept)}) + "\n")
    return result


def failed(result: dict) -> bool:
    return (result["tunnel"] == "failed" or bool(result["conflicts"])
            or any(status in FAILED_DNS for status in result["dns"].values()))


def inventory(modules: list[Module], config: dict) -> dict:
    """The live services and their routes, for the health Worker; static sites are not included."""
    routed = sorted((m for m in modules if m.kind in ("Service", "External")), key=lambda m: m.name)
    routes, _ = ordered_routes(routed, config)
    return {
        "webhook": config["webhook"]["hostname"],
        "services": {m.name: {"origin": m.origin, "health": m.health_check() if m.kind == "Service" else None}
                     for m in routed},
        "routes": [{"hostname": route["hostname"], "service": name, "path": route.get("path"),
                    "probes": route["probes"]} for name, route in routes],
    }

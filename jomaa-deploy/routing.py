"""Render native tunnel ingress and reconcile deployment-owned DNS records."""
from __future__ import annotations

import json
import re
import subprocess
import tempfile
from pathlib import Path

from manifest import ingress

DNS_COMMENT = "Managed by jomaa-deploy"


def tunnel_id(config: Path) -> str:
    match = re.search(r'^tunnel:\s*"?([0-9a-fA-F-]{36})"?\s*$', config.read_text(), re.MULTILINE)
    if not match:
        raise ValueError(f"missing tunnel UUID in {config}")
    return match[1]


def render(original: str, config: dict) -> str:
    if original.count("ingress:\n") != 1:
        raise ValueError("tunnel config needs exactly one ingress section")
    header, _, _ = original.partition("ingress:\n")
    if any(line and not line.startswith((" ", "#")) for line in original.split("ingress:\n", 1)[1].splitlines()):
        raise ValueError("tunnel options must precede ingress")
    lines = [header.rstrip(), "ingress:"]
    for rule in ingress(config):
        for i, (key, value) in enumerate(rule.items()):
            lines.append(f"  {'- ' if i == 0 else '  '}{key}: {json.dumps(value)}")
    return "\n".join(lines) + "\n"


def prepare(binary: Path, path: Path, config: dict) -> str:
    content = render(path.read_text(), config)
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, prefix=".ingress-", delete=False) as file:
        temp = Path(file.name)
        file.write(content)
    try:
        subprocess.run([str(binary), "--config", str(temp), "tunnel", "ingress", "validate"],
                       check=True, timeout=30, capture_output=True, text=True)
        probes = [(config["webhook"], "/deploy", "http://127.0.0.1:8091")]
        for route in config["routes"]:
            probes.extend((route["hostname"], p, config["services"][route["service"]]["origin"])
                          for p in route.get("probes", ["/"]))
        for host, path, origin in probes:
            result = subprocess.run([str(binary), "--config", str(temp), "tunnel", "ingress", "rule",
                                     f"https://{host}{path}"], check=True, timeout=30, capture_output=True, text=True)
            match = re.search(r"^\s*service: (\S+)\s*$", result.stdout, re.MULTILINE)
            if not match or match[1] != origin:
                raise ValueError(f"route {host}{path} does not reach {origin}")
        return content
    finally:
        temp.unlink(missing_ok=True)


def hosts(config: dict) -> set[str]:
    return {config["webhook"], *(r["hostname"] for r in config["routes"])}


class DNS:
    """Track DNS mutations so failed activations can restore their records."""

    def __init__(self, cf, tunnel: str):
        self.cf = cf
        self.target = f"{tunnel}.cfargotunnel.com"
        self.undo: list[tuple[str, str, dict | None]] = []

    def apply(self, desired: set[str], previous: set[str]) -> None:
        records = {}
        for host in sorted(desired | previous):
            zone = self.cf.find_zone(host)["id"]
            existing = self.cf.call("GET", f"/zones/{zone}/dns_records", query={"name": host})
            if host in desired and (len(existing) > 1 or any(
                    r["type"] != "CNAME" or r["content"] != self.target for r in existing)):
                raise ValueError(f"DNS for {host} conflicts with this tunnel")
            records[host] = (zone, existing)
        for host, (zone, existing) in records.items():
            base = f"/zones/{zone}/dns_records"
            if host in desired:
                body = {"type": "CNAME", "name": host, "content": self.target,
                        "proxied": True, "ttl": 1, "comment": DNS_COMMENT}
                if existing:
                    old = existing[0]
                    if all(old.get(k) == v for k, v in body.items()):
                        continue
                    path = f"{base}/{old['id']}"
                    self.cf.call("PUT", path, body)
                    self.undo.append(("PUT", path, self.record_body(old)))
                else:
                    record = self.cf.call("POST", base, body)
                    self.undo.append(("DELETE", f"{base}/{record['id']}", None))
            else:
                for old in existing:
                    if old.get("comment") == DNS_COMMENT and old["type"] == "CNAME" and old["content"] == self.target:
                        self.cf.call("DELETE", f"{base}/{old['id']}")
                        self.undo.append(("POST", base, self.record_body(old)))

    @staticmethod
    def record_body(record: dict) -> dict:
        return {k: record[k] for k in ("type", "name", "content", "proxied", "ttl", "comment") if k in record}

    def restore(self) -> None:
        errors = []
        for method, path, body in reversed(self.undo):
            try:
                self.cf.call(method, path, body)
            except Exception as error:
                errors.append(str(error))
        if errors:
            raise RuntimeError("DNS restoration failed: " + "; ".join(errors))

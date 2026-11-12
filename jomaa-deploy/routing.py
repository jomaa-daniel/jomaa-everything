"""Render native tunnel ingress and reconcile deployment-owned DNS records."""
from __future__ import annotations

import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

DNS_COMMENT = "Managed by jomaa-deploy"


def tunnel_id(config: Path) -> str:
    match = re.search(r'^tunnel:\s*"?([0-9a-fA-F-]{36})"?\s*$', config.read_text(), re.MULTILINE)
    if not match:
        raise ValueError(f"missing tunnel UUID in {config}")
    return match[1]


def render(original: str, rules: list[dict]) -> str:
    if original.count("ingress:\n") != 1:
        raise ValueError("tunnel config needs exactly one ingress section")
    header, _, _ = original.partition("ingress:\n")
    if any(line and not line.startswith((" ", "#")) for line in original.split("ingress:\n", 1)[1].splitlines()):
        raise ValueError("tunnel options must precede ingress")
    lines = [header.rstrip(), "ingress:"]
    for rule in rules:
        for i, (key, value) in enumerate(rule.items()):
            lines.append(f"  {'- ' if i == 0 else '  '}{key}: {json.dumps(value)}")
    return "\n".join(lines) + "\n"


def prepare(binary: Path, path: Path, rules: list[dict], probes: list[tuple[str, str, str]], timeout: float) -> str:
    """Render the ingress and check with cloudflared that every probe reaches its origin."""
    content = render(path.read_text(), rules)
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, prefix=".ingress-", delete=False) as file:
        temp = Path(file.name)
        file.write(content)
    try:
        subprocess.run([str(binary), "--config", str(temp), "tunnel", "ingress", "validate"],
                       check=True, timeout=timeout, capture_output=True, text=True)
        for host, probe, origin in probes:
            result = subprocess.run([str(binary), "--config", str(temp), "tunnel", "ingress", "rule",
                                     f"https://{host}{probe}"], check=True, timeout=timeout, capture_output=True,
                                    text=True)
            match = re.search(r"^\s*service: (\S+)\s*$", result.stdout, re.MULTILINE)
            if not match or match[1] != origin:
                raise ValueError(f"route {host}{probe} does not reach {origin}")
        return content
    finally:
        temp.unlink(missing_ok=True)


class DNS:
    """Reconcile each hostname's record on its own, so one host's problem leaves the others alone."""

    def __init__(self, cf, tunnel: str):
        self.cf = cf
        self.target = f"{tunnel}.cfargotunnel.com"

    def reconcile(self, desired: set[str], previous: set[str]) -> dict[str, str]:
        statuses = {}
        for host in sorted(desired | previous):
            try:
                statuses[host] = self.apply(host, host in desired)
            except Exception as error:
                print(f"DNS for {host} failed: {error}", file=sys.stderr, flush=True)
                statuses[host] = "failed"
        return statuses

    def apply(self, host: str, wanted: bool) -> str:
        zone = self.cf.find_zone(host)["id"]
        base = f"/zones/{zone}/dns_records"
        existing = self.cf.call("GET", base, query={"name": host})
        if wanted:
            if len(existing) > 1 or any(r["type"] != "CNAME" or r["content"] != self.target for r in existing):
                print(f"DNS for {host} conflicts with this tunnel", file=sys.stderr, flush=True)
                return "conflict"
            body = {"type": "CNAME", "name": host, "content": self.target,
                    "proxied": True, "ttl": 1, "comment": DNS_COMMENT}
            if not existing:
                self.cf.call("POST", base, body)
                return "created"
            if all(existing[0].get(k) == v for k, v in body.items()):
                return "unchanged"
            self.cf.call("PUT", f"{base}/{existing[0]['id']}", body)
            return "updated"
        owned = [r for r in existing
                 if r.get("comment") == DNS_COMMENT and r["type"] == "CNAME" and r["content"] == self.target]
        for record in owned:
            self.cf.call("DELETE", f"{base}/{record['id']}")
        return "deleted" if owned else "unmanaged"

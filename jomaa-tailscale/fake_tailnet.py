#!/usr/bin/env python3
"""Test fixture: a fake Tailscale provider and jerry status, never the real tailnet.

    fake_tailnet.py STATE.json (sync --database PATH | observe)
    fake_tailnet.py STATE.json render MEMBER...

runs tailnet.py's command against the provider described by STATE.json and
saves the provider's state back, render prints the policy template filled with members. So tests in any
language can set up users,
devices, the policy and faults, and then assert the resulting policy and the
exact writes. FakeTailnet is also used directly by the Python tests.

State keys: users, devices, policy, status, prefs, writes (every policy the
provider accepted), reads, and faults, a map from an operation (policyRead,
policyWrite, users, devices, local) to a list of faults consumed one per call:
"unreachable", "unauthorized", "reject", "malformed", or "lose-response"
(policyWrite only: the provider applies the policy, then the response is lost).
"""
from __future__ import annotations

import copy
import json
import sys
from pathlib import Path
from typing import Callable

import access
import tailnet


class FakeTailnet:
    def __init__(self, state: dict, before_write: Callable[[dict], None] | None = None):
        self.state = state
        self.state.setdefault("writes", [])
        self.state.setdefault("reads", 0)
        self.state.setdefault("faults", {})
        self.before_write = before_write

    def _fault(self, operation: str) -> str | None:
        faults = self.state["faults"].get(operation) or []
        return faults.pop(0) if faults else None

    def _raise(self, fault: str | None, operation: str) -> None:
        if fault == "unreachable":
            raise access.Uncertain("Tailscale API unreachable: connection refused")
        if fault == "unauthorized":
            raise access.Rejected("Tailscale refused the API token (HTTP 401); replace TAILSCALE_API_KEY in "
                                  "jerry's jomaa-tailscale/.env")
        if fault == "reject":
            raise access.Rejected(f"Tailscale API {operation}: HTTP 400: test failed: group:family can reach "
                                  "192.168.1.1:80")

    def policy(self) -> dict:
        fault = self._fault("policyRead")
        self._raise(fault, "GET /acl")
        self.state["reads"] += 1
        if fault == "malformed":
            return {"groups": "not a map"}
        return copy.deepcopy(self.state["policy"])

    def set_policy(self, policy: dict) -> None:
        if self.before_write is not None:
            self.before_write(policy)
        fault = self._fault("policyWrite")
        self._raise(fault, "POST /acl")
        self.state["policy"] = copy.deepcopy(policy)
        self.state["writes"].append(copy.deepcopy(policy))
        if fault == "lose-response":
            raise access.Uncertain("Tailscale API unreachable: timed out")

    def users(self) -> list[dict]:
        fault = self._fault("users")
        self._raise(fault, "GET /users")
        return tailnet.parse_users({"users": "malformed"} if fault == "malformed" else {"users": self.state["users"]})

    def devices(self) -> list[dict]:
        fault = self._fault("devices")
        self._raise(fault, "GET /devices")
        value = {"devices": [{"broken": True}]} if fault == "malformed" else {"devices": self.state["devices"]}
        return tailnet.parse_devices(value)

    def local(self) -> tuple[dict, dict]:
        if self._fault("local") == "unreachable":
            raise tailnet.TailnetError("Tailscale is not installed; run jomaa-tailscale/setup_server.py on jerry")
        return copy.deepcopy(self.state["status"]), copy.deepcopy(self.state["prefs"])


def main(argv: list[str]) -> int:
    path = Path(argv[0])
    state = json.loads(path.read_text())
    fake = FakeTailnet(state)
    tailnet.api = lambda env=None: fake
    tailnet.local_status = fake.local
    real_observe = tailnet.observe
    tailnet.observe = lambda provider, local=fake.local: real_observe(provider, local)
    try:
        if argv[1] == "render":
            print(json.dumps(access.render(tailnet.template(), sorted(argv[2:]))))
            return 0
        return tailnet.main(argv[1:])
    finally:
        path.write_text(json.dumps(fake.state, indent=2))


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

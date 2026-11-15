#!/usr/bin/env python3
"""PreToolUse hook of every pipeline agent: denies tool calls that leave its workspace.

Reads the hook's JSON from stdin and answers with a deny decision naming the
problems, or with nothing when the call stays inside the workspace.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from scope import Scope

EVENT = "PreToolUse"


def deny(problems: list[str]) -> dict:
    reason = "Blocked: this agent works only inside its workspace. " + "; ".join(problems)
    return {"hookSpecificOutput": {"hookEventName": EVENT, "permissionDecision": "deny",
                                   "permissionDecisionReason": reason}}


def decide(scope: Scope, event: dict) -> dict | None:
    """The deny decision for one tool call, or None when it stays inside; malformed input is denied."""
    try:
        cwd = Path(event["cwd"]) if event.get("cwd") else None
        problems = scope.violations(str(event.get("tool_name", "")), event.get("tool_input") or {}, cwd,
                                    event.get("session_id"))
    except Exception as error:
        problems = [f"the guard could not check this call: {error}"]
    return deny(problems) if problems else None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", required=True, type=Path)
    parser.add_argument("--tools", required=True, help="comma-separated tools of the agent's role")
    args = parser.parse_args(argv)
    try:
        event = json.load(sys.stdin)
    except ValueError as error:
        print(json.dumps(deny([f"the guard could not read the call: {error}"])))
        return 0
    decision = decide(Scope(args.workspace, args.tools.split(",")), event)
    if decision:
        print(json.dumps(decision))
    return 0


if __name__ == "__main__":
    sys.exit(main())

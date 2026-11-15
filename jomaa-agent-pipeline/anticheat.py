#!/usr/bin/env python3
"""Audit a blind implementer's trajectory for anything it should not have seen or done.

Reads Claude Code trajectories (`--output-format stream-json` output or session
transcripts) and reports:

- escape: a tool call that leaves the workspace, by the same rules as the guard
  hook, whether or not the hook blocked it;
- leak: a tool result containing a secret line (a hidden test line, a canary,
  or a forbidden line such as one from a reference solution) that the agent had
  not written itself earlier in the trajectory;
- mention: the agent's own text naming the pipeline's sealed material.

Escapes and leaks fail the audit; mentions are listed for a person to read.
Exits 1 when the audit fails.
"""
from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict, dataclass
from pathlib import Path

from scope import CONFIG, Scope

MENTIONS = ("sealed.bin", "blind-canary", "decrypt")
FAILING = ("escape", "leak")


@dataclass
class Finding:
    kind: str
    trajectory: str
    step: int
    detail: str


@dataclass
class Event:
    step: int
    kind: str
    tool: str
    data: object
    session: str | None


def text_of(content: object) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(text_of(item.get("text", item.get("content", ""))) if isinstance(item, dict)
                         else text_of(item) for item in content)
    return "" if content is None else json.dumps(content)


def events(path: Path) -> list[Event]:
    """Tool calls, tool results and assistant text, in order, from one trajectory file."""
    found: list[Event] = []
    names: dict[str, str] = {}
    session = None
    for line in path.read_text().splitlines():
        try:
            record = json.loads(line)
        except ValueError:
            continue
        if isinstance(record, dict):
            session = record.get("session_id") or record.get("sessionId") or session
        message = record.get("message") if isinstance(record, dict) else None
        if not isinstance(message, dict) or not isinstance(message.get("content"), list):
            continue
        for block in message["content"]:
            if not isinstance(block, dict):
                continue
            step = len(found)
            if block.get("type") == "tool_use":
                names[block.get("id", "")] = block.get("name", "")
                found.append(Event(step, "call", block.get("name", ""), block.get("input") or {}, session))
            elif block.get("type") == "tool_result":
                found.append(Event(step, "result", names.get(block.get("tool_use_id", ""), ""),
                                   text_of(block.get("content")), session))
            elif block.get("type") in ("text", "thinking") and message.get("role") == "assistant":
                found.append(Event(step, "text", "", block.get("text") or block.get("thinking") or "", session))
    return found


def secret_lines(texts: list[str], minimum: int) -> set[str]:
    return {line.strip() for text in texts for line in text.splitlines() if len(line.strip()) >= minimum}


def audit(paths: list[Path], scope: Scope, secrets: set[str]) -> list[Finding]:
    findings = []
    for path in paths:
        written = ""
        for event in events(path):
            if event.kind == "call":
                arguments = event.data if isinstance(event.data, dict) else {}
                for problem in scope.violations(event.tool, arguments, session=event.session):
                    findings.append(Finding("escape", path.name, event.step, problem))
                if isinstance(event.data, dict):
                    written += "\n" + "\n".join(str(value) for value in event.data.values())
            elif event.kind == "result":
                for line in sorted(secrets):
                    if line in event.data and line not in written:
                        findings.append(Finding("leak", path.name, event.step,
                                                f"{event.tool} result contains a secret line: {line[:80]}"))
            else:
                lowered = str(event.data).lower()
                for word in MENTIONS:
                    if word in lowered:
                        findings.append(Finding("mention", path.name, event.step, f"the agent wrote {word!r}"))
    return findings


def report(findings: list[Finding], paths: list[Path]) -> dict:
    failed = [f for f in findings if f.kind in FAILING]
    return {"passed": not failed, "trajectories": [str(p) for p in paths],
            "counts": {kind: sum(f.kind == kind for f in findings) for kind in ("escape", "leak", "mention")},
            "findings": [asdict(f) for f in findings]}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("trajectories", nargs="+", type=Path)
    parser.add_argument("--workspace", required=True, type=Path, help="the implementer's workspace")
    parser.add_argument("--tools", required=True, help="comma-separated tools of the implementer's role")
    parser.add_argument("--secrets", nargs="*", type=Path, default=[],
                        help="files whose lines must never appear in a tool result")
    parser.add_argument("--json", action="store_true", help="print the full report as JSON")
    args = parser.parse_args(argv)
    secrets = secret_lines([p.read_text() for p in args.secrets], CONFIG["secretLineLength"])
    result = report(audit(args.trajectories, Scope(args.workspace, args.tools.split(",")), secrets),
                    args.trajectories)
    print_report(result, args.json)
    return 0 if result["passed"] else 1


def print_report(result: dict, as_json: bool) -> None:
    if as_json:
        print(json.dumps(result, indent=2))
        return
    for finding in result["findings"]:
        print(f"{finding['kind']:8} {finding['trajectory']}#{finding['step']}: {finding['detail']}")
    counts = ", ".join(f"{n} {kind}" for kind, n in result["counts"].items())
    print(("PASSED" if result["passed"] else "FAILED") + f": {counts}")


if __name__ == "__main__":
    sys.exit(main())

"""Bounded agent sessions and the child processes of a pipeline job.

Every agent is a headless Claude Code session with one role: its premade
prompt, its tools, the guard hook, a JSON Schema for its final response, and
limits on budget, turns and wall-clock time. Every process a job starts goes
through `CHILDREN`, so an interrupt stops all of them.
"""
from __future__ import annotations

import json
import os
import shlex
import shutil
import signal
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path

from scope import CONFIG

HERE = Path(__file__).resolve().parent
PROMPTS = HERE / "prompts"
SCHEMAS = HERE / "schemas"
STRUCTURED_OUTPUT = "StructuredOutput"
SCHEMA_ID = "jomaa-pipeline.{role}.v1"


class PipelineError(Exception):
    pass


class Interrupted(PipelineError):
    def __init__(self) -> None:
        super().__init__("the job was interrupted")


class AgentFailed(PipelineError):
    def __init__(self, message: str, session: str | None = None, cost: float | None = None):
        super().__init__(message)
        self.session = session
        self.cost = cost


@dataclass
class Session:
    output: dict
    session: str | None
    cost: float | None


# Child processes.

class Children:
    """Every process a job starts, each in its own process group, so an interrupt can stop them all."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.running: set[subprocess.Popen] = set()
        self.interrupted = threading.Event()

    def start(self, argv: list[str], **kwargs) -> subprocess.Popen:
        with self.lock:
            if self.interrupted.is_set():
                raise Interrupted()
            process = subprocess.Popen(argv, start_new_session=True, **kwargs)
            self.running.add(process)
            return process

    def finish(self, process: subprocess.Popen) -> None:
        with self.lock:
            self.running.discard(process)
        if self.interrupted.is_set():
            raise Interrupted()

    def stop_all(self) -> None:
        with self.lock:
            self.interrupted.set()
            running = list(self.running)
        for process in running:
            kill(process)

    def reset(self) -> None:
        self.interrupted.clear()


def kill(process: subprocess.Popen) -> None:
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass


CHILDREN = Children()


def child_env() -> dict[str, str]:
    return {k: v for k, v in os.environ.items() if k not in CONFIG["clearEnvironment"]}


def run_command(argv: list[str], cwd: Path, timeout: float, capture: bool = False) -> tuple[int, str]:
    """Run a command in its own process group; returns its exit code (-1 on timeout) and, if captured, stdout."""
    try:
        process = CHILDREN.start(argv, cwd=cwd, env=child_env(), stdin=subprocess.DEVNULL,
                                 stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
                                 stderr=None if capture else subprocess.DEVNULL, text=True)
    except OSError as error:
        return 127, str(error)
    try:
        out, _ = process.communicate(timeout=timeout)
        code = process.returncode
    except subprocess.TimeoutExpired:
        kill(process)
        out, _ = process.communicate()
        code = -1
    finally:
        CHILDREN.finish(process)
    return code, out or ""


# Response schemas: a JSON Schema subset of type, const, enum, required,
# properties, additionalProperties, items and minLength.

TYPES = {"object": dict, "array": list, "string": str, "boolean": bool, "integer": int, "number": (int, float)}


def schema(role: str) -> dict:
    return json.loads((SCHEMAS / f"{role}.json").read_text())


def schema_errors(value: object, spec: dict, where: str = "$") -> list[str]:
    errors = []
    expected = spec.get("type")
    if expected and (not isinstance(value, TYPES[expected]) or (expected != "boolean" and isinstance(value, bool))):
        return [f"{where} is not of type {expected}"]
    if "const" in spec and value != spec["const"]:
        errors.append(f"{where} is not {spec['const']!r}")
    if "enum" in spec and value not in spec["enum"]:
        errors.append(f"{where} is not one of {spec['enum']}")
    if isinstance(value, str) and len(value) < spec.get("minLength", 0):
        errors.append(f"{where} is shorter than {spec['minLength']}")
    if isinstance(value, dict):
        properties = spec.get("properties", {})
        errors += [f"{where}.{key} is missing" for key in spec.get("required", []) if key not in value]
        if spec.get("additionalProperties") is False:
            errors += [f"{where}.{key} is not allowed" for key in value if key not in properties]
        for key, item in value.items():
            if key in properties:
                errors += schema_errors(item, properties[key], f"{where}.{key}")
    if isinstance(value, list) and "items" in spec:
        for index, item in enumerate(value):
            errors += schema_errors(item, spec["items"], f"{where}[{index}]")
    return errors


# Headless sessions.

def claude() -> str:
    for candidate in CONFIG["claude"]:
        found = shutil.which(os.path.expanduser(candidate))
        if found:
            return found
    raise PipelineError("no Claude Code executable from config.json claude was found")


def role_tools(role: str) -> list[str]:
    """The role's tools plus the tool that returns its structured response."""
    return [*CONFIG["roles"][role]["tools"], STRUCTURED_OUTPUT]


def agent_argv(role: str, workspace: Path, resume: str | None) -> list[str]:
    settings = CONFIG["roles"][role]
    tools = ",".join(role_tools(role))
    hook = shlex.join([sys.executable, str(HERE / "guard.py"), "--workspace", str(workspace), "--tools", tools])
    hooks = {"hooks": {"PreToolUse": [{"matcher": "*", "hooks": [{"type": "command", "command": hook}]}]}}
    argv = [claude(), "-p", "--restricted", "--strict-mcp-config", "--disable-slash-commands",
            "--model", settings["model"], "--effort", settings["effort"],
            "--tools", ",".join(settings["tools"]), "--allowedTools", tools, "--permission-mode", "dontAsk",
            "--permission-prompts", "none", "--max-budget-usd", str(settings["budgetUsd"]),
            "--settings", json.dumps(hooks), "--append-system-prompt", (PROMPTS / f"{role}.md").read_text(),
            "--json-schema", json.dumps(schema(role)), "--output-format", "stream-json", "--verbose"]
    if not settings["persist"]:
        argv.append("--no-session-persistence")
    if resume:
        argv += ["--resume", resume]
    return argv


def run_agent(role: str, workspace: Path, prompt: str, log: Path, transcript: Path | None = None,
              resume: str | None = None) -> Session:
    """Run one headless session within its role's turn limit and the agent deadline."""
    settings = CONFIG["roles"][role]
    with log.open("w") as errors:
        process = CHILDREN.start(agent_argv(role, workspace, resume), cwd=workspace, stdin=subprocess.PIPE,
                                 stdout=subprocess.PIPE, stderr=errors, text=True, env=child_env())
    finished = threading.Event()
    deadline = time.time() + CONFIG["agentTimeoutSeconds"]
    stopped: list[str] = []

    def watch() -> None:
        while not finished.wait(CONFIG["agentWatchSeconds"]):
            if time.time() > deadline:
                stopped.append("ran past agentTimeoutSeconds")
                kill(process)
                return

    threading.Thread(target=watch, daemon=True).start()
    result: dict | None = None
    session: str | None = None
    turns: set[str] = set()
    sink = transcript.open("w") if transcript else None
    try:
        process.stdin.write(prompt)
        process.stdin.close()
        for line in process.stdout:
            if sink:
                sink.write(line)
                sink.flush()
            try:
                record = json.loads(line)
            except ValueError:
                continue
            if not isinstance(record, dict):
                continue
            session = record.get("session_id") or session
            if record.get("type") == "assistant":
                turns.add(str((record.get("message") or {}).get("id")))
                if len(turns) > settings["maxTurns"] and not stopped:
                    stopped.append("ran past its maxTurns")
                    kill(process)
            if record.get("type") == "result":
                result = record
        process.wait()
    finally:
        finished.set()
        process.stdout.close()
        if sink:
            sink.close()
        CHILDREN.finish(process)
    cost = result.get("total_cost_usd") if result else None
    cost = float(cost) if isinstance(cost, (int, float)) else None
    if stopped:
        raise AgentFailed(f"the {role} session {stopped[0]}", session, cost)
    if result is None or result.get("is_error") or process.returncode:
        detail = str(result.get("result", ""))[:500] if result else ""
        raise AgentFailed(f"the {role} session failed (exit {process.returncode}); see {log}: {detail}", session, cost)
    output = result.get("structured_output")
    if not isinstance(output, dict):
        raise AgentFailed(f"the {role} session returned no structured output", session, cost)
    return Session(output, session, cost)


def check_output(role: str, output: dict) -> None:
    errors = schema_errors(output, schema(role))
    if errors:
        raise AgentFailed(f"the {role} response does not match its schema: " + "; ".join(errors[:5]))

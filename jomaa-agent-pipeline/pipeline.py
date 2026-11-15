#!/usr/bin/env python3
"""Drive one change through the blind pipeline.

start → review-instruction → author → review-tests → seal → implement →
evaluate → audit → land. Each agent runs as a headless Claude Code session in
its own history-free export of the repository, with its role's premade prompt,
restricted file tools and the guard hook. Hidden tests are encrypted when
sealed; the key is printed once and every later step that opens them takes it
as --key. Task state lives under stateDir, workspaces under workspaceDir.
"""
from __future__ import annotations

import argparse
import hashlib
import hmac
import io
import json
import os
import secrets
import shlex
import shutil
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
from pathlib import Path

import anticheat
from scope import CONFIG, Scope, expand, slug

HERE = Path(__file__).resolve().parent
PROMPTS = HERE / "prompts"
STATE = expand(CONFIG["stateDir"]) / "tasks"
WORK = expand(CONFIG["workspaceDir"])
MANIFEST = Path(".blind/manifest.json")
BASE_TAG = "base"
KINDS = ("fail_to_pass", "pass_to_pass")
APPROVE = "approve"
VERDICTS = (APPROVE, "revise")
CANARY = "blind-canary"
COMMENTS = {".py": "#", ".sh": "#", ".ts": "//", ".tsx": "//", ".js": "//", ".mjs": "//", ".cjs": "//",
            ".kt": "//", ".swift": "//"}
MAGIC = b"jomaa-blind-1"
NONCE_BYTES = 16
GIT_ENV = {"GIT_AUTHOR_NAME": "pipeline", "GIT_AUTHOR_EMAIL": "pipeline@localhost",
           "GIT_COMMITTER_NAME": "pipeline", "GIT_COMMITTER_EMAIL": "pipeline@localhost"}


class PipelineError(Exception):
    pass


class AgentFailed(PipelineError):
    def __init__(self, message: str, session: str | None):
        super().__init__(message)
        self.session = session


# Encryption of the sealed bundle: SHAKE-256 keystream, HMAC-SHA256 tag.

def encrypt(key: bytes, data: bytes) -> bytes:
    nonce = secrets.token_bytes(NONCE_BYTES)
    body = xor(data, hashlib.shake_256(key + nonce).digest(len(data)))
    return MAGIC + nonce + hmac.new(key, nonce + body, hashlib.sha256).digest() + body


def decrypt(key: bytes, sealed: bytes) -> bytes:
    if not sealed.startswith(MAGIC):
        raise PipelineError("not a sealed bundle")
    rest = sealed[len(MAGIC):]
    nonce, tag, body = rest[:NONCE_BYTES], rest[NONCE_BYTES:NONCE_BYTES + 32], rest[NONCE_BYTES + 32:]
    if not hmac.compare_digest(tag, hmac.new(key, nonce + body, hashlib.sha256).digest()):
        raise PipelineError("the key does not open this bundle, or the bundle was changed")
    return xor(body, hashlib.shake_256(key + nonce).digest(len(body)))


def xor(data: bytes, stream: bytes) -> bytes:
    return (int.from_bytes(data, "big") ^ int.from_bytes(stream, "big")).to_bytes(len(data), "big")


def parse_key(text: str) -> bytes:
    try:
        key = bytes.fromhex(text)
    except ValueError:
        raise PipelineError("the key is not hex") from None
    if len(key) != 32:
        raise PipelineError("the key must be 32 bytes")
    return key


# Manifest of the hidden tests, written by the test author.

def relative(value: object) -> str:
    if (not isinstance(value, str) or not value or Path(value).is_absolute()
            or any(part in ("", ".", "..") for part in value.split("/"))):
        raise PipelineError(f"expected a repository-relative path: {value!r}")
    return value


def command(item: object, what: str) -> dict:
    if (not isinstance(item, dict) or not isinstance(item.get("command"), list) or not item["command"]
            or any(not isinstance(a, str) for a in item["command"])):
        raise PipelineError(f"{what} needs a nonempty command array")
    cwd = item.get("cwd", ".")
    return {**item, "cwd": cwd if cwd == "." else relative(cwd)}


def validate(manifest: object) -> dict:
    if not isinstance(manifest, dict) or set(manifest) != {"setup", "tests", "files"}:
        raise PipelineError("the manifest has exactly the keys setup, tests and files")
    files = [relative(f) for f in manifest["files"]] if isinstance(manifest["files"], list) else None
    if not files:
        raise PipelineError("the manifest lists no files")
    if not isinstance(manifest["setup"], list) or not isinstance(manifest["tests"], list):
        raise PipelineError("setup and tests are arrays")
    setup = [command(s, "a setup step") for s in manifest["setup"]]
    tests, ids = [], set()
    for test in manifest["tests"]:
        test = command(test, "a test")
        if not isinstance(test.get("id"), str) or not test["id"] or test["id"] in ids:
            raise PipelineError(f"tests need unique ids: {test.get('id')!r}")
        if test.get("kind") not in KINDS:
            raise PipelineError(f"test {test['id']} has kind {test.get('kind')!r}, not one of {KINDS}")
        if not isinstance(test.get("clause"), str) or not test["clause"]:
            raise PipelineError(f"test {test['id']} names no instruction clause")
        ids.add(test["id"])
        tests.append(test)
    if not any(t["kind"] == "fail_to_pass" for t in tests):
        raise PipelineError("the manifest has no fail_to_pass test")
    return {"setup": setup, "tests": tests, "files": files}


def public(manifest: dict) -> list[dict]:
    return [{"id": t["id"], "kind": t["kind"], "clause": t["clause"]} for t in manifest["tests"]]


def run_tests(manifest: dict, tree: Path) -> dict[str, bool]:
    """Run the setup steps, then each test on its own; a test passes when its command exits 0."""
    results = {}
    setup_ok = all(run(step, tree) for step in manifest["setup"])
    for test in manifest["tests"]:
        results[test["id"]] = setup_ok and run(test, tree)
    return results


def run(step: dict, tree: Path) -> bool:
    argv = [sys.executable if a == "{python}" else a for a in step["command"]]
    try:
        return subprocess.run(argv, cwd=tree / step["cwd"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                              timeout=CONFIG["testTimeoutSeconds"], env=child_env()).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def add_canary(path: str, text: str, canary: str) -> str:
    marker = COMMENTS.get(Path(path).suffix)
    if marker is None:
        return text
    line = f"{marker} {CANARY}: {canary}\n"
    if text.startswith("#!"):
        first, _, rest = text.partition("\n")
        return f"{first}\n{line}{rest}"
    return line + text


def strip_canary(text: str) -> str:
    return "".join(line for line in text.splitlines(keepends=True) if f" {CANARY}: " not in line)


# Git and workspaces.

def git(cwd: Path, *args: str, data: bytes | None = None, env: dict | None = None) -> bytes:
    result = subprocess.run(["git", *args], cwd=cwd, input=data, capture_output=True,
                            env={**os.environ, **GIT_ENV, **(env or {})})
    if result.returncode:
        raise PipelineError(f"git {' '.join(args)} failed: {result.stderr.decode().strip()}")
    return result.stdout


def export(repo: Path, rev: str, target: Path, patches: list[Path], components: list[str]) -> None:
    """A history-free copy of the repository at rev with the patches applied, committed and tagged base."""
    if target.exists():
        raise PipelineError(f"{target} already exists")
    target.mkdir(parents=True)
    with tarfile.open(fileobj=io.BytesIO(git(repo, "archive", rev))) as archive:
        archive.extractall(target, filter="tar")
    git(target, "init", "-q")
    for patch in patches:
        if patch.read_bytes().strip():
            git(target, "apply", "--binary", str(patch))
    git(target, "add", "-A")
    git(target, "commit", "-q", "--no-verify", "-m", BASE_TAG)
    git(target, "tag", BASE_TAG)
    for component in components:
        for step in CONFIG["prepare"].get(component, []):
            subprocess.run(step, cwd=target / component, check=True, stdout=subprocess.DEVNULL, env=child_env())


def changes(tree: Path) -> bytes:
    """Every change in the tree since the base tag, committed or not, tracked or new, as a binary patch."""
    with tempfile.TemporaryDirectory() as scratch:
        env = {"GIT_INDEX_FILE": str(Path(scratch) / "index")}
        git(tree, "add", "-A", env=env)
        return git(tree, "diff", "--cached", "--binary", BASE_TAG, env=env)


def visible_text(tree: Path) -> str:
    """The text of every file the base tag holds."""
    with tarfile.open(fileobj=io.BytesIO(git(tree, "archive", BASE_TAG))) as archive:
        return "\n".join(archive.extractfile(m).read().decode(errors="replace")
                         for m in archive.getmembers() if m.isfile())


# Headless agents.

def forget_sessions(*workspaces: Path) -> None:
    """Delete what Claude Code kept of sessions run in these workspaces, such as spilled tool output."""
    for workspace in workspaces:
        shutil.rmtree(expand(CONFIG["claudeProjectsDir"]) / slug(workspace), ignore_errors=True)


def child_env() -> dict[str, str]:
    return {k: v for k, v in os.environ.items() if k not in CONFIG["clearEnvironment"]}


def claude() -> str:
    for candidate in CONFIG["claude"]:
        found = shutil.which(os.path.expanduser(candidate))
        if found:
            return found
    raise PipelineError("no Claude Code executable from config.json claude was found")


def agent_argv(role: str, workspace: Path, resume: str | None) -> list[str]:
    settings = CONFIG["roles"][role]
    tools = ",".join(settings["tools"])
    hook = shlex.join([sys.executable, str(HERE / "guard.py"), "--workspace", str(workspace), "--tools", tools])
    hooks = {"hooks": {"PreToolUse": [{"matcher": "*", "hooks": [{"type": "command", "command": hook}]}]}}
    argv = [claude(), "-p", "--restricted", "--strict-mcp-config", "--disable-slash-commands",
            "--model", settings["model"], "--effort", settings["effort"],
            "--tools", tools, "--allowedTools", tools, "--permission-mode", "dontAsk",
            "--permission-prompts", "none", "--max-budget-usd", str(settings["budgetUsd"]),
            "--settings", json.dumps(hooks), "--append-system-prompt", (PROMPTS / f"{role}.md").read_text(),
            "--output-format", "stream-json", "--verbose"]
    if not settings["persist"]:
        argv.append("--no-session-persistence")
    if resume:
        argv += ["--resume", resume]
    return argv


def run_agent(role: str, workspace: Path, prompt: str, log: Path, transcript: Path | None = None,
              resume: str | None = None) -> tuple[str, str | None]:
    """Run one headless session; returns its final message and session id. Only the implementer keeps a transcript."""
    process = subprocess.Popen(agent_argv(role, workspace, resume), cwd=workspace, stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=log.open("w"), text=True, env=child_env())
    finished = threading.Event()
    deadline = time.time() + CONFIG["agentTimeoutSeconds"]

    def watch() -> None:
        while not finished.wait(CONFIG["agentWatchSeconds"]):
            if time.time() > deadline:
                process.kill()
                return

    threading.Thread(target=watch, daemon=True).start()
    result, session, failed = "", None, True
    try:
        process.stdin.write(prompt)
        process.stdin.close()
        sink = transcript.open("w") if transcript else None
        for line in process.stdout:
            if sink:
                sink.write(line)
                sink.flush()
            try:
                record = json.loads(line)
            except ValueError:
                continue
            session = record.get("session_id") or session
            if record.get("type") == "result":
                result, failed = str(record.get("result", "")), bool(record.get("is_error"))
        if sink:
            sink.close()
        process.wait()
    finally:
        finished.set()
    if failed or process.returncode:
        raise AgentFailed(f"the {role} session failed (exit {process.returncode}); see {log}: {result[:500]}",
                          session)
    return result, session


def verdict(text: str) -> dict:
    """The last JSON object in a reviewer's final message with a valid verdict."""
    decoder = json.JSONDecoder()
    for start in reversed([i for i, c in enumerate(text) if c == "{"]):
        try:
            value, _ = decoder.raw_decode(text[start:])
        except ValueError:
            continue
        if isinstance(value, dict) and value.get("verdict") in VERDICTS and isinstance(value.get("findings"), list):
            return value
    raise PipelineError("the reviewer's final message has no verdict object")


# Tasks.

class Task:
    def __init__(self, name: str):
        if not name or "/" in name or name.startswith("."):
            raise PipelineError(f"invalid task name: {name!r}")
        self.name = name
        self.dir = STATE / name
        self.work = WORK / name
        self.author_dir = self.work / "author"
        self.implement_dir = self.work / "implement"
        self.evaluate_dir = self.work / "evaluate"

    @property
    def state(self) -> dict:
        path = self.dir / "task.json"
        if not path.exists():
            raise PipelineError(f"no task {self.name}; run start first")
        return json.loads(path.read_text())

    def save(self, **changes: object) -> dict:
        state = {**self.state, **changes} if (self.dir / "task.json").exists() else changes
        (self.dir / "task.json").write_text(json.dumps(state, indent=2) + "\n")
        return state

    @property
    def repo(self) -> Path:
        return Path(self.state["repo"])

    @property
    def instruction(self) -> str:
        return (self.dir / "instruction.md").read_text()

    def instruction_hash(self) -> str:
        return hashlib.sha256(self.instruction.encode()).hexdigest()

    def log(self, role: str) -> Path:
        (self.dir / "logs").mkdir(exist_ok=True)
        return self.dir / "logs" / f"{role}.log"

    def manifest(self) -> dict:
        path = self.author_dir / MANIFEST
        if not path.exists():
            raise PipelineError(f"the test author wrote no {MANIFEST}")
        try:
            return validate(json.loads(path.read_text()))
        except ValueError as error:
            raise PipelineError(f"{MANIFEST} is not JSON: {error}") from None

    def authored_hash(self) -> str:
        return hashlib.sha256(changes(self.author_dir)).hexdigest()

    def bundle(self, key: bytes) -> dict:
        bundle = json.loads(decrypt(key, (self.dir / "sealed.bin").read_bytes()))
        for path, text in bundle["files"].items():
            if hashlib.sha256(text.encode()).hexdigest() != bundle["hashes"][path]:
                raise PipelineError(f"sealed test {path} does not match its hash")
        return bundle


def review(task: Task, role: str, prompt: str) -> dict:
    result, _ = run_agent(role, task.author_dir, prompt, task.log(role))
    outcome = verdict(result)
    reviews = task.dir / "reviews"
    reviews.mkdir(exist_ok=True)
    number = len(list(reviews.glob(f"{role}-*.json"))) + 1
    (reviews / f"{role}-{number}.json").write_text(json.dumps(outcome, indent=2) + "\n")
    print(json.dumps(outcome, indent=2))
    return outcome


def cmd_start(args: argparse.Namespace) -> int:
    task = Task(args.task)
    if task.dir.exists() or task.work.exists():
        raise PipelineError(f"task {task.name} already exists; run clean first")
    repo = Path(git(args.repo, "rev-parse", "--show-toplevel").decode().strip())
    base = git(repo, "rev-parse", "--verify", f"{args.base}^{{commit}}").decode().strip()
    task.dir.mkdir(parents=True)
    shutil.copyfile(args.instruction, task.dir / "instruction.md")
    task.save(repo=str(repo), base=base, components=args.components, round=0, session=None,
              instructionReview=None, testReview=None, sealed=False)
    export(repo, base, task.author_dir, [], args.components)
    print(f"Task {task.name} at {base[:12]}. Instruction: {task.dir / 'instruction.md'}")
    return 0


def cmd_review_instruction(args: argparse.Namespace) -> int:
    task = Task(args.task)
    outcome = review(task, "instruction-reviewer", "Instruction to review:\n\n" + task.instruction)
    task.save(instructionReview={"hash": task.instruction_hash(), "verdict": outcome["verdict"]})
    return 0 if outcome["verdict"] == APPROVE else 3


def cmd_author(args: argparse.Namespace) -> int:
    task = Task(args.task)
    approved = task.state["instructionReview"]
    if not approved or approved["verdict"] != APPROVE or approved["hash"] != task.instruction_hash():
        raise PipelineError("the current instruction has no approving review; run review-instruction")
    if task.state["sealed"]:
        raise PipelineError("the tests are already sealed")
    prompt = "Instruction:\n\n" + task.instruction
    if args.feedback:
        prompt += "\n\nReview of your previous attempt, still in this workspace:\n\n" + args.feedback.read_text()
    result, _ = run_agent("test-author", task.author_dir, prompt, task.log("test-author"))
    print(result)
    print(json.dumps(public(task.manifest()), indent=2))
    return 0


def cmd_review_tests(args: argparse.Namespace) -> int:
    task = Task(args.task)
    task.manifest()
    prompt = ("Instruction:\n\n" + task.instruction + f"\n\nThe hidden tests are listed in {MANIFEST}; "
              f"the refactor is `git diff {BASE_TAG} HEAD`; the tests are the untracked files.")
    outcome = review(task, "test-reviewer", prompt)
    task.save(testReview={"hash": task.authored_hash(), "verdict": outcome["verdict"]})
    return 0 if outcome["verdict"] == APPROVE else 3


def cmd_seal(args: argparse.Namespace) -> int:
    task = Task(args.task)
    approved = task.state["testReview"]
    if not approved or approved["verdict"] != APPROVE or approved["hash"] != task.authored_hash():
        raise PipelineError("the current tests and refactor have no approving review; run review-tests")
    manifest = task.manifest()
    status = git(task.author_dir, "status", "--porcelain", "--untracked-files=all").decode().splitlines()
    allowed = {str(MANIFEST), *manifest["files"]}
    stray = [line for line in status if not line.startswith("?? ") or line[3:] not in allowed]
    missing = [f for f in manifest["files"] if f"?? {f}" not in status]
    if stray or missing:
        raise PipelineError("only new manifest files may be uncommitted; commit the refactor. "
                            f"Unexpected: {stray}; missing or tracked: {missing}")
    problems = []
    for attempt in range(CONFIG["sealRuns"]):
        results = run_tests(manifest, task.author_dir)
        for test in manifest["tests"]:
            if results[test["id"]] != (test["kind"] == "pass_to_pass"):
                problems.append(f"run {attempt + 1}: {test['id']} ({test['kind']}) "
                                f"{'passed' if results[test['id']] else 'failed'} before the implementation")
    if problems:
        print("\n".join(problems))
        raise PipelineError("the tests do not hold before the implementation; nothing was sealed")
    key, canary = secrets.token_bytes(32), secrets.token_hex(16)
    files = {f: add_canary(f, (task.author_dir / f).read_text(), canary) for f in manifest["files"]}
    bundle = {"manifest": manifest, "files": files, "canary": canary,
              "hashes": {f: hashlib.sha256(t.encode()).hexdigest() for f, t in files.items()}}
    (task.dir / "sealed.bin").write_bytes(encrypt(key, json.dumps(bundle).encode()))
    (task.dir / "refactor.patch").write_bytes(git(task.author_dir, "diff", "--binary", BASE_TAG, "HEAD"))
    (task.dir / "tests.json").write_text(json.dumps(public(manifest), indent=2) + "\n")
    forget_sessions(task.author_dir)
    shutil.rmtree(task.author_dir)
    task.save(sealed=True)
    print(json.dumps(public(manifest), indent=2))
    print(f"Sealed {len(files)} files and {len(manifest['tests'])} tests. Key, shown once:")
    print(f"KEY {key.hex()}")
    return 0


def cmd_implement(args: argparse.Namespace) -> int:
    task = Task(args.task)
    state = task.state
    if not state["sealed"]:
        raise PipelineError("seal the tests before implementing")
    if args.feedback is None:
        if state["round"]:
            raise PipelineError("the implementer already ran; pass --feedback to continue it")
        export(task.repo, state["base"], task.implement_dir, [task.dir / "refactor.patch"], state["components"])
        prompt, resume = task.instruction, None
    else:
        if not state["round"]:
            raise PipelineError("run implement without --feedback first")
        if state["round"] > CONFIG["feedbackRounds"]:
            raise PipelineError("no feedback rounds are left")
        prompt, resume = "Feedback from the evaluation:\n\n" + args.feedback, state["session"]
    number = state["round"] + 1
    try:
        result, session = run_agent("implementer", task.implement_dir, prompt, task.log(f"implementer-{number}"),
                                    task.dir / f"trajectory-{number}.jsonl", resume)
    except AgentFailed as error:
        task.save(round=number, session=error.session or state["session"])
        raise
    task.save(round=number, session=session)
    print(result)
    return 0


def cmd_evaluate(args: argparse.Namespace) -> int:
    task = Task(args.task)
    bundle = task.bundle(parse_key(args.key))
    state = task.state
    if not state["round"]:
        raise PipelineError("the implementer has not run")
    patch = task.dir / "implementation.patch"
    patch.write_bytes(changes(task.implement_dir))
    shutil.rmtree(task.evaluate_dir, ignore_errors=True)
    try:
        export(task.repo, state["base"], task.evaluate_dir, [task.dir / "refactor.patch", patch],
               state["components"])
        overwritten = [f for f in bundle["files"] if (task.evaluate_dir / f).exists()]
        for path, text in bundle["files"].items():
            (task.evaluate_dir / path).parent.mkdir(parents=True, exist_ok=True)
            (task.evaluate_dir / path).write_text(text)
        results = run_tests(bundle["manifest"], task.evaluate_dir)
    finally:
        shutil.rmtree(task.evaluate_dir, ignore_errors=True)
    rows = [{**t, "passed": results[t["id"]]} for t in public(bundle["manifest"])]
    (task.dir / f"evaluation-{state['round']}.json").write_text(
        json.dumps({"tests": rows, "overwritten": overwritten}, indent=2) + "\n")
    for row in rows:
        print(f"{'PASS' if row['passed'] else 'FAIL'}  {row['kind']:12}  {row['clause']:6}  {row['id']}")
    if overwritten:
        print("The implementation created files at hidden test paths, replaced by the sealed tests: "
              + ", ".join(overwritten))
    unmet = sorted({row["clause"] for row in rows if not row["passed"]})
    if unmet:
        print("Requirements not met: " + ", ".join(unmet))
        return 1
    print("All hidden tests pass.")
    return 0


def cmd_audit(args: argparse.Namespace) -> int:
    task = Task(args.task)
    bundle = task.bundle(parse_key(args.key))
    paths = sorted(task.dir.glob("trajectory-*.jsonl"))
    if not paths:
        raise PipelineError("the implementer has no trajectory")
    texts = [*bundle["files"].values(), *(p.read_text() for p in args.forbid)]
    visible = visible_text(task.implement_dir)
    secret = {line for line in anticheat.secret_lines(texts, CONFIG["secretLineLength"]) if line not in visible}
    scope = Scope(task.implement_dir, CONFIG["roles"]["implementer"]["tools"])
    result = anticheat.report(anticheat.audit(paths, scope, secret), paths)
    (task.dir / "audit.json").write_text(json.dumps(result, indent=2) + "\n")
    anticheat.print_report(result, False)
    return 0 if result["passed"] else 1


def cmd_land(args: argparse.Namespace) -> int:
    task = Task(args.task)
    bundle = task.bundle(parse_key(args.key))
    for name in ("refactor.patch", "implementation.patch"):
        patch = task.dir / name
        if patch.read_bytes().strip():
            git(args.into, "apply", "--binary", str(patch))
    for path, text in bundle["files"].items():
        (args.into / path).parent.mkdir(parents=True, exist_ok=True)
        (args.into / path).write_text(strip_canary(text))
    print(f"Applied the refactor, the implementation and {len(bundle['files'])} test files to {args.into}")
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    task = Task(args.task)
    print(json.dumps(task.state, indent=2))
    return 0


def cmd_clean(args: argparse.Namespace) -> int:
    task = Task(args.task)
    forget_sessions(task.author_dir, task.implement_dir, task.evaluate_dir)
    shutil.rmtree(task.work, ignore_errors=True)
    shutil.rmtree(task.dir, ignore_errors=True)
    print(f"Removed task {task.name}")
    return 0


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = root.add_subparsers(dest="command", required=True)

    def add(name: str, handler, help_text: str) -> argparse.ArgumentParser:
        sub = commands.add_parser(name, help=help_text)
        sub.add_argument("task")
        sub.set_defaults(handler=handler)
        return sub

    start = add("start", cmd_start, "create a task from an instruction at a base revision")
    start.add_argument("--instruction", required=True, type=Path)
    start.add_argument("--base", default="HEAD")
    start.add_argument("--repo", default=Path.cwd(), type=Path)
    start.add_argument("--components", nargs="*", default=[], help="folders whose prepare steps run")
    add("review-instruction", cmd_review_instruction, "run the instruction reviewer")
    author = add("author", cmd_author, "run the test author")
    author.add_argument("--feedback", type=Path, help="a test review the author must address")
    add("review-tests", cmd_review_tests, "run the test reviewer on the author's tests and refactor")
    add("seal", cmd_seal, "verify the tests before the implementation and encrypt them")
    implement = add("implement", cmd_implement, "run or continue the blind implementer")
    implement.add_argument("--feedback", help="requirements the evaluation found unmet")
    for name, handler, text in (("evaluate", cmd_evaluate, "run the sealed tests on the implementation"),
                                ("audit", cmd_audit, "audit the implementer's trajectories"),
                                ("land", cmd_land, "apply the change and the tests to a checkout")):
        sub = add(name, handler, text)
        sub.add_argument("--key", required=True)
        if name == "audit":
            sub.add_argument("--forbid", nargs="*", type=Path, default=[],
                             help="files whose lines the implementer must never have read")
        if name == "land":
            sub.add_argument("--into", required=True, type=Path)
    add("status", cmd_status, "show the task's state")
    add("clean", cmd_clean, "remove the task's state and workspaces")
    return root


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        return args.handler(args)
    except (PipelineError, OSError, subprocess.CalledProcessError) as error:
        print(f"pipeline: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

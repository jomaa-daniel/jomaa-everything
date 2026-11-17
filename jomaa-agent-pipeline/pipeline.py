#!/usr/bin/env python3
"""Run one change through the blind pipeline as an unattended job.

`run` is the parent of every agent. It dispatches each agent with one role
and a bounded objective, validates the structured response, and decides the
next step itself: instruction, tests, implement, land, ci, merge, deploy.
A job starts from an instruction file or from a change that already landed,
which a spec-writer describes as an instruction and whose original serves as
the answer key for the hidden tests. It ends with a pull request that is
merged once CI is green, and a report under stateDir/reports.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import hmac
import io
import json
import os
import secrets
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
from pathlib import Path

import agents
import anticheat
from agents import CHILDREN, AgentFailed, Interrupted, PipelineError, child_env, run_command
from scope import CONFIG, Scope, expand, slug

HERE = Path(__file__).resolve().parent
STATE_ROOT = expand(CONFIG["stateDir"])
STATE = STATE_ROOT / "tasks"
REPORTS = STATE_ROOT / "reports"
WORK = expand(CONFIG["workspaceDir"])
MANIFEST = Path(".blind/manifest.json")
CHANGE_DIR = Path(".blind/change")
BASE_TAG = "base"
KINDS = ("fail_to_pass", "pass_to_pass")
APPROVE = "approve"
CANARY = "blind-canary"
COMMENTS = {".py": "#", ".sh": "#", ".ts": "//", ".tsx": "//", ".js": "//", ".mjs": "//", ".cjs": "//",
            ".kt": "//", ".swift": "//"}
MAGIC = b"jomaa-blind-1"
NONCE_BYTES = 16
GIT_ENV = {"GIT_AUTHOR_NAME": "pipeline", "GIT_AUTHOR_EMAIL": "pipeline@localhost",
           "GIT_COMMITTER_NAME": "pipeline", "GIT_COMMITTER_EMAIL": "pipeline@localhost"}
STAGES = ("instruction", "tests", "implement", "land", "ci", "merge", "deploy")
REBUILD_PREFIX = "Rebuild: "
FEEDBACK = "Feedback from the evaluation:\n\nRequirements not met: "


class StageFailed(PipelineError):
    def __init__(self, message: str, findings: list[dict] | None = None):
        super().__init__(message)
        self.findings = findings or []


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
    setup_ok = all(run_step(step, tree) for step in manifest["setup"])
    return {test["id"]: setup_ok and run_step(test, tree) for test in manifest["tests"]}


def run_step(step: dict, tree: Path) -> bool:
    argv = [sys.executable if a == "{python}" else a for a in step["command"]]
    return run_command(argv, tree / step["cwd"], CONFIG["testTimeoutSeconds"])[0] == 0


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


def added_lines(patch: str) -> list[str]:
    return [line[1:] for line in patch.splitlines() if line.startswith("+") and not line.startswith("+++")]


def fill(argv: list[str], values: dict[str, str]) -> list[str]:
    """Replace each {name} placeholder in the arguments; {python} is the interpreter, {pipeline} this folder."""
    values = {"python": sys.executable, "pipeline": str(HERE), **values}
    filled = []
    for arg in argv:
        for name, value in values.items():
            arg = arg.replace("{" + name + "}", value)
        filled.append(arg)
    return filled


# Git and workspaces.

def git(cwd: Path, *args: str, data: bytes | None = None, env: dict | None = None, identity: bool = True) -> bytes:
    """Run git; pipeline commits use the pipeline identity unless identity is False."""
    result = subprocess.run(["git", *args], cwd=cwd, input=data, capture_output=True,
                            env={**os.environ, **(GIT_ENV if identity else {}), **(env or {})})
    if result.returncode:
        raise PipelineError(f"git {' '.join(args)} failed: {result.stderr.decode().strip()}")
    return result.stdout


def remote_git(cwd: Path, *args: str, identity: bool = True) -> bytes:
    options = [arg for setting in CONFIG["landGitConfig"] for arg in ("-c", setting)]
    return git(cwd, *options, *args, identity=identity)


def rev(repo: Path, name: str) -> str:
    try:
        return git(repo, "rev-parse", "--verify", "--quiet", f"{name}^{{commit}}").decode().strip()
    except PipelineError:
        raise PipelineError(f"the revision {name!r} does not resolve") from None


def is_ancestor(repo: Path, older: str, newer: str) -> bool:
    return subprocess.run(["git", "merge-base", "--is-ancestor", older, newer], cwd=repo,
                          capture_output=True).returncode == 0


def fetch_landing(repo: Path) -> str:
    """The tip of the landing branch on the landing remote, fetched without touching local branches."""
    remote_git(repo, "fetch", "--quiet", "--no-tags", CONFIG["landRemote"], CONFIG["landBranch"])
    return rev(repo, "FETCH_HEAD")


def export(repo: Path, rev_: str, target: Path, patches: list[Path], components: list[str]) -> None:
    """A history-free copy of the repository at a revision with the patches applied, committed and tagged base."""
    if target.exists():
        raise PipelineError(f"{target} already exists")
    target.mkdir(parents=True)
    with tarfile.open(fileobj=io.BytesIO(git(repo, "archive", rev_))) as archive:
        archive.extractall(target, filter="tar")
    git(target, "init", "-q")
    for patch in patches:
        if patch.read_bytes().strip():
            git(target, "apply", "--binary", str(patch))
    git(target, "add", "-A")
    git(target, "commit", "-q", "--no-verify", "--allow-empty", "-m", BASE_TAG)
    git(target, "tag", BASE_TAG)
    for component in components:
        for step in CONFIG["prepare"].get(component, []):
            if run_command(step, target / component, CONFIG["testTimeoutSeconds"])[0]:
                raise PipelineError(f"preparing {component} failed: {' '.join(step)}")


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


def forget_sessions(*workspaces: Path) -> None:
    """Delete what Claude Code kept of sessions run in these workspaces, such as spilled tool output."""
    for workspace in workspaces:
        shutil.rmtree(expand(CONFIG["claudeProjectsDir"]) / slug(workspace), ignore_errors=True)


def components_of(repo: Path, base: str, tip: str) -> list[str]:
    """The prepare keys that name a top-level folder the change touches."""
    paths = git(repo, "diff", "--name-only", base, tip).decode().splitlines()
    touched = {p.split("/", 1)[0] for p in paths if "/" in p}
    return sorted(c for c in CONFIG["prepare"] if c in touched)


# Tasks and their journal.

class Task:
    def __init__(self, name: str):
        if not name or "/" in name or name.startswith("."):
            raise PipelineError(f"invalid task name: {name!r}")
        self.name = name
        self.dir = STATE / name
        self.work = WORK / name
        self.author_dir = self.work / "author"
        self.lock = threading.RLock()

    @property
    def state(self) -> dict:
        path = self.dir / "task.json"
        if not path.exists():
            raise PipelineError(f"no task {self.name}")
        return json.loads(path.read_text())

    def save(self, **changes_: object) -> dict:
        with self.lock:
            path = self.dir / "task.json"
            state = {**json.loads(path.read_text()), **changes_} if path.exists() else changes_
            partial = path.with_suffix(".partial")
            partial.write_text(json.dumps(state, indent=2) + "\n")
            partial.replace(path)
            return state

    def log(self, name: str) -> Path:
        (self.dir / "logs").mkdir(parents=True, exist_ok=True)
        return self.dir / "logs" / f"{name}.log"

    @property
    def instruction(self) -> str:
        return (self.dir / "instruction.md").read_text()

    def manifest(self) -> dict:
        path = self.author_dir / MANIFEST
        if not path.exists():
            raise PipelineError(f"the test author wrote no {MANIFEST}")
        try:
            return validate(json.loads(path.read_text()))
        except ValueError as error:
            raise PipelineError(f"{MANIFEST} is not JSON: {error}") from None


def say(message: str) -> None:
    print(f"{time.strftime('%H:%M:%S')} {message}", flush=True)


class Job:
    """One unattended run: the parent that dispatches every agent and decides every step."""

    def __init__(self, task: Task, repo: Path, mode: str, base: str, tip: str | None, components: list[str],
                 instruction: Path | None):
        self.task = task
        self.repo = repo
        self.mode = mode
        self.base = base
        self.tip = tip
        self.components = components
        self.given_instruction = instruction
        self.key: bytes | None = None
        self.workspaces: set[Path] = set()
        self.cost = 0.0
        self.spent = 0.0
        self.dispatches: list[dict] = []
        self.attempts: list[dict] = []
        self.findings: list[dict] = []
        self.report_extra = {"selected": None, "pullRequest": None, "commit": None, "deploy": None}
        self.land_dir = task.work / "land"
        self.stage: str | None = None

    # Bookkeeping.

    def enter(self, stage: str) -> None:
        if CHILDREN.interrupted.is_set():
            raise Interrupted()
        self.stage = stage
        self.task.save(stage=stage)
        say(f"stage {stage}")

    def record(self, entry: dict) -> int:
        with self.task.lock:
            self.dispatches.append(entry)
            self.task.save(dispatches=self.dispatches)
            return len(self.dispatches) - 1

    def update(self, index: int, **fields: object) -> None:
        with self.task.lock:
            self.dispatches[index].update(fields)
            self.task.save(dispatches=self.dispatches, costUsd=round(self.cost, 4))

    def workspace(self, name: str) -> Path:
        path = self.task.work / name
        self.workspaces.add(path)
        return path

    def fresh_export(self, name: str, rev_: str, patches: list[Path], prepared: bool = True) -> Path:
        path = self.workspace(name)
        shutil.rmtree(path, ignore_errors=True)
        forget_sessions(path)
        export(self.repo, rev_, path, patches, self.components if prepared else [])
        return path

    # Dispatch.

    def dispatch(self, role: str, workspace: Path | None, prompt: str, *, round_: int, attempt: int | None = None,
                 transcript: Path | None = None, resume: str | None = None, prepare=None) -> agents.Session:
        """Start one bounded session, validate its response, and retry a failed dispatch with a new session."""
        budget = CONFIG["roles"][role]["budgetUsd"]
        last: AgentFailed | None = None
        for _ in range(CONFIG["dispatchRetries"] + 1):
            if CHILDREN.interrupted.is_set():
                raise Interrupted()
            if self.spent >= CONFIG["maxCostUsd"]:
                raise StageFailed(f"the job reached maxCostUsd before dispatching the {role}")
            if prepare:
                workspace, resume = prepare(last)
            entry = {"role": role, "attempt": attempt, "round": round_, "outcome": "running", "costUsd": None,
                     "seconds": None}
            index = self.record(entry)
            label = f"{role}" + (f" attempt {attempt}" if attempt else "") + f" round {round_}"
            say(f"dispatch {label}")
            started = time.time()
            name = f"{role}-{attempt}-{round_}" if attempt else f"{role}-{round_}"
            try:
                session = self.session(role, workspace, prompt, self.task.log(name), transcript, resume)
            except AgentFailed as error:
                if CHILDREN.interrupted.is_set():
                    raise Interrupted() from None
                self.charge(error.cost, budget)
                self.update(index, outcome="failed", costUsd=error.cost, seconds=round(time.time() - started, 1),
                            detail=str(error)[:500])
                say(f"failed {label}: {error}")
                last = error
                continue
            self.charge(session.cost, budget)
            self.update(index, outcome="ok", costUsd=session.cost, seconds=round(time.time() - started, 1))
            say(f"done {label}")
            return session
        raise last

    @staticmethod
    def session(role: str, workspace: Path, prompt: str, log: Path, transcript: Path | None,
                resume: str | None) -> agents.Session:
        """One session whose response matches the role's schema; a mismatch fails it like a crash."""
        session = agents.run_agent(role, workspace, prompt, log, transcript, resume)
        try:
            agents.check_output(role, session.output)
        except AgentFailed as error:
            raise AgentFailed(str(error), session.session, session.cost) from None
        return session

    def charge(self, cost: float | None, budget: float) -> None:
        with self.task.lock:
            self.cost += cost or 0.0
            self.spent += cost if cost is not None else budget

    # Stages.

    def run(self) -> None:
        self.enter("instruction")
        export(self.repo, self.base, self.workspace("author"), [], self.components)
        if self.mode == "change":
            self.write_instruction()
        else:
            shutil.copyfile(self.given_instruction, self.task.dir / "instruction.md")
            review = self.dispatch("instruction-reviewer", self.task.author_dir,
                                   "Instruction to review:\n\n" + self.task.instruction, round_=1).output
            if review["verdict"] != APPROVE:
                raise StageFailed("the instruction reviewer asked for revisions", review["findings"])
        self.enter("tests")
        self.write_tests()
        self.enter("implement")
        selected = self.implement()
        self.enter("land")
        url = self.land(selected)
        self.enter("ci")
        code, _ = run_command(fill(CONFIG["waitForChecks"], {"pullRequest": url}), self.task.dir,
                              CONFIG["checksTimeoutSeconds"])
        if code:
            raise StageFailed(f"the pull request's checks did not pass: {url}")
        self.enter("merge")
        code, out = run_command(fill(CONFIG["mergePullRequest"], {"pullRequest": url}), self.task.dir,
                                CONFIG["checksTimeoutSeconds"], capture=True)
        lines = out.strip().splitlines()
        if code or not lines:
            raise StageFailed(f"merging the pull request failed: {url}")
        self.report_extra["commit"] = lines[-1].strip()
        self.enter("deploy")
        code, _ = run_command(fill(CONFIG["deployCheck"], {"commit": self.report_extra["commit"]}), self.task.dir,
                              CONFIG["deployTimeoutSeconds"])
        self.report_extra["deploy"] = "failed" if code else "succeeded"
        if code:
            raise StageFailed(f"the deploy of {self.report_extra['commit']} did not succeed")

    def write_instruction(self) -> None:
        """A spec-writer describes the change; the instruction reviewer approves it or sends findings back."""
        commits = git(self.repo, "log", "--format=commit %H%n%n%B", f"{self.base}..{self.tip}").decode()
        diff = git(self.repo, "diff", "--binary", self.base, self.tip).decode(errors="replace")
        prompt = (f"The change to describe is in this workspace: its commit messages are in "
                  f"{CHANGE_DIR}/commits.txt and its full diff from its parent is {CHANGE_DIR}/change.diff. "
                  "The workspace holds the repository with the change applied.")
        findings: list[dict] = []
        for number in range(1, CONFIG["reviewRounds"] + 1):
            def prepare(_failure, number=number):
                path = self.fresh_export(f"spec-{number}", self.tip, [], prepared=False)
                (path / CHANGE_DIR).mkdir(parents=True)
                (path / CHANGE_DIR / "commits.txt").write_text(commits)
                (path / CHANGE_DIR / "change.diff").write_text(diff)
                return path, None

            output = self.dispatch("spec-writer", None, prompt, round_=number, prepare=prepare).output
            (self.task.dir / "instruction.md").write_text(output["instruction"].rstrip() + "\n")
            review = self.dispatch("instruction-reviewer", self.task.author_dir,
                                   "Instruction to review:\n\n" + self.task.instruction, round_=number).output
            if review["verdict"] == APPROVE:
                return
            findings = review["findings"]
            prompt = (prompt + "\n\nYour previous instruction:\n\n" + self.task.instruction
                      + "\n\nThe reviewer asked for these revisions:\n\n" + json.dumps(findings, indent=2))
        raise StageFailed(f"the instruction had no approval after {CONFIG['reviewRounds']} reviews", findings)

    def write_tests(self) -> None:
        """The test author writes the refactor and hidden tests until they are approved and hold; then seal."""
        feedback: str | None = None
        findings: list[dict] = []
        for number in range(1, CONFIG["reviewRounds"] + 1):
            prompt = "Instruction:\n\n" + self.task.instruction
            if feedback:
                prompt += "\n\nReview of your previous attempt, still in this workspace:\n\n" + feedback
            self.dispatch("test-author", self.task.author_dir, prompt, round_=number)
            try:
                manifest = self.task.manifest()
            except PipelineError as error:
                findings = [{"where": "manifest", "problem": str(error), "fix": ""}]
                feedback = json.dumps(findings, indent=2)
                continue
            review = self.dispatch("test-reviewer", self.task.author_dir,
                                   "Instruction:\n\n" + self.task.instruction
                                   + f"\n\nThe hidden tests are listed in {MANIFEST}; the refactor is "
                                   f"`git diff {BASE_TAG} HEAD`; the tests are the untracked files.",
                                   round_=number).output
            if review["verdict"] != APPROVE:
                findings = review["findings"]
                feedback = json.dumps(findings, indent=2)
                continue
            findings = self.seal_problems(manifest)
            if findings:
                feedback = json.dumps(findings, indent=2)
                continue
            self.seal(manifest)
            return
        raise StageFailed(f"the tests had no approval after {CONFIG['reviewRounds']} reviews", findings)

    def seal_problems(self, manifest: dict) -> list[dict]:
        """Why the tests can't be sealed yet: stray files, tests that don't hold on the base, or on the original."""
        author = self.task.author_dir
        status = git(author, "status", "--porcelain", "--untracked-files=all").decode().splitlines()
        allowed = {str(MANIFEST), *manifest["files"]}
        stray = [line for line in status if not line.startswith("?? ") or line[3:] not in allowed]
        missing = [f for f in manifest["files"] if f"?? {f}" not in status]
        if stray or missing:
            return [{"where": "workspace", "problem": "only new manifest files may be uncommitted; commit the "
                     f"refactor. Unexpected: {stray}; missing or tracked: {missing}", "fix": ""}]
        problems = []
        tree = self.workspace("candidate")
        shutil.rmtree(tree, ignore_errors=True)
        try:
            export(author, "HEAD", tree, [], self.components)
            self.copy_tests(manifest, tree)
            for attempt in range(CONFIG["sealRuns"]):
                results = run_tests(manifest, tree)
                for test in manifest["tests"]:
                    if results[test["id"]] != (test["kind"] == "pass_to_pass"):
                        problems.append({"where": test["id"], "fix": "",
                                         "problem": f"run {attempt + 1}: {test['kind']} test "
                                         f"{'passed' if results[test['id']] else 'failed'} before the implementation"})
        finally:
            shutil.rmtree(tree, ignore_errors=True)
        if problems or self.mode != "change":
            return problems
        return self.original_problems(manifest)

    def copy_tests(self, manifest: dict, tree: Path) -> None:
        for path in manifest["files"]:
            (tree / path).parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(self.task.author_dir / path, tree / path)

    def original_problems(self, manifest: dict) -> list[dict]:
        """Every hidden test must pass on the original change with the refactor applied."""
        refactor = self.task.dir / "refactor.candidate.patch"
        refactor.write_bytes(git(self.task.author_dir, "diff", "--binary", BASE_TAG, "HEAD"))
        oracle = self.workspace("original")
        shutil.rmtree(oracle, ignore_errors=True)
        try:
            try:
                export(self.repo, self.tip, oracle, [refactor], self.components)
            except PipelineError as error:
                return [{"where": "refactor", "problem": "the refactor does not apply to a correct "
                         f"implementation of the instruction: {error}", "fix": ""}]
            self.copy_tests(manifest, oracle)
            failing: set[str] = set()
            for _ in range(CONFIG["sealRuns"]):
                results = run_tests(manifest, oracle)
                failing |= {test_id for test_id, passed in results.items() if not passed}
        finally:
            shutil.rmtree(oracle, ignore_errors=True)
            refactor.unlink(missing_ok=True)
        return [{"where": test_id, "problem": "this test fails against a correct implementation of the instruction",
                 "fix": ""} for test_id in sorted(failing)]

    def seal(self, manifest: dict) -> None:
        self.key, canary = secrets.token_bytes(32), secrets.token_hex(16)
        files = {f: add_canary(f, (self.task.author_dir / f).read_text(), canary) for f in manifest["files"]}
        bundle = {"manifest": manifest, "files": files, "canary": canary,
                  "hashes": {f: hashlib.sha256(t.encode()).hexdigest() for f, t in files.items()}}
        (self.task.dir / "sealed.bin").write_bytes(encrypt(self.key, json.dumps(bundle).encode()))
        (self.task.dir / "refactor.patch").write_bytes(
            git(self.task.author_dir, "diff", "--binary", BASE_TAG, "HEAD"))
        (self.task.dir / "tests.json").write_text(json.dumps(public(manifest), indent=2) + "\n")
        forget_sessions(self.task.author_dir)
        shutil.rmtree(self.task.author_dir)
        self.task.save(sealed=True)
        say(f"sealed {len(files)} files and {len(manifest['tests'])} tests")

    def bundle(self) -> dict:
        bundle = json.loads(decrypt(self.key, (self.task.dir / "sealed.bin").read_bytes()))
        for path, text in bundle["files"].items():
            if hashlib.sha256(text.encode()).hexdigest() != bundle["hashes"][path]:
                raise PipelineError(f"sealed test {path} does not match its hash")
        return bundle

    def implement(self) -> int:
        """Independent blind attempts, at most parallelAttempts at a time; the smallest qualifying one wins."""
        bundle = self.bundle()
        forbidden = []
        if self.mode == "change":
            forbidden = added_lines(git(self.repo, "diff", self.base, self.tip).decode(errors="replace"))
        numbers = range(1, CONFIG["attempts"] + 1)
        with concurrent.futures.ThreadPoolExecutor(max_workers=CONFIG["parallelAttempts"]) as pool:
            futures = [pool.submit(self.attempt, n, bundle, forbidden) for n in numbers]
            results = []
            for future in futures:
                try:
                    results.append(future.result())
                except StageFailed:
                    for other in futures:
                        other.cancel()
                    raise
        self.attempts = sorted(results, key=lambda a: a["number"])
        self.task.save(attempts=self.attempts)
        qualifying = [a for a in self.attempts if a["passed"] and a["audit"]]
        if not qualifying:
            raise StageFailed("no implementer attempt passed every hidden test and the audit")
        selected = min(qualifying, key=lambda a: (a["addedLines"], a["number"]))["number"]
        self.report_extra["selected"] = selected
        say(f"selected attempt {selected}")
        return selected

    def attempt(self, number: int, bundle: dict, forbidden: list[str]) -> dict:
        directory = self.task.dir / f"attempt-{number}"
        directory.mkdir(exist_ok=True)
        refactor = self.task.dir / "refactor.patch"
        name = f"attempt-{number}"
        result = {"number": number, "passed": False, "audit": False, "addedLines": None}
        session: str | None = None

        def first(_failure):
            return self.fresh_export(name, self.base, [refactor]), None

        def again(failure):
            return self.task.work / name, (failure.session if failure and failure.session else session)

        try:
            out = self.dispatch("implementer", None, self.task.instruction, round_=1, attempt=number,
                                transcript=directory / "trajectory-1.jsonl", prepare=first)
            session = out.session
            for round_ in range(1, CONFIG["feedbackRounds"] + 2):
                patch = changes(self.task.work / name)
                (directory / "implementation.patch").write_bytes(patch)
                unmet = self.evaluate(number, patch, bundle)
                result.update(passed=not unmet, addedLines=len(added_lines(patch.decode(errors="replace"))))
                if not unmet or round_ > CONFIG["feedbackRounds"]:
                    break
                out = self.dispatch("implementer", None, FEEDBACK + ", ".join(unmet), round_=round_ + 1,
                                    attempt=number, transcript=directory / f"trajectory-{round_ + 1}.jsonl",
                                    prepare=again)
                session = out.session or session
        except AgentFailed as error:
            say(f"attempt {number} is disqualified: {error}")
            return result
        result["audit"] = self.audit(number, bundle, forbidden)
        say(f"attempt {number}: tests {'pass' if result['passed'] else 'fail'}, "
            f"audit {'passes' if result['audit'] else 'fails'}, {result['addedLines']} added lines")
        return result

    def evaluate(self, number: int, patch: bytes, bundle: dict) -> list[str]:
        """The unmet requirement numbers of an attempt, from the sealed tests run on a fresh export."""
        patch_file = self.task.dir / f"attempt-{number}" / "implementation.patch"
        tree = self.workspace(f"evaluate-{number}")
        shutil.rmtree(tree, ignore_errors=True)
        try:
            try:
                export(self.repo, self.base, tree, [self.task.dir / "refactor.patch", patch_file], self.components)
            except PipelineError:
                return sorted({t["clause"] for t in bundle["manifest"]["tests"]})
            for path, text in bundle["files"].items():
                (tree / path).parent.mkdir(parents=True, exist_ok=True)
                (tree / path).write_text(text)
            results = run_tests(bundle["manifest"], tree)
        finally:
            shutil.rmtree(tree, ignore_errors=True)
        rows = [{**t, "passed": results[t["id"]]} for t in public(bundle["manifest"])]
        evaluations = sorted((self.task.dir / f"attempt-{number}").glob("evaluation-*.json"))
        (self.task.dir / f"attempt-{number}" / f"evaluation-{len(evaluations) + 1}.json").write_text(
            json.dumps({"tests": rows}, indent=2) + "\n")
        return sorted({row["clause"] for row in rows if not row["passed"]})

    def audit(self, number: int, bundle: dict, forbidden: list[str]) -> bool:
        directory = self.task.dir / f"attempt-{number}"
        paths = sorted(directory.glob("trajectory-*.jsonl"))
        workspace = self.task.work / f"attempt-{number}"
        texts = [*bundle["files"].values(), "\n".join(forbidden)]
        visible = visible_text(workspace)
        secret = {line for line in anticheat.secret_lines(texts, CONFIG["secretLineLength"]) if line not in visible}
        scope = Scope(workspace, agents.role_tools("implementer"))
        result = anticheat.report(anticheat.audit(paths, scope, secret), paths)
        (directory / "audit.json").write_text(json.dumps(result, indent=2) + "\n")
        return bool(result["passed"])

    # Landing.

    def rebuilt_tree(self, selected: int) -> str:
        """The tree of the base plus the refactor, the selected implementation and the tests without canary."""
        bundle = self.bundle()
        with tempfile.TemporaryDirectory() as scratch:
            env = {"GIT_INDEX_FILE": str(Path(scratch) / "index")}
            git(self.land_dir, "read-tree", self.base, env=env)
            for patch in (self.task.dir / "refactor.patch",
                          self.task.dir / f"attempt-{selected}" / "implementation.patch"):
                if patch.read_bytes().strip():
                    git(self.land_dir, "apply", "--cached", "--binary", str(patch), env=env)
            for path, text in bundle["files"].items():
                blob = git(self.land_dir, "hash-object", "-w", "--stdin",
                           data=strip_canary(text).encode()).decode().strip()
                git(self.land_dir, "update-index", "--add", "--cacheinfo", f"100644,{blob},{path}", env=env)
            return git(self.land_dir, "write-tree", env=env).decode().strip()

    def title(self) -> str:
        heading = next((line[2:].strip() for line in self.task.instruction.splitlines() if line.startswith("# ")),
                       self.task.name)
        return REBUILD_PREFIX + heading if self.mode == "change" else heading

    def body(self, selected: int, with_instruction: bool) -> str:
        lines = [f"Base: {self.base}"]
        if self.tip:
            lines.append(f"Tip: {self.tip}")
        lines.append(f"Selected attempt: {selected} of {CONFIG['attempts']}")
        text = "\n".join(lines) + "\n"
        if with_instruction:
            text += "\n## Instruction\n\n" + self.task.instruction
        return text

    def land(self, selected: int) -> str:
        """Commit the replacement on a fresh checkout of the landing branch, push it and open a pull request."""
        landing = fetch_landing(self.repo)
        self.workspaces.add(self.land_dir)
        git(self.repo, "worktree", "add", "--quiet", "--detach", str(self.land_dir), landing)
        tree = self.rebuilt_tree(selected)
        replacement = git(self.land_dir, "diff", "--binary", self.tip or self.base, tree)
        if not replacement.strip():
            raise StageFailed("the rebuilt change is identical to what it replaces")
        patch = self.task.dir / "replacement.patch"
        patch.write_bytes(replacement)
        try:
            git(self.land_dir, "apply", "--3way", "--index", "--binary", str(patch))
        except PipelineError as error:
            raise StageFailed(f"the replacement does not apply to the landing branch: {error}") from None
        for check in CONFIG["landChecks"]:
            if run_command(fill(check, {}), self.land_dir, CONFIG["testTimeoutSeconds"])[0]:
                raise StageFailed(f"the land check failed: {' '.join(check)}")
        message = self.task.dir / "commit-message.txt"
        message.write_text(self.title() + "\n\n" + self.body(selected, False))
        git(self.land_dir, "commit", "-q", "-F", str(message), identity=False)
        branch = fill([CONFIG["pullRequestBranch"]], {"task": self.task.name})[0]
        try:
            remote_git(self.land_dir, "push", "--quiet", CONFIG["landRemote"], f"HEAD:refs/heads/{branch}")
        except PipelineError as error:
            raise StageFailed(f"the push was rejected: {error}") from None
        body = self.task.dir / "pull-request.md"
        body.write_text(self.body(selected, True))
        code, out = run_command(fill(CONFIG["openPullRequest"], {
            "branch": branch, "base": CONFIG["landBranch"], "title": self.title(), "bodyFile": str(body)}),
            self.land_dir, CONFIG["testTimeoutSeconds"], capture=True)
        lines = out.strip().splitlines()
        if code or not lines:
            raise StageFailed("opening the pull request failed")
        url = lines[-1].strip()
        self.report_extra["pullRequest"] = url
        self.task.save(pullRequest=url)
        say(f"opened {url}")
        return url

    # Report and cleanup.

    def report(self, outcome: str, stage: str | None, interrupted: bool) -> dict:
        report = {"task": self.task.name, "mode": self.mode, "base": self.base, "tip": self.tip,
                  "outcome": outcome, "stage": stage, "interrupted": interrupted,
                  "findings": self.findings if stage in ("instruction", "tests") else [],
                  "dispatches": [{k: d[k] for k in ("role", "attempt", "round", "outcome", "costUsd")}
                                 for d in self.dispatches],
                  "costUsd": round(self.cost, 4), "attempts": self.attempts, **self.report_extra}
        REPORTS.mkdir(parents=True, exist_ok=True)
        (REPORTS / f"{self.task.name}.json").write_text(json.dumps(report, indent=2) + "\n")
        return report

    def cleanup(self, landed: bool) -> None:
        if self.land_dir.exists():
            subprocess.run(["git", "worktree", "remove", "--force", str(self.land_dir)], cwd=self.repo,
                           capture_output=True)
        subprocess.run(["git", "worktree", "prune"], cwd=self.repo, capture_output=True)
        forget_sessions(*self.workspaces, *(p for p in self.task.work.glob("*") if p.is_dir()))
        shutil.rmtree(self.task.work, ignore_errors=True)
        if landed:
            shutil.rmtree(self.task.dir, ignore_errors=True)


# Commands.

def parse_change(repo: Path, change: str) -> tuple[str, str]:
    if ".." in change:
        older, _, newer = change.partition("..")
        if not older or not newer or newer.startswith("."):
            raise PipelineError(f"a range is from..to: {change!r}")
        return rev(repo, older), rev(repo, newer)
    tip = rev(repo, change)
    return rev(repo, f"{tip}^1"), tip


def prepare_job(args: argparse.Namespace) -> Job:
    """Check everything that can be checked before any agent runs or any task state exists."""
    task = Task(args.task)
    if task.dir.exists() or task.work.exists():
        raise PipelineError(f"task {task.name} already exists; run clean first")
    repo = Path(git(args.repo, "rev-parse", "--show-toplevel").decode().strip())
    if args.instruction and not args.instruction.is_file():
        raise PipelineError(f"the instruction file {args.instruction} does not exist")
    try:
        landing = fetch_landing(repo)
    except PipelineError as error:
        raise PipelineError(f"fetching {CONFIG['landBranch']} from {CONFIG['landRemote']} failed: {error}") from None
    if args.instruction:
        base = rev(repo, args.base) if args.base else landing
        return Job(task, repo, "instruction", base, None, args.components, args.instruction)
    base, tip = parse_change(repo, args.change)
    if not is_ancestor(repo, base, tip):
        raise PipelineError(f"{base[:12]} is not an ancestor of {tip[:12]}")
    if not is_ancestor(repo, tip, landing):
        raise PipelineError(f"{tip[:12]} is not on {CONFIG['landBranch']} at {CONFIG['landRemote']}")
    if not git(repo, "diff", "--name-only", base, tip).strip():
        raise PipelineError("the change touches no file")
    return Job(task, repo, "change", base, tip, components_of(repo, base, tip), None)


def keep_awake() -> subprocess.Popen | None:
    argv = fill(CONFIG["keepAwake"], {"pid": str(os.getpid())})
    if not argv:
        return None
    try:
        return subprocess.Popen(argv, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except OSError as error:
        say(f"could not keep the computer awake: {error}")
        return None


def cmd_run(args: argparse.Namespace) -> int:
    job = prepare_job(args)
    task = job.task
    task.dir.mkdir(parents=True)
    task.save(repo=str(job.repo), mode=job.mode, base=job.base, tip=job.tip, components=job.components,
              stage=None, dispatches=[], costUsd=0, sealed=False, pullRequest=None, pid=os.getpid())
    CHILDREN.reset()

    def interrupt(_signum, _frame):
        say("stopping every agent session and command")
        CHILDREN.stop_all()

    previous = {s: signal.signal(s, interrupt) for s in (signal.SIGINT, signal.SIGTERM)}
    awake = keep_awake()
    outcome, stage, interrupted = "failed", None, False
    try:
        job.run()
        if CHILDREN.interrupted.is_set():
            raise Interrupted()
        outcome = "landed"
    except Interrupted:
        stage, interrupted = job.stage, True
        say(f"interrupted at stage {stage}")
    except StageFailed as error:
        stage, job.findings = job.stage, error.findings
        say(f"failed at stage {stage}: {error}")
    except (PipelineError, OSError, subprocess.SubprocessError) as error:
        stage, interrupted = job.stage, CHILDREN.interrupted.is_set()
        say(f"failed at stage {stage}: {error}")
    finally:
        for s, handler in previous.items():
            signal.signal(s, handler)
        CHILDREN.stop_all()
        CHILDREN.reset()
        if awake:
            awake.terminate()
    job.task.save(stage=stage, outcome=outcome, interrupted=interrupted)
    report = job.report(outcome, stage, interrupted)
    job.cleanup(outcome == "landed")
    say(f"{outcome}" + (f" at stage {stage}" if stage else "") + f"; report: {REPORTS / (task.name + '.json')}")
    return 0 if report["outcome"] == "landed" else 1


def cmd_status(args: argparse.Namespace) -> int:
    print(json.dumps(Task(args.task).state, indent=2))
    return 0


def cmd_clean(args: argparse.Namespace) -> int:
    task = Task(args.task)
    forget_sessions(*(p for p in task.work.glob("*") if p.is_dir()))
    shutil.rmtree(task.work, ignore_errors=True)
    shutil.rmtree(task.dir, ignore_errors=True)
    print(f"Removed task {task.name}")
    return 0


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = root.add_subparsers(dest="command", required=True)
    run = commands.add_parser("run", help="run a whole job from an instruction or from a landed change")
    run.add_argument("task")
    source = run.add_mutually_exclusive_group(required=True)
    source.add_argument("--instruction", type=Path, help="an instruction file to build")
    source.add_argument("--change", help="a landed change to rebuild: <rev> or <from>..<to>")
    run.add_argument("--base", help="the base revision of an instruction; the landing branch's tip by default")
    run.add_argument("--components", nargs="*", default=[], help="folders whose prepare steps run")
    run.add_argument("--repo", default=Path.cwd(), type=Path)
    run.set_defaults(handler=cmd_run)
    for name, handler, text in (("status", cmd_status, "show a task's stage and dispatches"),
                                ("clean", cmd_clean, "remove a task's state and workspaces")):
        sub = commands.add_parser(name, help=text)
        sub.add_argument("task")
        sub.set_defaults(handler=handler)
    return root


def main(argv: list[str] | None = None) -> int:
    root = parser()
    args = root.parse_args(argv)
    if args.command == "run" and args.change and (args.base or args.components):
        root.error("--base and --components go with --instruction")
    try:
        return args.handler(args)
    except (PipelineError, OSError, subprocess.CalledProcessError) as error:
        print(f"pipeline: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

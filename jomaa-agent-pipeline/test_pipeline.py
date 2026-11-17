"""The pipeline job end to end with stand-in agents, a bare landing remote and stand-in GitHub commands."""
import contextlib
import io
import json
import os
import signal
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import agents
import pipeline
from scope import CONFIG

HERE = Path(__file__).resolve().parent
INSTRUCTION = "# Multiply\n\n## Requirements\n\nR1. calc.mul(a, b) returns a times b.\n"
ADD_TEST = "    def test_add_keeps_working(self):\n        self.assertEqual(calc.add(2, 3), 5)\n"
MUL_TEST = "    def test_mul_multiplies_two_numbers(self):\n        self.assertEqual(calc.mul(4, 5), 20)\n"
WRONG_TEST = "    def test_mul_of_two_twos(self):\n        self.assertEqual(calc.mul(2, 2), 5)\n"
ORIGINAL_MUL = "\n\ndef mul(a, b):\n    return a * b  # the product of the two numbers given\n"
TEST_HEADER = "import unittest\n\nimport calc\n\n\nclass Blind(unittest.TestCase):\n"
MANIFEST = {
    "setup": [],
    "tests": [
        {"id": "mul", "kind": "fail_to_pass", "clause": "R1", "cwd": ".",
         "command": ["{python}", "-m", "unittest", "test_blind.Blind.test_mul_multiplies_two_numbers"]},
        {"id": "add", "kind": "pass_to_pass", "clause": "R2", "cwd": ".",
         "command": ["{python}", "-m", "unittest", "test_blind.Blind.test_add_keeps_working"]},
    ],
    "files": ["test_blind.py"],
}
FAKE_COMMANDS = r'''
import json, sys
from pathlib import Path
root, name, args = Path(sys.argv[1]), sys.argv[2], sys.argv[3:]
body = Path(args[-1]).read_text() if name == "create" else None
with (root / "commands.log").open("a") as log:
    log.write(json.dumps({"name": name, "args": args, "body": body}) + "\n")
exit_file = root / f"{name}.exit"
code = int(exit_file.read_text()) if exit_file.exists() else 0
if code == 0 and name == "create":
    print("https://example.test/pull/1")
if code == 0 and name == "merge":
    print("f" * 40)
sys.exit(code)
'''
APPROVE = {"schema": "jomaa-pipeline.instruction-reviewer.v1", "verdict": "approve", "findings": []}
TESTS_APPROVE = {"schema": "jomaa-pipeline.test-reviewer.v1", "verdict": "approve", "findings": []}
REVISE = {"schema": "jomaa-pipeline.instruction-reviewer.v1", "verdict": "revise",
          "findings": [{"where": "R1", "problem": "Negative numbers are not covered.", "fix": "Say what happens."}]}


def git(cwd, *args):
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout


def response(role, **fields):
    return agents.Session({"schema": f"jomaa-pipeline.{role}.v1", **fields}, None, 0.5)


class JobTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()
        gitconfig = self.root / "gitconfig"
        gitconfig.write_text("[user]\n\tname = Agent\n\temail = agent@example.test\n")
        self.patch(mock.patch.dict(os.environ, {"GIT_CONFIG_GLOBAL": str(gitconfig), "GIT_CONFIG_NOSYSTEM": "1"}))
        self.repo = self.root / "repo"
        self.repo.mkdir()
        git(self.repo, "init", "-q", "-b", "main")
        git(self.repo, "config", "user.name", "Owner")
        git(self.repo, "config", "user.email", "owner@example.test")
        (self.repo / "calc.py").write_text("def add(a, b):\n    return a + b\n")
        git(self.repo, "add", "-A")
        git(self.repo, "commit", "-q", "-m", "calc")
        self.remote = self.root / "remote.git"
        git(self.root, "clone", "-q", "--bare", str(self.repo), str(self.remote))
        self.instruction = self.root / "instruction.md"
        self.instruction.write_text(INSTRUCTION)
        fake = self.root / "fake_commands.py"
        fake.write_text(FAKE_COMMANDS)
        command = [sys.executable, str(fake), str(self.root)]
        for name, value in (("STATE_ROOT", self.root / "state"), ("STATE", self.root / "state" / "tasks"),
                            ("REPORTS", self.root / "state" / "reports"), ("WORK", self.root / "work")):
            self.patch(mock.patch.object(pipeline, name, value))
        self.patch(mock.patch.dict(CONFIG, {
            "claudeProjectsDir": str(self.root / "projects"), "landRemote": str(self.remote),
            "landGitConfig": [], "landChecks": [["{python}", "-c", "pass"]], "keepAwake": [],
            "attempts": 1, "parallelAttempts": 1, "reviewRounds": 2, "dispatchRetries": 1, "feedbackRounds": 1,
            "sealRuns": 1, "maxCostUsd": 100, "pullRequestBranch": "pipeline/{task}",
            "openPullRequest": [*command, "create", "{branch}", "{base}", "{title}", "{bodyFile}"],
            "waitForChecks": [*command, "checks", "{pullRequest}"],
            "mergePullRequest": [*command, "merge", "{pullRequest}"],
            "deployCheck": [*command, "deploy", "{commit}"]}))
        self.prompts = {}
        self.agents = {"spec-writer": lambda *a: response("spec-writer", instruction=INSTRUCTION),
                       "instruction-reviewer": lambda *a: agents.Session(APPROVE, None, 0.5),
                       "test-author": self.author,
                       "test-reviewer": lambda *a: agents.Session(TESTS_APPROVE, None, 0.5),
                       "implementer": self.implementer}
        self.patch(mock.patch.object(agents, "run_agent", self.fake_agent))
        self.keys = []
        encrypt = pipeline.encrypt
        self.patch(mock.patch.object(pipeline, "encrypt", lambda key, data: (self.keys.append(key),
                                                                             encrypt(key, data))[1]))

    def patch(self, patcher):
        patcher.start()
        self.addCleanup(patcher.stop)

    def tearDown(self):
        self.tmp.cleanup()

    def fake_agent(self, role, workspace, prompt, log, transcript=None, resume=None):
        self.prompts.setdefault(role, []).append((prompt, resume))
        return self.agents[role](workspace, prompt, transcript, resume)

    def run_main(self, *argv):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            code = pipeline.main(list(argv))
        return code, out.getvalue()

    def run_job(self, *extra, task="t"):
        source = list(extra) or ["--instruction", str(self.instruction)]
        return self.run_main("run", task, *source, "--repo", str(self.repo))

    def report(self, task="t"):
        return json.loads((pipeline.REPORTS / f"{task}.json").read_text())

    def commands(self):
        log = self.root / "commands.log"
        return [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []

    def author(self, workspace, prompt, transcript, resume, tests=(MUL_TEST, ADD_TEST), manifest=MANIFEST):
        if "Arithmetic." not in (workspace / "calc.py").read_text():
            (workspace / "calc.py").write_text('"""Arithmetic."""\n\n\ndef add(a, b):\n    return a + b\n')
            git(workspace, "commit", "-q", "-am", "Describe the module")
        (workspace / "test_blind.py").write_text(TEST_HEADER + "\n".join(tests))
        (workspace / ".blind").mkdir(exist_ok=True)
        (workspace / ".blind/manifest.json").write_text(json.dumps(manifest))
        return response("test-author", summary="Wrote mul (R1) and add (R2).")

    def implementer(self, workspace, prompt, transcript, resume, body="    return a * b\n"):
        self.assertFalse((workspace / "test_blind.py").exists())
        if "def mul" not in (workspace / "calc.py").read_text():
            with (workspace / "calc.py").open("a") as source:
                source.write("\n\ndef mul(a, b):\n" + body)
        transcript.write_text("")
        return agents.Session({"schema": "jomaa-pipeline.implementer.v1", "summary": "Added mul.",
                               "assumptions": []}, "session-1", 2.0)

    def land_original_change(self):
        with (self.repo / "calc.py").open("a") as source:
            source.write(ORIGINAL_MUL)
        git(self.repo, "commit", "-q", "-am", "Multiply two numbers")
        git(self.repo, "push", "-q", str(self.remote), "main")


class InstructionJobTest(JobTestCase):
    def test_lands_the_change_through_a_pull_request(self):
        code, out = self.run_job()
        self.assertEqual(code, 0, out)
        report = self.report()
        self.assertEqual((report["outcome"], report["stage"], report["mode"]), ("landed", None, "instruction"))
        self.assertEqual((report["selected"], report["pullRequest"], report["commit"], report["deploy"]),
                         (1, "https://example.test/pull/1", "f" * 40, "succeeded"))
        self.assertEqual([d["role"] for d in report["dispatches"]],
                         ["instruction-reviewer", "test-author", "test-reviewer", "implementer"])
        self.assertEqual(report["costUsd"], 3.5)
        self.assertEqual(report["attempts"], [{"number": 1, "passed": True, "audit": True, "addedLines": 4}])

        branch = "refs/heads/pipeline/t"
        self.assertIn("def mul", git(self.remote, "show", f"{branch}:calc.py"))
        self.assertIn('"""Arithmetic."""', git(self.remote, "show", f"{branch}:calc.py"))
        landed_tests = git(self.remote, "show", f"{branch}:test_blind.py")
        self.assertIn("test_mul_multiplies_two_numbers", landed_tests)
        self.assertNotIn(pipeline.CANARY, landed_tests)
        self.assertEqual(git(self.remote, "log", "-1", "--format=%s|%an", branch).strip(), "Multiply|Owner")

        names = [c["name"] for c in self.commands()]
        self.assertEqual(names, ["create", "checks", "merge", "deploy"])
        create = self.commands()[0]
        self.assertEqual(create["args"][:3], ["pipeline/t", "main", "Multiply"])
        self.assertIn("Selected attempt: 1", create["body"])
        self.assertIn(INSTRUCTION.strip(), create["body"])
        self.assertEqual(self.commands()[3]["args"], ["f" * 40])

        self.assertEqual(git(self.repo, "branch", "--format=%(refname:short)").split(), ["main"])
        self.assertEqual(len(git(self.repo, "worktree", "list").splitlines()), 1)
        self.assertEqual(git(self.repo, "status", "--porcelain"), "")
        self.assertFalse(pipeline.Task("t").dir.exists())
        self.assertFalse(pipeline.Task("t").work.exists())
        self.assertEqual(self.run_main("status", "t")[0], 1)

    def test_never_shows_or_stores_the_key(self):
        code, out = self.run_job()
        self.assertEqual(code, 0, out)
        key = self.keys[0].hex()
        self.assertNotIn(key, out)
        for path in (self.root / "state").rglob("*"):
            if path.is_file():
                self.assertNotIn(key.encode(), path.read_bytes())

    def test_revised_instruction_stops_the_job_with_findings(self):
        self.agents["instruction-reviewer"] = lambda *a: agents.Session(REVISE, None, 0.5)
        code, out = self.run_job()
        self.assertEqual(code, 1)
        report = self.report()
        self.assertEqual((report["outcome"], report["stage"]), ("failed", "instruction"))
        self.assertEqual(report["findings"], REVISE["findings"])
        self.assertEqual(report["attempts"], [])
        self.assertNotIn("test-author", self.prompts)
        self.assertTrue(pipeline.Task("t").dir.exists())
        self.assertFalse(pipeline.Task("t").work.exists())
        self.assertEqual(json.loads(self.run_main("status", "t")[1])["stage"], "instruction")

    def test_invalid_response_is_retried_as_a_new_session(self):
        replies = [agents.Session({"schema": "jomaa-pipeline.test-reviewer.v1", "verdict": "approve"}, None, 0.5),
                   agents.Session(TESTS_APPROVE, None, 0.5)]
        self.agents["test-reviewer"] = lambda *a: replies.pop(0)
        code, out = self.run_job()
        self.assertEqual(code, 0, out)
        reviews = [d for d in self.report()["dispatches"] if d["role"] == "test-reviewer"]
        self.assertEqual([d["outcome"] for d in reviews], ["failed", "ok"])

    def test_a_dispatch_failing_every_retry_fails_its_stage(self):
        def crash(*a):
            raise agents.AgentFailed("the session crashed", None, 0.25)

        self.agents["test-author"] = crash
        code, _ = self.run_job()
        self.assertEqual(code, 1)
        report = self.report()
        self.assertEqual(report["stage"], "tests")
        self.assertEqual([d["outcome"] for d in report["dispatches"][1:]], ["failed", "failed"])
        self.assertEqual(report["costUsd"], 1.0)

    def test_cost_cap_stops_dispatching(self):
        CONFIG["maxCostUsd"] = 1
        code, _ = self.run_job()
        self.assertEqual(code, 1)
        report = self.report()
        self.assertEqual(report["stage"], "tests")
        self.assertEqual([d["role"] for d in report["dispatches"]], ["instruction-reviewer", "test-author"])

    def test_test_review_findings_go_back_to_the_author(self):
        revise = {**TESTS_APPROVE, "verdict": "revise",
                  "findings": [{"where": "mul", "problem": "Too narrow.", "fix": "Cover zero."}]}
        replies = [agents.Session(revise, None, 0.5), agents.Session(TESTS_APPROVE, None, 0.5)]
        self.agents["test-reviewer"] = lambda *a: replies.pop(0)
        code, out = self.run_job()
        self.assertEqual(code, 0, out)
        self.assertIn("Cover zero.", self.prompts["test-author"][1][0])

    def test_tests_that_already_pass_are_not_sealed(self):
        def author(workspace, prompt, transcript, resume):
            self.author(workspace, prompt, transcript, resume)
            if "def mul" not in (workspace / "calc.py").read_text():
                with (workspace / "calc.py").open("a") as source:
                    source.write("\n\ndef mul(a, b):\n    return a * b\n")
                git(workspace, "commit", "-q", "-am", "Leak the feature")
            return response("test-author", summary="Done.")

        self.agents["test-author"] = author
        code, _ = self.run_job()
        self.assertEqual(code, 1)
        self.assertEqual(self.report()["stage"], "tests")
        self.assertIn("fail_to_pass test passed before the implementation", self.prompts["test-author"][1][0])
        self.assertFalse((pipeline.Task("t").dir / "sealed.bin").exists())

    def test_unmet_requirements_resume_the_same_session(self):
        calls = []

        def implementer(workspace, prompt, transcript, resume):
            calls.append((prompt, resume))
            transcript.write_text("")
            if len(calls) == 2:
                return self.implementer(workspace, prompt, transcript, resume)
            return agents.Session({"schema": "jomaa-pipeline.implementer.v1", "summary": "Nothing yet.",
                                   "assumptions": []}, "session-1", 1.0)

        self.agents["implementer"] = implementer
        code, out = self.run_job()
        self.assertEqual(code, 0, out)
        self.assertEqual(calls[1], ("Feedback from the evaluation:\n\nRequirements not met: R1", "session-1"))

    def test_the_smallest_qualifying_attempt_is_selected(self):
        CONFIG.update(attempts=3, parallelAttempts=3)

        def implementer(workspace, prompt, transcript, resume):
            number = int(workspace.name.split("-")[1])
            if number == 3:
                transcript.write_text("")
                return agents.Session({"schema": "jomaa-pipeline.implementer.v1", "summary": "No.",
                                       "assumptions": []}, "s", 1.0)
            body = "    product = a * b\n    return product\n" if number == 1 else "    return a * b\n"
            return self.implementer(workspace, prompt, transcript, resume, body)

        self.agents["implementer"] = implementer
        code, out = self.run_job()
        self.assertEqual(code, 0, out)
        report = self.report()
        self.assertEqual(report["selected"], 2)
        self.assertEqual([(a["number"], a["passed"]) for a in report["attempts"]], [(1, True), (2, True), (3, False)])
        self.assertLess(report["attempts"][1]["addedLines"], report["attempts"][0]["addedLines"])

    def test_no_qualifying_attempt_lands_nothing(self):
        def implementer(workspace, prompt, transcript, resume):
            transcript.write_text("")
            return agents.Session({"schema": "jomaa-pipeline.implementer.v1", "summary": "No.",
                                   "assumptions": []}, "s", 1.0)

        self.agents["implementer"] = implementer
        code, _ = self.run_job()
        self.assertEqual(code, 1)
        self.assertEqual(self.report()["stage"], "implement")
        self.assertEqual(self.commands(), [])
        self.assertNotIn("pipeline/t", git(self.remote, "branch"))

    def test_failed_checks_leave_the_pull_request_open(self):
        (self.root / "checks.exit").write_text("1")
        code, _ = self.run_job()
        self.assertEqual(code, 1)
        report = self.report()
        self.assertEqual((report["stage"], report["pullRequest"], report["commit"]),
                         ("ci", "https://example.test/pull/1", None))
        self.assertEqual([c["name"] for c in self.commands()], ["create", "checks"])

    def test_failed_merge_and_failed_deploy(self):
        (self.root / "merge.exit").write_text("1")
        self.assertEqual(self.run_job()[0], 1)
        self.assertEqual(self.report()["stage"], "merge")
        (self.root / "merge.exit").unlink()
        (self.root / "deploy.exit").write_text("1")
        self.assertEqual(self.run_job(task="u")[0], 1)
        report = self.report("u")
        self.assertEqual((report["stage"], report["commit"], report["deploy"]), ("deploy", "f" * 40, "failed"))

    def test_a_failing_land_check_pushes_nothing(self):
        CONFIG["landChecks"] = [["{python}", "-c", "raise SystemExit(1)"]]
        code, _ = self.run_job()
        self.assertEqual(code, 1)
        self.assertEqual(self.report()["stage"], "land")
        self.assertNotIn("pipeline/t", git(self.remote, "branch"))
        self.assertEqual(len(git(self.repo, "worktree", "list").splitlines()), 1)

    def test_a_conflicting_landing_branch_pushes_nothing(self):
        base = git(self.repo, "rev-parse", "HEAD").strip()
        (self.repo / "calc.py").write_text('"""Calculator."""\n\n\ndef add(a, b):\n    return a + b\n')
        git(self.repo, "commit", "-q", "-am", "Name the module")
        git(self.repo, "push", "-q", str(self.remote), "main")
        code, out = self.run_job("--instruction", str(self.instruction), "--base", base)
        self.assertEqual(code, 1, out)
        self.assertEqual(self.report()["stage"], "land")
        self.assertNotIn("pipeline/t", git(self.remote, "branch"))

    def test_interrupt_stops_the_job(self):
        def author(workspace, prompt, transcript, resume):
            os.kill(os.getpid(), signal.SIGTERM)
            return self.author(workspace, prompt, transcript, resume)

        self.agents["test-author"] = author
        code, _ = self.run_job()
        self.assertEqual(code, 1)
        report = self.report()
        self.assertEqual((report["outcome"], report["stage"], report["interrupted"]), ("failed", "tests", True))
        self.assertFalse(pipeline.Task("t").work.exists())


class ChangeJobTest(JobTestCase):
    def setUp(self):
        super().setUp()
        self.land_original_change()

    def test_rebuilds_a_landed_change(self):
        def spec_writer(workspace, prompt, transcript, resume):
            self.assertIn("def mul", (workspace / ".blind/change/change.diff").read_text())
            self.assertIn("Multiply two numbers", (workspace / ".blind/change/commits.txt").read_text())
            self.assertIn("def mul", (workspace / "calc.py").read_text())
            return response("spec-writer", instruction=INSTRUCTION)

        self.agents["spec-writer"] = spec_writer
        code, out = self.run_job("--change", "HEAD")
        self.assertEqual(code, 0, out)
        report = self.report()
        self.assertEqual((report["mode"], report["outcome"]), ("change", "landed"))
        self.assertEqual(report["tip"], git(self.repo, "rev-parse", "HEAD").strip())
        self.assertEqual(report["base"], git(self.repo, "rev-parse", "HEAD^").strip())
        self.assertEqual(report["dispatches"][0]["role"], "spec-writer")
        landed = git(self.remote, "show", "refs/heads/pipeline/t:calc.py")
        self.assertIn("    return a * b\n", landed)
        self.assertNotIn("the product of the two numbers", landed)
        self.assertIn('"""Arithmetic."""', landed)
        self.assertEqual(git(self.remote, "log", "-1", "--format=%s", "refs/heads/pipeline/t").strip(),
                         "Rebuild: Multiply")
        self.assertIn("Tip: ", self.commands()[0]["body"])

    def test_reviewer_findings_go_back_to_a_new_spec_writer(self):
        replies = [agents.Session(REVISE, None, 0.5), agents.Session(APPROVE, None, 0.5)]
        self.agents["instruction-reviewer"] = lambda *a: replies.pop(0)
        code, out = self.run_job("--change", "HEAD")
        self.assertEqual(code, 0, out)
        second = self.prompts["spec-writer"][1][0]
        self.assertIn("Negative numbers are not covered.", second)
        self.assertIn("Your previous instruction", second)

    def test_spec_writer_rounds_run_out(self):
        self.agents["instruction-reviewer"] = lambda *a: agents.Session(REVISE, None, 0.5)
        self.assertEqual(self.run_job("--change", "HEAD")[0], 1)
        report = self.report()
        self.assertEqual((report["stage"], len(self.prompts["spec-writer"])), ("instruction", 2))
        self.assertEqual(report["findings"], REVISE["findings"])

    def test_tests_that_fail_on_the_original_go_back_to_the_author(self):
        wrong = {**MANIFEST, "tests": [*MANIFEST["tests"], {
            "id": "twos", "kind": "fail_to_pass", "clause": "R1", "cwd": ".",
            "command": ["{python}", "-m", "unittest", "test_blind.Blind.test_mul_of_two_twos"]}]}
        rounds = []

        def author(workspace, prompt, transcript, resume):
            rounds.append(prompt)
            if len(rounds) == 1:
                return self.author(workspace, prompt, transcript, resume, (MUL_TEST, ADD_TEST, WRONG_TEST), wrong)
            return self.author(workspace, prompt, transcript, resume)

        self.agents["test-author"] = author
        code, out = self.run_job("--change", "HEAD")
        self.assertEqual(code, 0, out)
        self.assertIn('"where": "twos"', rounds[1])
        self.assertIn("fails against a correct implementation", rounds[1])
        self.assertNotIn('"where": "mul"', rounds[1])

    def test_reading_the_original_change_disqualifies_an_attempt(self):
        def implementer(workspace, prompt, transcript, resume):
            session = self.implementer(workspace, prompt, transcript, resume)
            read = {"type": "user", "message": {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "t1", "content": ORIGINAL_MUL}]}}
            transcript.write_text(json.dumps(read) + "\n")
            return session

        self.agents["implementer"] = implementer
        self.assertEqual(self.run_job("--change", "HEAD")[0], 1)
        report = self.report()
        self.assertEqual(report["stage"], "implement")
        self.assertEqual(report["attempts"], [{"number": 1, "passed": True, "audit": False, "addedLines": 4}])

    def test_refusals_before_any_state(self):
        git(self.repo, "checkout", "-q", "-b", "side")
        (self.repo / "side.py").write_text("x = 1\n")
        git(self.repo, "add", "-A")
        git(self.repo, "commit", "-q", "-m", "side")
        cases = {"HEAD": "is not on main", "HEAD~1..HEAD~1": "touches no file", "nope": "does not resolve",
                 "HEAD..HEAD~2": "is not an ancestor"}
        for change, message in cases.items():
            with self.subTest(change=change):
                code, out = self.run_job("--change", change)
                self.assertEqual(code, 1)
                self.assertIn(message, out)
                self.assertFalse(pipeline.STATE.exists())
                self.assertEqual(self.prompts, {})
        self.assertIn("does not exist", self.run_job("--instruction", str(self.root / "missing.md"))[1])

    def test_an_existing_task_is_refused(self):
        pipeline.Task("t").dir.mkdir(parents=True)
        code, out = self.run_job("--change", "HEAD")
        self.assertEqual(code, 1)
        self.assertIn("already exists", out)

    def test_components_are_the_touched_prepare_folders(self):
        with mock.patch.dict(CONFIG, {"prepare": {"calc": [], "other": []}}):
            (self.repo / "calc").mkdir()
            (self.repo / "calc" / "x.py").write_text("x = 1\n")
            git(self.repo, "add", "-A")
            git(self.repo, "commit", "-q", "-m", "x")
            head = git(self.repo, "rev-parse", "HEAD").strip()
            self.assertEqual(pipeline.components_of(self.repo, f"{head}^", head), ["calc"])


class AgentSessionTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def fake_claude(self, records):
        script = self.root / "claude"
        lines = "".join(json.dumps(r) + "\n" for r in records)
        script.write_text(f"#!{sys.executable}\nimport sys\nsys.stdin.read()\nsys.stdout.write({lines!r})\n")
        script.chmod(script.stat().st_mode | stat.S_IEXEC)
        return str(script)

    def run_fake(self, records, turns):
        role = {**CONFIG["roles"]["test-reviewer"], "maxTurns": turns}
        with mock.patch.object(agents, "claude", return_value=self.fake_claude(records)), \
                mock.patch.dict(CONFIG["roles"], {"test-reviewer": role}):
            return agents.run_agent("test-reviewer", self.root, "prompt", self.root / "log")

    def test_structured_output_and_cost(self):
        records = [{"type": "system", "session_id": "s-1"},
                   {"type": "assistant", "message": {"id": "m1"}},
                   {"type": "result", "is_error": False, "total_cost_usd": 0.75, "structured_output": TESTS_APPROVE}]
        session = self.run_fake(records, 5)
        self.assertEqual((session.output, session.session, session.cost), (TESTS_APPROVE, "s-1", 0.75))

    def test_turn_limit_stops_the_session(self):
        records = [{"type": "assistant", "message": {"id": f"m{i}"}} for i in range(4)]
        with self.assertRaisesRegex(agents.AgentFailed, "maxTurns"):
            self.run_fake(records, 2)

    def test_missing_structured_output_fails(self):
        with self.assertRaisesRegex(agents.AgentFailed, "no structured output"):
            self.run_fake([{"type": "result", "is_error": False, "result": "done"}], 5)

    def test_command_deadline(self):
        code, _ = agents.run_command([sys.executable, "-c", "import time; time.sleep(5)"], self.root, 0.3)
        self.assertEqual(code, -1)

    def test_agent_command_line(self):
        with mock.patch.object(agents, "claude", return_value="claude"):
            argv = agents.agent_argv("implementer", Path("/w"), "s-1")
        self.assertIn("--restricted", argv)
        self.assertEqual(argv[argv.index("--resume") + 1], "s-1")
        self.assertNotIn("--no-session-persistence", argv)
        self.assertEqual(json.loads(argv[argv.index("--json-schema") + 1]), agents.schema("implementer"))
        self.assertIn(agents.STRUCTURED_OUTPUT, argv[argv.index("--allowedTools") + 1].split(","))
        self.assertNotIn(agents.STRUCTURED_OUTPUT, argv[argv.index("--tools") + 1].split(","))
        hook = json.loads(argv[argv.index("--settings") + 1])["hooks"]["PreToolUse"][0]["hooks"][0]["command"]
        self.assertIn(agents.STRUCTURED_OUTPUT, hook)
        with mock.patch.object(agents, "claude", return_value="claude"):
            self.assertIn("--no-session-persistence", agents.agent_argv("test-author", Path("/w"), None))


class PartsTest(unittest.TestCase):
    def test_encryption_round_trip(self):
        key = b"k" * 32
        sealed = pipeline.encrypt(key, b"secret tests")
        self.assertNotIn(b"secret", sealed)
        self.assertEqual(pipeline.decrypt(key, sealed), b"secret tests")
        self.assertNotEqual(pipeline.encrypt(key, b"secret tests"), sealed)
        with self.assertRaises(pipeline.PipelineError):
            pipeline.decrypt(b"x" * 32, sealed)
        data = bytearray(sealed)
        data[-1] ^= 1
        with self.assertRaises(pipeline.PipelineError):
            pipeline.decrypt(key, bytes(data))

    def test_manifest_validation(self):
        self.assertEqual(pipeline.validate(json.loads(json.dumps(MANIFEST)))["files"], ["test_blind.py"])
        broken = [
            lambda m: m.update(extra=1),
            lambda m: m.update(files=["../outside.py"]),
            lambda m: m.update(files=[]),
            lambda m: m["tests"][1].update(id="mul"),
            lambda m: m["tests"][0].update(kind="sometimes"),
            lambda m: m["tests"][0].update(clause=""),
            lambda m: m["tests"][0].update(command=[]),
            lambda m: m["tests"][0].update(kind="pass_to_pass"),
        ]
        for change in broken:
            manifest = json.loads(json.dumps(MANIFEST))
            change(manifest)
            with self.subTest(manifest=manifest), self.assertRaises(pipeline.PipelineError):
                pipeline.validate(manifest)

    def test_canary_lines(self):
        marked = pipeline.add_canary("t.py", "#!/usr/bin/env python3\nx = 1\n", "abc")
        self.assertEqual(marked, "#!/usr/bin/env python3\n# blind-canary: abc\nx = 1\n")
        self.assertEqual(pipeline.strip_canary(marked), "#!/usr/bin/env python3\nx = 1\n")
        self.assertTrue(pipeline.add_canary("t.ts", "x\n", "abc").startswith("// blind-canary: abc\n"))
        self.assertEqual(pipeline.add_canary("t.json", "{}", "abc"), "{}")

    def test_placeholders(self):
        self.assertEqual(pipeline.fill(["{python}", "--x={task}", "{pipeline}/a"], {"task": "t"}),
                         [sys.executable, "--x=t", f"{HERE}/a"])

    def test_response_schemas(self):
        for role in CONFIG["roles"]:
            with self.subTest(role=role):
                spec = agents.schema(role)
                self.assertEqual(spec["properties"]["schema"]["const"], f"jomaa-pipeline.{role}.v1")
        self.assertEqual(agents.schema_errors(APPROVE, agents.schema("instruction-reviewer")), [])
        bad = [{**APPROVE, "verdict": "maybe"}, {**APPROVE, "extra": 1}, {"verdict": "approve", "findings": []},
               {**APPROVE, "findings": [{"where": "R1"}]}, {**APPROVE, "schema": "jomaa-pipeline.other.v1"}]
        for value in bad:
            with self.subTest(value=value):
                self.assertTrue(agents.schema_errors(value, agents.schema("instruction-reviewer")))


class ConfigDocTest(unittest.TestCase):
    def test_config_md_documents_every_setting(self):
        doc = (HERE / "config.md").read_text()
        keys = [*CONFIG, *(f"roles.<role>.{key}" for role in CONFIG["roles"].values() for key in role),
                *(f"github.{key}" for key in CONFIG["github"])]
        for key in keys:
            self.assertIn(f"`{key}`", doc, f"config.md does not document {key}")

    def test_every_role_has_a_prompt_and_a_schema(self):
        self.assertEqual({p.stem for p in (HERE / "prompts").glob("*.md")}, set(CONFIG["roles"]))
        self.assertEqual({p.stem for p in (HERE / "schemas").glob("*.json")}, set(CONFIG["roles"]))


if __name__ == "__main__":
    unittest.main()

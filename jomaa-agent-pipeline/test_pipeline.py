"""The pipeline from start to land, with stand-in agents, plus sealing, manifests and the config doc."""
import contextlib
import io
import json
import re
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import pipeline
from scope import CONFIG

HERE = Path(__file__).resolve().parent
APPROVE = 'Looks complete.\n{"verdict": "approve", "findings": []}'
ADD_TEST = "    def test_add_keeps_working(self):\n        self.assertEqual(calc.add(2, 3), 5)\n"
MUL_TEST = "    def test_mul_multiplies_two_numbers(self):\n        self.assertEqual(calc.mul(4, 5), 20)\n"
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


def git(cwd, *args):
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True,
                          env={**pipeline.os.environ, **pipeline.GIT_ENV}).stdout


class PipelineTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()
        self.repo = self.root / "repo"
        self.repo.mkdir()
        (self.repo / "calc.py").write_text("def add(a, b):\n    return a + b\n")
        git(self.repo, "init", "-q")
        git(self.repo, "add", "-A")
        git(self.repo, "commit", "-q", "-m", "calc")
        self.instruction = self.root / "instruction.md"
        self.instruction.write_text("# Multiply\n## Requirements\nR1. calc.mul(a, b) returns a times b.\n")
        for name, value in (("STATE", self.root / "state"), ("WORK", self.root / "work")):
            patcher = mock.patch.object(pipeline, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.projects = self.root / "projects"
        patcher = mock.patch.dict(pipeline.CONFIG, {"claudeProjectsDir": str(self.projects)})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.agents = {}
        patcher = mock.patch.object(pipeline, "run_agent", self.fake_agent)
        patcher.start()
        self.addCleanup(patcher.stop)

    def tearDown(self):
        self.tmp.cleanup()

    def fake_agent(self, role, workspace, prompt, log, transcript=None, resume=None):
        return self.agents[role](workspace, prompt, transcript, resume)

    def run_main(self, *argv):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            code = pipeline.main(list(argv))
        return code, out.getvalue()

    def author(self, workspace, prompt, transcript, resume):
        (workspace / "calc.py").write_text('"""Arithmetic."""\n\n\ndef add(a, b):\n    return a + b\n')
        git(workspace, "commit", "-q", "-am", "Describe the module")
        (workspace / "test_blind.py").write_text(
            "import unittest\n\nimport calc\n\n\nclass Blind(unittest.TestCase):\n" + MUL_TEST + "\n" + ADD_TEST)
        (workspace / ".blind").mkdir()
        (workspace / ".blind/manifest.json").write_text(json.dumps(MANIFEST))
        return "Wrote mul (R1) and add (R2).", None

    def implementer(self, workspace, prompt, transcript, resume):
        self.assertNotIn("test_blind.py", {p.name for p in workspace.iterdir()})
        with (workspace / "calc.py").open("a") as source:
            source.write("\n\ndef mul(a, b):\n    return a * b\n")
        events = [{"type": "assistant", "message": {"role": "assistant", "content": [
            {"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "python3 -m unittest"}}]}}]
        transcript.write_text("".join(json.dumps(e) + "\n" for e in events))
        return "Added mul.", "session-1"

    def through_seal(self):
        self.agents = {"instruction-reviewer": lambda *a: (APPROVE, None), "test-author": self.author,
                       "test-reviewer": lambda *a: (APPROVE, None), "implementer": self.implementer}
        start = ["start", "t", "--instruction", str(self.instruction), "--repo", str(self.repo)]
        for argv in (start, ["review-instruction", "t"], ["author", "t"], ["review-tests", "t"]):
            code, out = self.run_main(*argv)
            self.assertEqual(code, 0, out)
        spilled = self.projects / pipeline.slug(pipeline.Task("t").author_dir) / "s" / "tool-results"
        spilled.mkdir(parents=True)
        (spilled / "out.txt").write_text(MUL_TEST)
        code, out = self.run_main("seal", "t")
        self.assertEqual(code, 0, out)
        self.assertFalse(spilled.exists())
        return re.search(r"^KEY ([0-9a-f]{64})$", out, re.M)[1]


class FlowTest(PipelineTestCase):
    def test_from_start_to_land(self):
        key = self.through_seal()
        task = pipeline.Task("t")
        self.assertFalse(task.author_dir.exists())
        self.assertNotIn(b"test_mul", (task.dir / "sealed.bin").read_bytes())
        self.assertIn("Arithmetic.", (task.dir / "refactor.patch").read_text())
        self.assertEqual(self.run_main("implement", "t")[0], 0)
        self.assertIn('"""Arithmetic."""', (task.implement_dir / "calc.py").read_text())
        code, out = self.run_main("evaluate", "t", "--key", key)
        self.assertEqual(code, 0, out)
        self.assertIn("All hidden tests pass.", out)
        self.assertFalse(task.evaluate_dir.exists())
        self.assertEqual(self.run_main("audit", "t", "--key", key)[0], 0)

        land = self.root / "land"
        git(self.root, "clone", "-q", str(self.repo), str(land))
        self.assertEqual(self.run_main("land", "t", "--key", key, "--into", str(land))[0], 0)
        landed = (land / "test_blind.py").read_text()
        self.assertNotIn(pipeline.CANARY, landed)
        self.assertIn("def mul", (land / "calc.py").read_text())

    def test_evaluate_names_unmet_requirements(self):
        key = self.through_seal()
        self.agents["implementer"] = lambda workspace, prompt, transcript, resume: (
            transcript.write_text(""), ("Nothing.", "session-1"))[1]
        self.run_main("implement", "t")
        code, out = self.run_main("evaluate", "t", "--key", key)
        self.assertEqual(code, 1)
        self.assertIn("Requirements not met: R1", out)
        self.assertNotIn("test_mul", out)

    def test_feedback_resumes_the_same_session(self):
        self.through_seal()
        self.run_main("implement", "t")
        seen = []
        self.agents["implementer"] = lambda workspace, prompt, transcript, resume: (
            seen.append((prompt, resume)), transcript.write_text(""), ("Fixed.", resume))[2]
        self.assertEqual(self.run_main("implement", "t", "--feedback", "Requirements not met: R1")[0], 0)
        self.assertEqual(seen, [("Feedback from the evaluation:\n\nRequirements not met: R1", "session-1")])
        self.assertTrue((pipeline.Task("t").dir / "trajectory-2.jsonl").exists())

    def test_interrupted_implementer_can_be_resumed(self):
        self.through_seal()

        def interrupted(workspace, prompt, transcript, resume):
            transcript.write_text("")
            raise pipeline.AgentFailed("the implementer session failed", "session-1")

        self.agents["implementer"] = interrupted
        self.assertEqual(self.run_main("implement", "t")[0], 1)
        self.assertEqual((pipeline.Task("t").state["round"], pipeline.Task("t").state["session"]), (1, "session-1"))
        self.agents["implementer"] = self.implementer
        self.assertEqual(self.run_main("implement", "t", "--feedback", "Continue where you stopped.")[0], 0)

    def test_audit_fails_when_a_hidden_test_line_was_read(self):
        key = self.through_seal()
        self.run_main("implement", "t")
        leak = [{"type": "user", "message": {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": "t1", "content": MUL_TEST}]}}]
        (pipeline.Task("t").dir / "trajectory-2.jsonl").write_text(json.dumps(leak[0]) + "\n")
        code, out = self.run_main("audit", "t", "--key", key)
        self.assertEqual(code, 1, out)
        self.assertIn("leak", out)

    def test_audit_ignores_secret_lines_inside_longer_base_lines(self):
        key = self.through_seal()
        self.run_main("implement", "t")
        original = self.root / "original.txt"
        original.write_text("    return a + b  # with a comment long enough\n" + "def add(a, b):\n    return a + b\n")
        read = {"type": "user", "message": {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": "t1", "content": "def add(a, b):\n    return a + b\n"}]}}
        (pipeline.Task("t").dir / "trajectory-2.jsonl").write_text(json.dumps(read) + "\n")
        code, out = self.run_main("audit", "t", "--key", key, "--forbid", str(original))
        self.assertEqual(code, 0, out)

    def test_wrong_key_or_changed_bundle_is_refused(self):
        self.through_seal()
        self.run_main("implement", "t")
        self.assertEqual(self.run_main("evaluate", "t", "--key", "00" * 32)[0], 1)
        sealed = pipeline.Task("t").dir / "sealed.bin"
        data = bytearray(sealed.read_bytes())
        data[-1] ^= 1
        sealed.write_bytes(bytes(data))
        with self.assertRaises(pipeline.PipelineError):
            pipeline.decrypt(b"\0" * 32, bytes(data))


class GateTest(PipelineTestCase):
    def test_author_waits_for_an_approved_instruction(self):
        self.agents = {"instruction-reviewer": lambda *a: ('{"verdict": "revise", "findings": [{}]}', None)}
        self.run_main("start", "t", "--instruction", str(self.instruction), "--repo", str(self.repo))
        self.assertEqual(self.run_main("review-instruction", "t")[0], 3)
        code, out = self.run_main("author", "t")
        self.assertEqual(code, 1)
        self.assertIn("no approving review", out)

    def test_seal_refuses_a_fail_to_pass_test_that_already_passes(self):
        def author(workspace, prompt, transcript, resume):
            self.author(workspace, prompt, transcript, resume)
            with (workspace / "calc.py").open("a") as source:
                source.write("\n\ndef mul(a, b):\n    return a * b\n")
            git(workspace, "commit", "-q", "-am", "Leak the feature")
            return "", None

        self.agents = {"instruction-reviewer": lambda *a: (APPROVE, None), "test-author": author,
                       "test-reviewer": lambda *a: (APPROVE, None)}
        self.run_main("start", "t", "--instruction", str(self.instruction), "--repo", str(self.repo))
        for argv in (["review-instruction", "t"], ["author", "t"], ["review-tests", "t"]):
            self.run_main(*argv)
        code, out = self.run_main("seal", "t")
        self.assertEqual(code, 1)
        self.assertIn("mul (fail_to_pass) passed before the implementation", out)
        self.assertFalse((pipeline.Task("t").dir / "sealed.bin").exists())

    def test_seal_refuses_tests_changed_after_review(self):
        self.agents = {"instruction-reviewer": lambda *a: (APPROVE, None), "test-author": self.author,
                       "test-reviewer": lambda *a: (APPROVE, None)}
        self.run_main("start", "t", "--instruction", str(self.instruction), "--repo", str(self.repo))
        for argv in (["review-instruction", "t"], ["author", "t"], ["review-tests", "t"]):
            self.run_main(*argv)
        with (pipeline.Task("t").author_dir / "test_blind.py").open("a") as tests:
            tests.write("# changed\n")
        code, out = self.run_main("seal", "t")
        self.assertEqual(code, 1)
        self.assertIn("no approving review", out)


class PartsTest(unittest.TestCase):
    def test_encryption_round_trip(self):
        key = b"k" * 32
        sealed = pipeline.encrypt(key, b"secret tests")
        self.assertNotIn(b"secret", sealed)
        self.assertEqual(pipeline.decrypt(key, sealed), b"secret tests")
        self.assertNotEqual(pipeline.encrypt(key, b"secret tests"), sealed)
        with self.assertRaises(pipeline.PipelineError):
            pipeline.decrypt(b"x" * 32, sealed)

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

    def test_reviewer_verdict_is_the_last_valid_object(self):
        text = 'Example {"verdict": "approve"} then\n{"verdict": "revise", "findings": [{"where": "R1"}]}'
        self.assertEqual(pipeline.verdict(text)["verdict"], "revise")
        with self.assertRaises(pipeline.PipelineError):
            pipeline.verdict("no verdict here")

    def test_agent_command_line(self):
        with mock.patch.object(pipeline, "claude", return_value="claude"):
            argv = pipeline.agent_argv("implementer", Path("/w"), "s-1")
        self.assertIn("--restricted", argv)
        self.assertIn("--strict-mcp-config", argv)
        self.assertEqual(argv[argv.index("--resume") + 1], "s-1")
        self.assertNotIn("--no-session-persistence", argv)
        hook = json.loads(argv[argv.index("--settings") + 1])["hooks"]["PreToolUse"][0]
        self.assertIn("guard.py", hook["hooks"][0]["command"])
        with mock.patch.object(pipeline, "claude", return_value="claude"):
            self.assertIn("--no-session-persistence", pipeline.agent_argv("test-author", Path("/w"), None))


class ConfigDocTest(unittest.TestCase):
    def test_config_md_documents_every_setting(self):
        doc = (HERE / "config.md").read_text()
        keys = [*CONFIG, *(f"roles.<role>.{key}" for role in CONFIG["roles"].values() for key in role)]
        for key in keys:
            self.assertIn(f"`{key}`", doc, f"config.md does not document {key}")

    def test_every_role_has_a_prompt(self):
        self.assertEqual({p.stem for p in (HERE / "prompts").glob("*.md")}, set(CONFIG["roles"]))


if __name__ == "__main__":
    unittest.main()

"""The workspace boundary and the guard hook built on it."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import guard
from scope import Scope

HERE = Path(__file__).resolve().parent
TOOLS = ["Bash", "Read", "Edit", "Write", "Glob", "Grep"]


class ScopeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()
        self.workspace = self.root / "workspace"
        (self.workspace / "pkg").mkdir(parents=True)
        (self.root / "secret").mkdir()
        self.scope = Scope(self.workspace, TOOLS)

    def tearDown(self):
        self.tmp.cleanup()

    def bash(self, command, cwd=None):
        return self.scope.violations("Bash", {"command": command}, cwd)

    def test_allows_work_inside_the_workspace(self):
        for command in ["ls", "cat pkg/a.py", f"cat {self.workspace}/pkg/a.py", "python3 -m unittest -q",
                        "git log --oneline", "grep -rn x . 2>/dev/null | head", "sed -e '/^import/d' pkg/a.py",
                        "cd pkg && cat ../README.md", "/usr/bin/env python3 -V", "echo $PATH",
                        "for f in *.py; do echo ${f}; done"]:
            with self.subTest(command=command):
                self.assertEqual(self.bash(command), [])
        self.assertEqual(self.scope.violations("Read", {"file_path": str(self.workspace / "pkg/a.py")}), [])
        self.assertEqual(self.scope.violations("Glob", {"pattern": "**/*.py"}), [])

    def test_denies_paths_outside_the_workspace(self):
        for command in [f"cat {self.root}/secret/s.txt", "cat ~/.claude/projects/x.jsonl", "ls $HOME",
                        "ls ${TMPDIR}", "cat ../secret/s.txt", "cd .. && cat secret/s.txt", "ls /",
                        f"git -C {self.root} log", f"python3 --file={self.root}/secret/s.txt"]:
            with self.subTest(command=command):
                self.assertNotEqual(self.bash(command), [])
        self.assertNotEqual(self.bash("cat ../../secret/s.txt", cwd=self.workspace / "pkg"), [])
        for tool, key in [("Read", "file_path"), ("Write", "file_path"), ("Edit", "file_path"), ("Grep", "path")]:
            with self.subTest(tool=tool):
                self.assertNotEqual(self.scope.violations(tool, {key: str(self.root / "secret/s.txt")}), [])
        self.assertNotEqual(self.scope.violations("Glob", {"pattern": f"{self.root}/secret/*"}), [])

    def test_allows_only_its_own_sessions_background_output(self):
        outputs = self.root / "claude" / self.scope.slug
        own = f"cat {outputs}/session-1/tasks/b1.output"
        self.assertEqual(self.scope.violations("Bash", {"command": own}, None, "session-1"), [])
        self.assertEqual(self.scope.violations("Read", {"file_path": f"{outputs}/session-1/tasks/b1.output"},
                                               None, "session-1"), [])
        for command, session in [(own, "session-2"), (own, None),
                                 (f"cat {outputs}/session-1/b1.output", "session-1"),
                                 (f"cat {self.root}/claude/other/session-1/tasks/b1.output", "session-1"),
                                 (f"cat {outputs}/session-1/tasks/../../../secret/s.txt", "session-1")]:
            with self.subTest(command=command, session=session):
                self.assertNotEqual(self.scope.violations("Bash", {"command": command}, None, session), [])

    def test_denies_the_network(self):
        for command in ["curl -s example.org", "python3 -c 'import urllib' https://example.org",
                        "git fetch origin", "git clone x", "gh pr list", "npm install left-pad",
                        "cd pkg && wget x"]:
            with self.subTest(command=command):
                self.assertNotEqual(self.bash(command), [])

    def test_denies_tools_outside_the_role(self):
        self.assertNotEqual(Scope(self.workspace, ["Read"]).violations("Bash", {"command": "ls"}), [])
        self.assertNotEqual(self.scope.violations("WebFetch", {"url": "x"}), [])


class GuardTest(unittest.TestCase):
    def run_guard(self, workspace, event):
        return subprocess.run([sys.executable, str(HERE / "guard.py"), "--workspace", str(workspace),
                               "--tools", ",".join(TOOLS)], input=event, capture_output=True, text=True)

    def test_hook_denies_escapes_and_stays_silent_otherwise(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            event = {"cwd": tmp, "tool_name": "Bash", "tool_input": {"command": "cat ~/.ssh/id_rsa"}}
            result = self.run_guard(workspace, json.dumps(event))
            decision = json.loads(result.stdout)["hookSpecificOutput"]
            self.assertEqual((decision["hookEventName"], decision["permissionDecision"]), ("PreToolUse", "deny"))
            event["tool_input"]["command"] = "ls"
            self.assertEqual(self.run_guard(workspace, json.dumps(event)).stdout, "")

    def test_hook_denies_what_it_cannot_read(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = self.run_guard(Path(tmp), "not json")
            self.assertEqual(json.loads(result.stdout)["hookSpecificOutput"]["permissionDecision"], "deny")
            decision = guard.decide(Scope(Path(tmp), TOOLS), {"tool_name": "Read", "tool_input": {"file_path": 3}})
            self.assertIsNone(decision)
            decision = guard.decide(Scope(Path(tmp), TOOLS), {"tool_name": "Bash", "tool_input": None, "cwd": 5})
            self.assertEqual(decision["hookSpecificOutput"]["permissionDecision"], "deny")


if __name__ == "__main__":
    unittest.main()

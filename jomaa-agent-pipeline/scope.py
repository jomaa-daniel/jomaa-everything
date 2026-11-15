"""The workspace boundary of a pipeline agent: which tool calls stay inside it.

A call leaves the boundary when it names a path outside the workspace and the
system paths, refers to the home or temporary directory through a variable or
`~`, reaches the network, or uses a tool the agent's role does not have.
"""
from __future__ import annotations

import json
import os
import re
import shlex
from pathlib import Path

HERE = Path(__file__).resolve().parent
CONFIG = json.loads((HERE / "config.json").read_text())

FILE_TOOLS = {"Read": ("file_path",), "Write": ("file_path",), "Edit": ("file_path",),
              "MultiEdit": ("file_path",), "NotebookEdit": ("notebook_path",),
              "Glob": ("path",), "Grep": ("path",)}
HIDDEN_VARIABLES = re.compile(r"\$\{?(HOME|TMPDIR|USER|LOGNAME|OLDPWD|CLAUDE\w*)\b")
NETWORK_COMMANDS = {"curl", "wget", "gh", "ssh", "scp", "sftp", "rsync", "nc", "ncat", "telnet", "ftp"}
NETWORK_SUBCOMMANDS = {"git": {"clone", "fetch", "pull", "push", "remote", "ls-remote", "submodule"},
                       "npm": {"install", "i", "ci", "add", "update", "view", "info"},
                       "pip": {"install", "download"}, "pip3": {"install", "download"}}
URL = re.compile(r"\b[a-z][a-z0-9+.-]*://", re.IGNORECASE)
SEPARATORS = {"&&", "||", ";", "|", "&", "(", ")", "\n"}
OUTPUTS = "tasks"


def expand(path: str) -> Path:
    return Path(os.path.expanduser(path)).resolve()


def slug(path: Path) -> str:
    """The name Claude Code gives the folder of a working directory's sessions."""
    return re.sub(r"[^A-Za-z0-9]", "-", str(path.resolve()))


SYSTEM_PATHS = [expand(p) for p in CONFIG["systemPaths"]]


class Scope:
    """Checks tool calls against one workspace and one role's tools."""

    def __init__(self, workspace: Path, tools: list[str]):
        self.workspace = workspace.resolve()
        self.tools = set(tools)
        self.slug = slug(self.workspace)

    def own_output(self, path: Path, session: str | None) -> bool:
        """A background command's output file of this agent's own session, kept by Claude Code."""
        return bool(session) and path.parent.name == OUTPUTS and path.parent.parent.name == session \
            and path.parent.parent.parent.name == self.slug and ".." not in path.parts

    def inside(self, path: Path, session: str | None = None) -> bool:
        resolved = path.resolve()
        return self.own_output(resolved, session) or any(
            resolved == root or root in resolved.parents for root in [self.workspace, *SYSTEM_PATHS])

    def path_problem(self, value: str, cwd: Path, session: str | None = None) -> str | None:
        if value.startswith("~") or HIDDEN_VARIABLES.search(value):
            return f"refers to a directory outside the workspace: {value}"
        path = Path(value)
        if path.is_absolute():
            parts = path.parts
            if len(parts) > 1 and not Path(parts[0], parts[1]).exists():
                return None
        elif ".." not in path.parts:
            return None
        if not self.inside(path if path.is_absolute() else cwd / path, session):
            return f"names a path outside the workspace: {value}"
        return None

    def violations(self, tool: str, arguments: dict, cwd: Path | None = None,
                   session: str | None = None) -> list[str]:
        cwd = (cwd or self.workspace).resolve()
        if tool not in self.tools:
            return [f"uses {tool}, which this role does not have"]
        if tool == "Bash":
            return self.command_violations(str(arguments.get("command", "")), cwd, session)
        found = []
        for key in FILE_TOOLS.get(tool, ()):
            value = arguments.get(key)
            if isinstance(value, str) and value:
                problem = self.path_problem(value, cwd, session)
                if problem:
                    found.append(f"{tool} {problem}")
        pattern = arguments.get("pattern") if tool == "Glob" else None
        if isinstance(pattern, str) and (pattern.startswith(("/", "~")) or ".." in Path(pattern).parts):
            problem = self.path_problem(pattern, cwd)
            if problem:
                found.append(f"Glob {problem}")
        return found

    def command_violations(self, command: str, cwd: Path, session: str | None = None) -> list[str]:
        found = []
        if URL.search(command):
            found.append("Bash reaches the network: the command contains a URL")
        if HIDDEN_VARIABLES.search(command):
            found.append("Bash refers to a directory outside the workspace through a variable")
        try:
            lexer = shlex.shlex(command, posix=True, punctuation_chars=True)
            lexer.whitespace_split = True
            tokens = list(lexer)
        except ValueError:
            return found + ["Bash command could not be parsed; quote it plainly"]
        start = True
        words: list[str] = []
        for token in tokens:
            if token in SEPARATORS or set(token) <= set("&|;()<>"):
                start = True
                words = []
                continue
            words.append(token)
            name = os.path.basename(token)
            if start and name in NETWORK_COMMANDS:
                found.append(f"Bash reaches the network with {name}")
            if len(words) >= 2 and words[-1] in NETWORK_SUBCOMMANDS.get(os.path.basename(words[0]), ()):
                found.append(f"Bash reaches the network with {os.path.basename(words[0])} {words[-1]}")
            start = False
            value = token.split("=", 1)[1] if token.startswith("-") and "=" in token else token
            problem = self.path_problem(value, cwd, session)
            if problem:
                found.append(f"Bash {problem}")
            elif len(words) == 2 and words[0] == "cd":
                cwd = (cwd / value).resolve()
        return list(dict.fromkeys(found))

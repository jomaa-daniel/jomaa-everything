#!/usr/bin/env python3
"""The pipeline's default GitHub commands, through the gh CLI.

create <branch> <base> <title> <body-file>   open a pull request; prints its URL
checks <pull-request>                        wait for every check; exit 0 when none failed
merge <pull-request>                         merge and delete the branch; prints the merge commit
deploy <commit>                              wait for the deploy workflow run of a commit;
                                             exit 0 when its deploy job succeeded
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from pathlib import Path

from scope import CONFIG

SETTINGS = CONFIG["github"]
PASSING = {"pass", "skipping"}
PENDING = "pending"
SUCCESS = "success"
COMPLETED = "completed"
GITHUB_REMOTE = re.compile(r"github\.com[:/]([^/]+/[^/]+?)(?:\.git)?/?$")


def gh(*args: str) -> str:
    result = subprocess.run([SETTINGS["gh"], *args], capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(f"gh {' '.join(args)} failed: {result.stderr.strip()}")
    return result.stdout


def repository() -> str:
    """The owner/name of the landing remote, which is a URL or the name of a remote of this checkout."""
    remote = CONFIG["landRemote"]
    if "/" not in remote and ":" not in remote:
        remote = subprocess.run(["git", "remote", "get-url", remote], capture_output=True, text=True,
                                check=True).stdout.strip()
    match = GITHUB_REMOTE.search(remote)
    if not match:
        raise RuntimeError(f"the landing remote is not a GitHub repository: {remote}")
    return match[1]


def create(branch: str, base: str, title: str, body: Path) -> int:
    print(gh("pr", "create", "--repo", repository(), "--head", branch, "--base", base, "--title", title,
             "--body-file", str(body)).strip())
    return 0


def checks(pull_request: str) -> int:
    """Poll until two polls in a row see the same finished checks; succeed when each passed or was skipped."""
    previous = None
    while True:
        result = subprocess.run([SETTINGS["gh"], "pr", "checks", pull_request, "--json", "name,bucket"],
                                capture_output=True, text=True)
        try:
            found = json.loads(result.stdout) if result.stdout.strip() else []
        except ValueError:
            found = []
        finished = found and all(c["bucket"] != PENDING for c in found)
        current = sorted((c["name"], c["bucket"]) for c in found)
        if finished and current == previous:
            failed = [c["name"] for c in found if c["bucket"] not in PASSING]
            for name in failed:
                print(f"check failed: {name}", file=sys.stderr)
            return 1 if failed else 0
        previous = current if finished else None
        time.sleep(SETTINGS["pollSeconds"])


def merge(pull_request: str) -> int:
    gh("pr", "merge", pull_request, SETTINGS["mergeMethod"], "--delete-branch")
    print(gh("pr", "view", pull_request, "--json", "mergeCommit", "--jq", ".mergeCommit.oid").strip())
    return 0


def deploy(commit: str) -> int:
    """Poll until the deploy workflow run of the commit completed; succeed when its deploy job succeeded."""
    repo = repository()
    while True:
        runs = json.loads(gh("run", "list", "--repo", repo, "--workflow", SETTINGS["deployWorkflow"],
                             "--commit", commit, "--event", "push", "--json", "databaseId,status"))
        done = [r for r in runs if r["status"] == COMPLETED]
        if done:
            jobs = json.loads(gh("run", "view", str(done[0]["databaseId"]), "--repo", repo, "--json", "jobs"))["jobs"]
            job = next((j for j in jobs if j["name"] == SETTINGS["deployJob"]), None)
            if job is None or job.get("conclusion") != SUCCESS:
                print(f"the {SETTINGS['deployJob']} job concluded {job and job.get('conclusion')}", file=sys.stderr)
                return 1
            return 0
        time.sleep(SETTINGS["pollSeconds"])


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    sub = commands.add_parser("create")
    for name in ("branch", "base", "title"):
        sub.add_argument(name)
    sub.add_argument("body", type=Path)
    commands.add_parser("checks").add_argument("pull_request")
    commands.add_parser("merge").add_argument("pull_request")
    commands.add_parser("deploy").add_argument("commit")
    args = parser.parse_args(argv)
    try:
        if args.command == "create":
            return create(args.branch, args.base, args.title, args.body)
        if args.command == "checks":
            return checks(args.pull_request)
        if args.command == "merge":
            return merge(args.pull_request)
        return deploy(args.commit)
    except (RuntimeError, subprocess.CalledProcessError, ValueError, KeyError) as error:
        print(f"github: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

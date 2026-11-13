"""Receiver and protocol rows R1 to R10: tampered and refused requests, concurrency, repeated and new
attempts, and the receiver restarting from the release it deployed."""
from __future__ import annotations

import json
import secrets
import time
import unittest

import harness

RECONNECT = "Waiting for the deployment receiver to reconnect"
REFUSED = "HTTP Error 500"
UNAUTHORIZED = 403
BUSY = 409
UNSUPPORTED = 501
STALE_REQUEST_SECONDS = 3600
OTHER_REPO = harness.FIXTURE["repo"] + "-other"
SIDE_BRANCH = "side"
DEPLOY_SCRIPT = "jomaa-deploy/deploy.py"
UNAUTHORIZED_ANSWER = '{"error": "unauthorized"}'
MARKED_ANSWER = '{{"error": "unauthorized", "receiver": "{}"}}'
MARKER_KEY = "receiver"
SNAPSHOT = """import json, subprocess, sys
from pathlib import Path

spec = json.loads(sys.argv[1])
deploy = Path(spec["deploy"])


def text(path):
    try:
        return path.read_text()
    except OSError:
        return None


def target(path):
    return str(path.resolve()) if path.exists() else None


def names(path):
    return sorted(p.name for p in path.iterdir()) if path.is_dir() else []


modules, units = {}, list(spec["units"])
for folder in sorted((deploy / "modules").glob("*/")):
    record = text(folder / spec["record"])
    modules[folder.name] = {"record": record, "current": target(folder / "current"),
                            "previous": target(folder / "previous")}
    parsed = json.loads(record) if record else None
    if isinstance(parsed, dict) and parsed.get("kind") == "Service" and parsed.get("declaration"):
        units.append(parsed["declaration"]["unit"])
facts = {"current": target(deploy / "current"), "modules": modules, "releases": names(deploy / "releases"),
         "results": names(deploy / "results"), "files": {name: text(deploy / name) for name in spec["files"]},
         "tunnel": text(Path(spec["tunnel"])), "units": {}}
for unit in sorted(set(units)):
    facts["units"][unit] = subprocess.run(
        ["systemctl", "--user", "show", "-p", "ActiveState", "-p", "MainPID", "-p", "ExecMainStartTimestamp", unit],
        capture_output=True, text=True).stdout
print(json.dumps(facts))
"""


class Receiver(harness.E2ETestCase):

    # Fixture changes and requests

    def change(self, message: str, **versions: str) -> str:
        """Commit new versions of fixture services, folder=version, push and return the commit."""
        for folder, version in versions.items():
            self.h.repo.set_behavior(folder, version=version)
        sha = self.h.repo.commit(message)
        self.h.push()
        return sha

    def assert_refused(self, result: harness.NotifyResult) -> None:
        self.assertEqual((result.code, result.status), (1, None), result.output)
        self.assertIn(REFUSED, result.output)

    def deployed(self) -> str:
        """The revision that current points at."""
        return self.h.resolve(self.h.deploy_path("current")).rsplit("/", 1)[1]

    # Observations on jerry and the fakes

    @property
    def receiver(self) -> str:
        return self.h.settings["receiverUnit"]

    def receiver_pid(self) -> str:
        return self.h.unit_property(self.receiver, "MainPID")

    def settle(self) -> None:
        """Wait until a receiver process serves requests again, after a restart that follows an answer."""
        h = self.h

        def serving() -> bool:
            status, _ = h.edge_request(harness.FIXTURE["webhookHostname"], harness.settings.WEBHOOK_PATH)
            return status == UNSUPPORTED

        harness.wait_for(serving, harness.TIMEOUTS["bootSeconds"], "the deployment receiver does not answer")

    def snapshot(self) -> dict:
        """Pointers, records, releases, results, ingress files, tunnel.yml and the receiver, tunnel and
        service processes on jerry."""
        h = self.h
        self.settle()
        spec = {"deploy": h.deploy_dir, "record": harness.engine.RECORD,
                "files": [harness.INGRESS_FILE, h.settings["siteMap"]],
                "tunnel": f"{h.native}/tunnel.yml",
                "units": [self.receiver, h.settings["tunnel"]["unit"]]}
        return json.loads(h.exec_as_jerry("python3", "-c", SNAPSHOT, json.dumps(spec)).out)

    def cloudflare_requests(self, since: int) -> list[dict]:
        prefix = harness.FAKES["cloudflarePath"]
        return [r for r in self.h.fakes.requests(since=since) if r["path"].startswith(prefix)]

    def unit_starts(self, *folders: str) -> dict[str, str]:
        units = [self.h.repo.declaration(folder)["unit"] for folder in folders]
        units.append(self.h.settings["tunnel"]["unit"])
        return {unit: self.h.unit_property(unit, "ExecMainStartTimestamp") for unit in units}

    def build_running(self, folder: str, sha: str) -> bool:
        """Whether the module's first build command runs in its folder of the release of sha."""
        build = self.h.repo.declaration(folder)["build"][0]
        for pid in self.h.processes(" ".join(build[1:])):
            cwd = self.h.exec_root("readlink", f"/proc/{pid}/cwd", check=False).out.strip()
            if cwd == self.h.deploy_path(f"releases/{sha}/{folder}"):
                return True
        return False

    def wait_build(self, folder: str, sha: str) -> None:
        harness.wait_for(lambda: self.build_running(folder, sha), harness.TIMEOUTS["bootSeconds"],
                         f"the build of {folder} at {sha[:12]} did not start")

    # Rows

    def test_01_tampered_requests(self):
        """R1: a bad signature, a changed body, an expired or future timestamp and a wrong repository
        answer 403 and reach neither GitHub nor anything on jerry."""
        h = self.h
        sha, run_id = self.deployed(), h.new_run()
        before = self.snapshot()
        mark = h.fakes.mark()
        body, signature = h.signed_request(sha, run_id, 1)
        changed = body.replace(sha.encode(), sha[::-1].encode())
        now = int(time.time())
        requests = {
            "no signature": (body, None),
            "malformed signature": (body, signature[:-1]),
            "wrong secret": h.signed_request(sha, run_id, 1, secret=secrets.token_hex(32)),
            "changed body": (changed, signature),
            "expired timestamp": h.signed_request(sha, run_id, 1, timestamp=now - STALE_REQUEST_SECONDS),
            "future timestamp": h.signed_request(sha, run_id, 1, timestamp=now + STALE_REQUEST_SECONDS),
            "wrong repository": h.signed_request(sha, run_id, 1, repo=OTHER_REPO),
        }
        for name, (data, signed) in requests.items():
            with self.subTest(name):
                status, answer = h.post_raw(data, signed)
                self.assertEqual(status, UNAUTHORIZED, answer)
                self.assertEqual(json.loads(answer)["error"], "unauthorized")
        self.assertEqual(h.fakes.requests(since=mark), [])
        self.assertEqual(self.snapshot(), before)

    def test_02_not_a_main_push(self):
        """R2: a run that is not a push to main of the deployment workflow answers 500 and changes nothing."""
        h = self.h
        sha = self.change("Change fx-beta for R2", **{"fx-beta": "r02"})
        before = self.snapshot()
        mark = h.fakes.mark()
        runs = {
            "pull request": {"event": "pull_request"},
            "other branch": {"head_branch": SIDE_BRANCH},
            "other workflow": {"path": ".github/workflows/other.yml"},
            "other attempt": {"run_attempt": 2},
            "other revision": {"head_sha": self.deployed()},
            "other repository": {"repository": {"full_name": OTHER_REPO}},
            "failed run": {"status": "completed", "conclusion": "failure"},
        }
        for name, run in runs.items():
            with self.subTest(name):
                self.assert_refused(h.notify(sha, run=run))
        self.assertEqual(self.cloudflare_requests(mark), [])
        self.assertEqual(self.snapshot(), before)
        h.converge()
        self.assertEqual(h.version("fx-beta"), "r02")

    def test_03_verify_job_failed(self):
        """R3: a run whose verify job failed or is missing answers 500 and changes nothing."""
        h = self.h
        sha = self.change("Change fx-beta for R3", **{"fx-beta": "r03"})
        before = self.snapshot()
        mark = h.fakes.mark()
        for name, conclusion in (("failed", "failure"), ("cancelled", "cancelled"), ("missing", None)):
            with self.subTest(name):
                jobs = {harness.VERIFY_JOB: conclusion}
                self.assert_refused(h.notify(sha, jobs=jobs))
        self.assertEqual(self.cloudflare_requests(mark), [])
        self.assertEqual(self.snapshot(), before)
        h.converge()
        self.assertEqual(h.version("fx-beta"), "r03")

    def test_04_concurrent_request(self):
        """R4: a request that arrives while another activation hangs in a build is retried until the receiver
        is free; both senders get their result, and the second revision deploys after the first."""
        h = self.h
        h.repo.set_behavior("fx-alpha", build="hang")
        first = h.repo.commit("Hang the fx-alpha build")
        h.repo.set_behavior("fx-alpha", build="ok", version="r04")
        h.repo.set_behavior("fx-beta", version="r04")
        second = h.repo.commit("Fix the fx-alpha build")
        h.push()
        finished: dict[str, float] = {}
        holding = h.start_notify(first)
        holding.add_done_callback(lambda _: finished.setdefault(first, time.monotonic()))
        self.wait_build("fx-alpha", first)
        waiting = h.start_notify(second)
        waiting.add_done_callback(lambda _: finished.setdefault(second, time.monotonic()))
        one, two = holding.result(), waiting.result()
        self.assertEqual(one.status, "partial", one.output)
        self.assertEqual(one.modules["fx-alpha"], "failed", one.output)
        self.assertEqual((two.code, two.status), (0, "deployed"), two.output)
        self.assertIn(RECONNECT, two.output)
        self.assertLess(finished[first], finished[second])
        self.assertEqual(h.stored_result(first, one.run_id, one.attempt)["status"], "partial")
        stored = h.stored_result(second, two.run_id, two.attempt)
        self.assertEqual((stored["modules"]["fx-alpha"], stored["modules"]["fx-beta"]), ("deployed", "deployed"))
        self.assertEqual(self.deployed(), second)
        self.assertEqual((h.version("fx-alpha"), h.version("fx-beta")), ("r04", "r04"))
        h.last_notify, h.last_result = two, stored

    @unittest.expectedFailure
    def test_04b_busy_receiver_answers_409(self):
        """R4: a request that arrives while an activation runs answers 409 at once.

        The receiver serves one request at a time, so the second request waits behind the activation and
        its connection is dropped when the receiver restarts after answering the first.
        """
        h = self.h
        h.repo.set_behavior("fx-alpha", build="hang")
        sha = h.repo.commit("Hang the fx-alpha build again")
        h.push()
        holding = h.start_notify(sha)
        try:
            self.wait_build("fx-alpha", sha)
            started = time.monotonic()
            status, answer = h.post_raw(*h.signed_request(sha, h.new_run(), 1))
            self.assertEqual(status, BUSY, answer)
            self.assertLess(time.monotonic() - started, h.settings["commandTimeoutSeconds"])
        finally:
            holding.result()
            h.repo.set_behavior("fx-alpha", build="ok", version="r04b")
            h.repo.commit("Fix the fx-alpha build again")
            h.converge()

    def test_05_older_revision(self):
        """R5: notifying an ancestor of the deployed revision reports older-revision-ignored, notify.py
        succeeds, and nothing changes."""
        h = self.h
        deployed = self.deployed()
        older = h.repo.git("rev-parse", f"{deployed}~1").out.strip()
        before = self.snapshot()
        mark = h.fakes.mark()
        result = h.notify(older)
        self.assertEqual((result.code, result.status), (0, "older-revision-ignored"), result.output)
        self.assertEqual(self.cloudflare_requests(mark), [])
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.deployed(), deployed)

    def test_06_main_rewritten(self):
        """R6: after a force-push that drops the deployed revision from main, the new main is refused and
        current stays; restoring main converges."""
        h = self.h
        deployed = self.deployed()
        self.assertEqual(h.repo.head, deployed)
        h.repo.git("reset", "-q", "--hard", f"{deployed}~1")
        h.repo.set_behavior("fx-beta", version="r06")
        rewritten = h.repo.commit("Rewrite main")
        h.push(force=True)
        before = self.snapshot()
        mark = h.fakes.mark()
        self.assert_refused(h.notify(rewritten))
        self.assertEqual(self.cloudflare_requests(mark), [])
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.deployed(), deployed)
        h.repo.git("reset", "-q", "--hard", deployed)
        h.converge(force=True)
        self.assertEqual(self.deployed(), deployed)

    def test_07_commit_not_on_main(self):
        """R7: a revision that only a side branch holds is refused, even when its run claims main."""
        h = self.h
        deployed = self.deployed()
        h.repo.git("checkout", "-q", "-b", SIDE_BRANCH)
        h.repo.set_behavior("fx-beta", version="r07")
        side = h.repo.commit("Change fx-beta on a side branch")
        h.push(ref=SIDE_BRANCH)
        h.repo.git("checkout", "-q", "main")
        h.repo.git("branch", "-q", "-D", SIDE_BRANCH)
        before = self.snapshot()
        mark = h.fakes.mark()
        self.assert_refused(h.notify(side))
        self.assertEqual(self.cloudflare_requests(mark), [])
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(h.repo.head, deployed)
        h.converge()
        self.assertEqual(self.deployed(), deployed)

    def test_08_repeated_attempt(self):
        """R8: sending the same run attempt again reports the stored result without activating again."""
        h = self.h
        sha = self.change("Change fx-beta for R8", **{"fx-beta": "r08"})
        first = h.notify(sha)
        self.assertEqual((first.code, first.status), (0, "deployed"), first.output)
        stored = h.read(f"results/{harness.result_name(sha, first.run_id, first.attempt)}")
        before = self.snapshot()
        pid = self.receiver_pid()
        mark = h.fakes.mark()
        again = h.notify(sha, first.run_id, first.attempt)
        self.assertEqual((again.code, again.status), (0, "deployed"), again.output)
        self.assertEqual(self.cloudflare_requests(mark), [])
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.receiver_pid(), pid)
        self.assertEqual(h.read(f"results/{harness.result_name(sha, first.run_id, first.attempt)}"), stored)

    def test_09_new_attempt(self):
        """R9: after a module fails, a new attempt of the same run rebuilds only that module; the modules
        that deployed are unchanged and not restarted."""
        h = self.h
        needs = "state/r09-ready"
        flag = h.source_path(f"fx-alpha/{needs}")
        h.remove_file(flag)
        h.repo.set_behavior("fx-alpha", version="r09", rollbackNeeds=needs)
        sha = self.change("Make fx-alpha need a state file", **{"fx-beta": "r09"})
        old_alpha = h.version("fx-alpha")
        first = h.notify(sha)
        self.assertEqual(first.status, "partial", first.output)
        self.assertEqual((first.modules["fx-alpha"], first.modules["fx-beta"]), ("failed", "deployed"), first.output)
        self.assertEqual(h.version("fx-alpha"), old_alpha)
        self.assertEqual(h.version("fx-beta"), "r09")
        self.settle()
        starts = self.unit_starts("fx-beta")
        h.write_file(flag, "")
        second = h.notify(sha, first.run_id, first.attempt + 1)
        self.assertEqual((second.code, second.status), (0, "deployed"), second.output)
        stored = h.stored_result(sha, second.run_id, second.attempt)
        commands = {name for name, record in ((n, h.record(n)) for n in stored["modules"])
                    if record is not None and record["kind"] == "Command"}
        changed = {name: status for name, status in stored["modules"].items()
                   if status != "unchanged" and name not in commands}
        self.assertEqual(changed, {"fx-alpha": "deployed"}, stored)
        self.assertEqual(stored["ingress"]["tunnel"], "unchanged", stored)
        self.assertEqual(self.unit_starts("fx-beta"), starts)
        self.assertEqual(h.version("fx-alpha"), "r09")

    def test_10_receiver_upgrade(self):
        """R10: a change to deploy.py is answered by the old receiver, which then restarts from the new
        release; the next request is served by the new code."""
        h = self.h
        self.settle()
        bad = h.signed_request(self.deployed(), h.new_run(), 1, secret=secrets.token_hex(32))
        status, answer = h.post_raw(*bad)
        self.assertEqual(status, UNAUTHORIZED, answer)
        self.assertNotIn(MARKER_KEY, json.loads(answer))
        pid = self.receiver_pid()
        marker = secrets.token_hex(8)
        script = h.repo.read(DEPLOY_SCRIPT)
        self.assertEqual(script.count(UNAUTHORIZED_ANSWER), 1)
        h.repo.write(DEPLOY_SCRIPT, script.replace(UNAUTHORIZED_ANSWER, MARKED_ANSWER.format(marker)))
        sha = h.repo.commit("Mark the receiver's unauthorized answer")
        h.push()
        result = h.notify(sha)
        self.assertEqual((result.code, result.status), (0, "deployed"), result.output)
        self.assertEqual(h.stored_result(sha, result.run_id, result.attempt)["modules"]["deploy"], "deployed")
        harness.wait_for(lambda: self.receiver_pid() not in (pid, "0") and h.unit_active(self.receiver),
                         harness.TIMEOUTS["bootSeconds"], f"{self.receiver} did not restart")
        self.settle()
        restarted = self.receiver_pid()
        command = h.exec_root("cat", f"/proc/{restarted}/cmdline").out.split("\0")
        script_path = next(arg for arg in command if arg.endswith(DEPLOY_SCRIPT))
        self.assertEqual(h.resolve(script_path), h.deploy_path(f"releases/{sha}/{DEPLOY_SCRIPT}"))
        status, answer = h.post_raw(*bad)
        self.assertEqual(status, UNAUTHORIZED, answer)
        self.assertEqual(json.loads(answer)[MARKER_KEY], marker)
        self.assertEqual(self.receiver_pid(), restarted)
        h.converge()

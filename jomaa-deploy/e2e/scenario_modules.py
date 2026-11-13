"""Module rows M1 to M18: a fault in one module stays in that module, and the next fix or attempt converges."""
from __future__ import annotations

import json
from urllib.parse import urlsplit

import harness

ALPHA, BETA, CMD = "fx-alpha", "fx-beta", "fx-cmd"
GAMMA, DELTA = "fx-gamma", "fx-delta"
STATIC = "jomaa-static-pages"
DOMAIN = harness.FIXTURE["webhookHostname"].split(".", 1)[1]
NEW_SITE = f"pages.{DOMAIN}"
NEW_SITE_PAGE = "<!doctype html><title>pages</title><p>pages fixture site</p>\n"
INDEX = "index.html"
MOVED_INDEX = "home.html"
STARTED = "ExecMainStartTimestampMonotonic"
NEEDED_FILE = "rollback-needed"
UNKNOWN_KEY = "unexpected"
IMPORT_ERROR = 'raise RuntimeError("fixture import error")\n'
UNRELATED = "unrelated.txt"
WANTS = "default.target.wants"
TIMEOUTS = harness.TIMEOUTS
HAND_VERSION = "hand-written"
HAND_SERVER = '''import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps({"ok": True, "version": sys.argv[2]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


HTTPServer(("127.0.0.1", int(sys.argv[1])), Handler).serve_forever()
'''
HAND_UNIT = """[Unit]
Description=Hand-written {unit}
[Service]
ExecStart={python} {script} {port} {version}
Restart=always
[Install]
WantedBy=default.target
"""


class Modules(harness.E2ETestCase):

    # Fixture commits and notifications

    def bump(self, folder: str, **changes: object) -> str:
        """Give a fixture module the next version, with other behavior changes, and return the version."""
        version = f"v{int(self.h.repo.behavior(folder)['version'].removeprefix('v')) + 1}"
        self.h.repo.set_behavior(folder, version=version, **changes)
        return version

    def ship(self, message: str, **notify: object) -> harness.NotifyResult:
        """Commit the fixture changes, push them and notify a new workflow run of the commit."""
        sha = self.h.repo.commit(message)
        self.h.push()
        return self.h.notify(sha, **notify)

    def outcome(self, result: harness.NotifyResult) -> dict:
        stored = self.h.stored_result(result.sha, result.run_id, result.attempt)
        self.assertIsNotNone(stored, result.output)
        return stored

    def expect(self, result: harness.NotifyResult, status: str, modules: dict[str, str]) -> dict:
        """Require the status notify.py printed and the stored status of the given modules."""
        self.assertEqual((result.status, result.code), (status, 0 if status == "deployed" else 1), result.output)
        stored = self.outcome(result)
        self.assertEqual({name: stored["modules"].get(name) for name in modules}, modules, stored)
        return stored

    def new_service(self, folder: str, **behavior: object) -> str:
        """Add a service module copied from alpha on the next free port with its own hostname, create its
        state paths on jerry, and return the hostname."""
        h = self.h
        declarations = [json.loads(path.read_text()) for path in h.repo.root.glob(f"*/{harness.DECLARATION}")]
        origins = [urlsplit(declaration["origin"]) for declaration in declarations if "origin" in declaration]
        alpha = urlsplit(h.repo.declaration(ALPHA)["origin"])
        port = max(origin.port for origin in origins if origin.scheme == alpha.scheme) + 1
        host = f"{folder}.{DOMAIN}"
        h.repo.add_module(folder, template=ALPHA, name=folder, unit=f"jomaa-{folder}",
                          origin=f"{alpha.scheme}://{alpha.hostname}:{port}", routes=[{"hostname": host}])
        h.repo.set_behavior(folder, **behavior)
        for path in h.repo.declaration(folder)["state"]:
            h.exec_as_jerry("mkdir", "-p", h.source_path(path))
        return host

    def state_file(self, folder: str, name: str) -> str:
        """A file in a module's first state path, in jerry's checkout."""
        return self.h.source_path(f"{self.h.repo.declaration(folder)['state'][0]}/{name}")

    def hosts(self, folder: str) -> set[str]:
        return {route["hostname"] for route in self.h.repo.declaration(folder)["routes"]}

    # State on jerry

    def present(self, path: str) -> bool:
        """Whether a path exists on jerry, dangling symlinks included."""
        return self.h.exec_as_jerry("sh", "-c", 'test -e "$1" || test -L "$1"', "sh", path, check=False).code == 0

    def unit(self, name: str) -> str:
        """The unit of a module's live declaration."""
        return self.h.record(name)["declaration"]["unit"]

    def unit_path(self, unit: str) -> str:
        return f"{self.h.unit_dir}/{unit}.service"

    def started(self, unit: str) -> str:
        return self.h.unit_property(unit, STARTED)

    def assert_unit_gone(self, unit: str) -> None:
        self.assertFalse(self.present(self.unit_path(unit)), unit)
        self.assertFalse(self.present(f"{self.h.unit_dir}/{WANTS}/{unit}.service"), unit)
        self.assertEqual(self.h.unit_property(unit, "LoadState"), "not-found", unit)

    def pointer(self, name: str, which: str = "current") -> str | None:
        return self.h.resolve(self.h.deploy_path(f"modules/{name}/{which}"))

    def rules(self) -> list[dict]:
        """The ingress rules of jerry's tunnel.yml."""
        return harness.WRAPPER.parse_ingress(self.h.read_file(f"{self.h.native}/tunnel.yml") or "")

    def routed_hosts(self) -> set[str]:
        return {rule["hostname"] for rule in self.rules() if rule.get("hostname")}

    def ingress_hosts(self) -> set[str]:
        return set(self.h.read_json(harness.INGRESS_FILE)["hosts"])

    def managed_hosts(self) -> set[str]:
        return {r["name"] for r in self.h.fakes.records() if r.get("comment") == harness.routing.DNS_COMMENT}

    def live_records(self) -> list[dict]:
        records = [self.h.record(name) for name in self.h.listdir(self.h.deploy_path("modules"))]
        return [record for record in records if record is not None and record["declaration"] is not None]

    def site_folders(self) -> list[str]:
        """Hostname folders of the static server in the fixture repository."""
        return sorted(p.name for p in (self.h.repo.root / STATIC).iterdir() if p.is_dir() and "." in p.name)

    # The receiver's journal

    def journal_cursor(self) -> str:
        lines = self.h.exec_root("journalctl", "--no-pager", "-o", "json", "-n", "1").out.splitlines()
        return json.loads(lines[-1])["__CURSOR"]

    def journal(self, cursor: str) -> list[tuple[float, str]]:
        """(time in seconds, message) of every journal entry after cursor."""
        out = self.h.exec_root("journalctl", "--no-pager", "-o", "json", f"--after-cursor={cursor}").out
        entries = []
        for line in out.splitlines():
            entry = json.loads(line)
            message = entry.get("MESSAGE", "")
            if isinstance(message, list):
                message = bytes(message).decode(errors="replace")
            entries.append((int(entry["__REALTIME_TIMESTAMP"]) / 1e6, message))
        return entries

    def logged(self, cursor: str, text: str) -> list[tuple[float, str]]:
        """The journal after cursor, once it holds a message starting with text."""
        def found() -> list[tuple[float, str]] | None:
            entries = self.journal(cursor)
            return entries if any(message.startswith(text) for _, message in entries) else None

        return harness.wait_for(found, TIMEOUTS["httpSeconds"], f"no journal message starts with {text!r}")

    @staticmethod
    def span(entries: list[tuple[float, str]], start: str, end: str) -> float:
        """Seconds from the first message starting with start to the next one starting with end."""
        begun = next(t for t, message in entries if message.startswith(start))
        return next(t for t, message in entries if message.startswith(end) and t >= begun) - begun

    @staticmethod
    def messages(entries: list[tuple[float, str]]) -> list[str]:
        return [message for _, message in entries]

    # Rows

    def test_01_build_fails(self):
        """M1: alpha's build fails; alpha keeps serving its old version, beta deploys, and a fix converges."""
        h = self.h
        old = h.version(ALPHA)
        self.bump(ALPHA, build="fail")
        beta = self.bump(BETA)
        result = self.ship("Break alpha's build")
        self.expect(result, "partial", {ALPHA: "failed", BETA: "deployed"})
        self.assertEqual(h.version(ALPHA), old)
        self.assertEqual(h.version(BETA), beta)
        self.assertTrue(h.record(ALPHA)["failed"])
        fixed = self.bump(ALPHA, build="ok")
        h.repo.commit("Fix alpha's build")
        self.expect(h.converge(), "deployed", {ALPHA: "deployed", BETA: "unchanged"})
        self.assertEqual(h.version(ALPHA), fixed)

    def test_02_build_hangs(self):
        """M2: alpha's build hangs and is killed within its module budget; beta still deploys."""
        h = self.h
        settings = h.settings
        budget, deadline = settings["moduleTimeoutSeconds"], settings["commandTimeoutSeconds"]
        self.assertLess(deadline, budget, "the fixture's build deadline must end inside the module budget")
        old = h.version(ALPHA)
        self.bump(ALPHA, build="hang")
        beta = self.bump(BETA)
        cursor = self.journal_cursor()
        result = self.ship("Hang alpha's build")
        self.expect(result, "partial", {ALPHA: "failed", BETA: "deployed"})
        span = self.span(self.logged(cursor, f"{ALPHA} failed:"), f"Deploying {ALPHA}", f"{ALPHA} failed:")
        self.assertGreaterEqual(span, deadline)
        self.assertLessEqual(span, budget)
        self.assertEqual(h.processes(f"{harness.APP} build"), [])
        self.assertEqual(h.version(ALPHA), old)
        self.assertEqual(h.version(BETA), beta)
        fixed = self.bump(ALPHA, build="ok")
        h.repo.commit("Fix alpha's build")
        self.expect(h.converge(), "deployed", {ALPHA: "deployed"})
        self.assertEqual(h.version(ALPHA), fixed)

    def test_03_new_version_crashes(self):
        """M3: alpha's new version exits on start; the old version is restored and previous is unchanged."""
        h = self.h
        old = h.version(ALPHA)
        current, previous = self.pointer(ALPHA), self.pointer(ALPHA, "previous")
        self.assertIsNotNone(previous)
        self.bump(ALPHA, start="crash")
        self.expect(self.ship("Crash alpha on start"), "partial", {ALPHA: "failed"})
        self.assertEqual(h.version(ALPHA), old)
        self.assertEqual(self.pointer(ALPHA), current)
        self.assertEqual(self.pointer(ALPHA, "previous"), previous)
        self.assertTrue(h.unit_active(self.unit(ALPHA)))
        fixed = self.bump(ALPHA, start="ok")
        h.repo.commit("Fix alpha's start")
        self.expect(h.converge(), "deployed", {ALPHA: "deployed"})
        self.assertEqual(h.version(ALPHA), fixed)

    def test_04_health_wrong(self):
        """M4: alpha's health check answers bad JSON, then 500; each time the old version is restored."""
        h = self.h
        for health in ("bad-json", "500"):
            with self.subTest(health=health):
                old, current = h.version(ALPHA), self.pointer(ALPHA)
                self.bump(ALPHA, health=health)
                self.expect(self.ship(f"Answer {health} from alpha's health check"), "partial", {ALPHA: "failed"})
                self.assertEqual(h.version(ALPHA), old)
                self.assertEqual(self.pointer(ALPHA), current)
        fixed = self.bump(ALPHA, health="ok")
        h.repo.commit("Fix alpha's health check")
        self.expect(h.converge(), "deployed", {ALPHA: "deployed"})
        self.assertEqual(h.version(ALPHA), fixed)

    def test_05_health_hangs(self):
        """M5: alpha's health check hangs; each request times out, the wait ends on time and alpha rolls back."""
        h = self.h
        wait, request = h.settings["healthWaitSeconds"], h.settings["healthRequestTimeoutSeconds"]
        old = h.version(ALPHA)
        self.bump(ALPHA, health="hang")
        cursor = self.journal_cursor()
        self.expect(self.ship("Hang alpha's health check"), "partial", {ALPHA: "failed"})
        span = self.span(self.logged(cursor, f"{ALPHA} failed:"), f"Deploying {ALPHA}", f"{ALPHA} failed:")
        self.assertGreaterEqual(span, wait)
        self.assertLess(span, wait + 3 * request)
        self.assertEqual(h.version(ALPHA), old)
        fixed = self.bump(ALPHA, health="ok")
        h.repo.commit("Fix alpha's health check")
        self.expect(h.converge(), "deployed", {ALPHA: "deployed"})
        self.assertEqual(h.version(ALPHA), fixed)

    def test_06_rollback_fails(self):
        """M6: alpha fails its health check and its previous version cannot start; the result still arrives."""
        h = self.h
        state = h.repo.declaration(ALPHA)["state"][0].removeprefix(f"{ALPHA}/")
        needed = self.state_file(ALPHA, NEEDED_FILE)
        h.write_file(needed, f"{NEEDED_FILE}\n")
        restorable = self.bump(ALPHA, rollbackNeeds=f"{state}/{NEEDED_FILE}")
        self.expect(self.ship("Make alpha require a state file"), "deployed", {ALPHA: "deployed"})
        self.assertEqual(h.version(ALPHA), restorable)
        beta_unit = self.unit(BETA)
        beta_started, beta_version = self.started(beta_unit), h.version(BETA)
        self.bump(ALPHA, health="500", rollbackNeeds=None)
        h.remove_file(needed)
        result = self.ship("Fail alpha's health check while its previous version cannot start")
        self.expect(result, "partial", {ALPHA: "failed-unrestored", BETA: "unchanged"})
        self.assertIsNone(h.version(ALPHA))
        self.assertEqual(self.started(beta_unit), beta_started)
        self.assertEqual(h.version(BETA), beta_version)
        h.write_file(needed, f"{NEEDED_FILE}\n")
        harness.wait_for(lambda: h.version(ALPHA) == restorable, TIMEOUTS["bootSeconds"],
                         f"{ALPHA} {restorable} did not start again with its state file")
        fixed = self.bump(ALPHA, health="ok")
        h.repo.commit("Fix alpha's health check")
        self.expect(h.converge(), "deployed", {ALPHA: "deployed"})
        self.assertEqual(h.version(ALPHA), fixed)

    def test_07_first_deploy_fails(self):
        """M7: a new module fails its first deployment; its unit, pointer, route and DNS never stay."""
        h = self.h
        host = self.new_service(GAMMA, health="500")
        unit = h.repo.declaration(GAMMA)["unit"]
        mark, cursor = h.fakes.mark(), self.journal_cursor()
        self.expect(self.ship("Add gamma with a failing health check"), "partial", {GAMMA: "failed"})
        self.logged(cursor, f"Deploying {GAMMA}")
        self.assert_unit_gone(unit)
        self.assertIsNone(self.pointer(GAMMA))
        self.assertIsNone(h.record(GAMMA)["declaration"])
        self.assertNotIn(host, self.routed_hosts())
        self.assertNotIn(host, self.ingress_hosts())
        self.assertNotIn(host, {record["name"] for record in h.fakes.records()})
        self.assertEqual([r for r in h.fakes.requests(since=mark) if host in json.dumps(r)], [])
        version = self.bump(GAMMA, health="ok")
        h.repo.commit("Fix gamma's health check")
        self.expect(h.converge(), "deployed", {GAMMA: "deployed"})
        self.assertEqual(h.version(GAMMA), version)
        self.assertIn(host, self.routed_hosts())
        self.assertIn(host, self.managed_hosts())

    def test_08_first_deploy_replaces_hand_written_unit(self):
        """M8: a new module's failed first deployment puts back the hand-written unit it replaced."""
        h = self.h
        host = self.new_service(DELTA, health="500")
        declaration = h.repo.declaration(DELTA)
        unit, port = declaration["unit"], urlsplit(declaration["origin"]).port
        folder = f"{harness.JERRY['home']}/{DELTA}-hand"
        script = f"{folder}/server.py"
        python = h.exec_as_jerry("sh", "-c", "command -v python3").out.strip()
        h.write_file(script, HAND_SERVER)
        original = HAND_UNIT.format(unit=unit, python=python, script=script, port=port, version=HAND_VERSION)
        h.write_file(self.unit_path(unit), original)
        h.systemctl_user("daemon-reload", check=True)
        h.systemctl_user("enable", "--now", f"{unit}.service", check=True)
        harness.wait_for(lambda: h.version(DELTA) == HAND_VERSION, TIMEOUTS["bootSeconds"],
                         f"the hand-written {unit} did not answer")
        self.expect(self.ship("Add delta over a hand-written unit, with a failing health check"), "partial",
                    {DELTA: "failed"})
        self.assertEqual(h.read_file(self.unit_path(unit)), original)
        self.assertTrue(h.unit_active(unit))
        self.assertEqual(h.version(DELTA), HAND_VERSION)
        self.assertIsNone(self.pointer(DELTA))
        self.assertIsNone(h.record(DELTA)["declaration"])
        self.assertNotIn(host, self.routed_hosts())
        version = self.bump(DELTA, health="ok")
        h.repo.commit("Fix delta's health check")
        self.expect(h.converge(), "deployed", {DELTA: "deployed"})
        self.assertEqual(h.version(DELTA), version)
        self.assertNotEqual(h.read_file(self.unit_path(unit)), original)
        h.remove_file(folder)

    def test_09_unit_renamed(self):
        """M9: renaming alpha's unit disables and deletes the old unit and runs the new one."""
        h = self.h
        old = self.unit(ALPHA)
        new = f"{old}-renamed"
        h.repo.update_declaration(ALPHA, unit=new)
        version = self.bump(ALPHA)
        self.expect(self.ship("Rename alpha's unit"), "deployed", {ALPHA: "deployed"})
        self.assert_unit_gone(old)
        self.assertTrue(h.unit_active(new))
        self.assertEqual(h.unit_property(new, "UnitFileState"), "enabled")
        self.assertEqual(self.unit(ALPHA), new)
        self.assertEqual(h.version(ALPHA), version)

    def assert_load_failure(self, path: str, broken: str, message: str) -> None:
        """Replace a file of alpha so that alpha fails to load: it keeps its unit, process, routes and DNS,
        and restoring the file converges with alpha unchanged."""
        h = self.h
        original = h.repo.read(path)
        unit = self.unit(ALPHA)
        hosts = self.hosts(ALPHA)

        def deployed() -> dict:
            return {"record": h.record(ALPHA), "unit": h.read_file(self.unit_path(unit)),
                    "started": self.started(unit), "version": h.version(ALPHA), "pointer": self.pointer(ALPHA)}

        before = deployed()
        h.repo.write(path, broken)
        stored = self.expect(self.ship(message), "partial", {ALPHA: "failed"})
        self.assertEqual(deployed(), before)
        self.assertEqual(stored["ingress"]["tunnel"], "unchanged", stored)
        self.assertEqual({host: stored["ingress"]["dns"].get(host) for host in hosts},
                         dict.fromkeys(hosts, "unchanged"), stored)
        self.assertLessEqual(hosts, self.routed_hosts())
        self.assertLessEqual(hosts, self.ingress_hosts())
        self.assertLessEqual(hosts, self.managed_hosts())
        h.repo.write(path, original)
        h.repo.commit(f"Restore {path}")
        self.expect(h.converge(), "deployed", {ALPHA: "unchanged"})

    def test_10_import_error(self):
        """M10: alpha's deploy_module.py raises on import; alpha fails and keeps everything it had."""
        path = f"{ALPHA}/{harness.engine.ENTRY}"
        self.assert_load_failure(path, IMPORT_ERROR + self.h.repo.read(path), "Raise in alpha's deploy_module.py")

    def test_11_invalid_declaration(self):
        """M11: alpha's deploy.json has an unknown key; alpha fails and keeps everything it had."""
        path = f"{ALPHA}/{harness.DECLARATION}"
        broken = {**self.h.repo.declaration(ALPHA), UNKNOWN_KEY: True}
        self.assert_load_failure(path, json.dumps(broken, indent=2) + "\n", "Add an unknown key to alpha's deploy.json")

    def test_12_missing_state_path(self):
        """M12: alpha's state path is missing on jerry; alpha fails before its build and keeps running."""
        h = self.h
        unit = self.unit(ALPHA)
        started, old = self.started(unit), h.version(ALPHA)
        version = self.bump(ALPHA)
        state = h.source_path(h.repo.declaration(ALPHA)["state"][0])
        h.remove_file(state)
        cursor = self.journal_cursor()
        self.expect(self.ship("Change alpha while its state path is missing"), "partial", {ALPHA: "failed"})
        messages = self.messages(self.logged(cursor, f"Deploying {CMD}"))
        self.assertNotIn(f"Deploying {ALPHA}", messages)
        self.assertTrue(any(m.startswith(f"{ALPHA} failed: missing local runtime state") for m in messages), messages)
        self.assertEqual(self.started(unit), started)
        self.assertEqual(h.version(ALPHA), old)
        h.exec_as_jerry("mkdir", "-p", state)
        self.expect(h.converge(), "deployed", {ALPHA: "deployed"})
        self.assertEqual(h.version(ALPHA), version)

    def test_13_check_job_failed(self):
        """M13: alpha's check job failed; alpha is ineligible, not built and not restarted."""
        h = self.h
        unit = self.unit(ALPHA)
        started, old = self.started(unit), h.version(ALPHA)
        version = self.bump(ALPHA)
        cursor = self.journal_cursor()
        result = self.ship("Change alpha with a failing check job", jobs={harness.check_job(ALPHA): "failure"})
        self.expect(result, "partial", {ALPHA: "ineligible"})
        messages = self.messages(self.logged(cursor, f"Deploying {CMD}"))
        self.assertNotIn(f"Deploying {ALPHA}", messages)
        self.assertEqual(self.started(unit), started)
        self.assertEqual(h.version(ALPHA), old)
        self.expect(h.converge(), "deployed", {ALPHA: "deployed"})
        self.assertEqual(h.version(ALPHA), version)

    def test_14_jobs_api_down(self):
        """M14: the jobs API fails; the receiver answers, and an activation that cannot read the jobs
        deploys no module with checks."""
        h = self.h
        unit = self.unit(ALPHA)
        started, old = self.started(unit), h.version(ALPHA)
        runs_log = self.state_file(CMD, "runs.log")
        runs = h.read_file(runs_log)
        version = self.bump(ALPHA)
        sha = h.repo.commit("Change alpha while the jobs API is down")
        h.push()
        results, current = h.listdir(h.deploy_path("results")), h.resolve(h.deploy_path("current"))
        h.fakes.set_github_fault("jobs", 500)
        refused = h.notify(sha)
        self.assertEqual((refused.status, refused.code), (None, 1), refused.output)
        self.assertIn("500", refused.output)
        self.assertEqual(h.listdir(h.deploy_path("results")), results)
        self.assertEqual(h.resolve(h.deploy_path("current")), current)
        self.assertTrue(h.unit_active(h.settings["receiverUnit"]))
        pages = len(h.default_jobs(sha)) // h.settings["github"]["jobsPerPage"] + 1
        h.fakes.control(githubAfter={"jobs": pages})
        result = h.notify(sha)
        self.assertEqual((result.status, result.code), ("partial", 1), result.output)
        stored = self.outcome(result)
        modules, failures = harness.engine.discover(h.repo.root)
        self.assertEqual(failures, {})
        checked = {module.name for module in modules if module.check_job() is not None}
        self.assertLessEqual({ALPHA, CMD}, checked)
        self.assertEqual(stored["modules"],
                         {name: "ineligible" if name in checked else "unchanged" for name in stored["modules"]})
        self.assertEqual(self.started(unit), started)
        self.assertEqual(h.version(ALPHA), old)
        self.assertEqual(h.read_file(runs_log), runs)
        self.expect(h.converge(), "deployed", {ALPHA: "deployed", CMD: "deployed"})
        self.assertEqual(h.version(ALPHA), version)

    def test_15_static_site_broken(self):
        """M15: a site folder loses its index.html; that site keeps its previous folder, a new site deploys."""
        h = self.h
        broken = self.site_folders()[0]
        static = h.repo.declaration(STATIC)
        static_started = self.started(static["unit"])
        sites = h.read_json(h.settings["siteMap"])
        index = h.repo.read(f"{STATIC}/{broken}/{INDEX}")
        h.repo.write(f"{STATIC}/{broken}/{MOVED_INDEX}", index)
        h.repo.remove(f"{STATIC}/{broken}/{INDEX}")
        h.repo.write(f"{STATIC}/{NEW_SITE}/{INDEX}", NEW_SITE_PAGE)
        result = self.ship("Move one site's index.html away and add another site")
        self.expect(result, "partial", {broken: "failed", NEW_SITE: "deployed", static["name"]: "unchanged"})
        served = h.read_json(h.settings["siteMap"])
        self.assertEqual({host: folder for host, folder in served.items() if host != NEW_SITE}, sites)
        self.assertEqual(served[NEW_SITE], h.deploy_path(f"releases/{result.sha}/{STATIC}/{NEW_SITE}"))
        self.assertTrue(h.exists(sites[broken]))
        status, body = h.http(static["origin"] + "/", host=broken)
        self.assertEqual(status, 200, body)
        self.assertEqual(h.wait_edge(NEW_SITE, "/"), NEW_SITE_PAGE)
        self.assertEqual(self.started(static["unit"]), static_started)
        h.repo.write(f"{STATIC}/{broken}/{INDEX}", index)
        h.repo.remove(f"{STATIC}/{broken}/{MOVED_INDEX}")
        h.repo.commit(f"Restore {broken}'s index.html")
        self.expect(h.converge(), "deployed", {broken: "deployed", NEW_SITE: "unchanged"})

    def test_16_command_fails(self):
        """M16: the command exits 1; it fails without a rollback and runs again at the next activation."""
        h = self.h
        runs_log = self.state_file(CMD, "runs.log")
        runs = h.read_file(runs_log)
        self.bump(CMD, start="crash")
        cursor = self.journal_cursor()
        result = self.ship("Make the command fail")
        self.expect(result, "partial", {CMD: "failed"})
        self.logged(cursor, f"{CMD} failed:")
        self.assertEqual(h.read_file(runs_log), runs)
        self.assertTrue(h.record(CMD)["failed"])
        cursor = self.journal_cursor()
        again = h.notify(result.sha, result.run_id, result.attempt + 1)
        self.expect(again, "partial", {CMD: "failed"})
        self.logged(cursor, f"Deploying {CMD}")
        self.logged(cursor, f"{CMD} failed:")
        self.assertEqual(h.read_file(runs_log), runs)
        version = self.bump(CMD, start="ok")
        h.repo.commit("Fix the command")
        converged = self.expect(h.converge(), "deployed", {CMD: "deployed"})
        self.assertIn(f"{version} {h.repo.head}", (h.read_file(runs_log) or "").splitlines(), converged)

    def test_17_module_removed(self):
        """M17: deleting beta's folder removes its unit, its routes and its own DNS records."""
        h = self.h
        unit, origin = self.unit(BETA), h.repo.declaration(BETA)["origin"]
        routes = h.repo.declaration(BETA)["routes"]
        own, shared = self.hosts(BETA) - self.hosts(ALPHA), self.hosts(BETA) & self.hosts(ALPHA)
        h.repo.remove_module(BETA)
        stored = self.expect(self.ship("Remove beta"), "deployed", {BETA: "removed"})
        self.assert_unit_gone(unit)
        self.assertFalse(self.present(h.deploy_path(f"modules/{BETA}")))
        self.assertEqual(h.http(origin + "/")[0], None)
        rules = {(rule.get("hostname"), rule.get("path")) for rule in self.rules()}
        for route in routes:
            self.assertNotIn((route["hostname"], route.get("path")), rules)
        self.assertEqual({host: stored["ingress"]["dns"].get(host) for host in own}, dict.fromkeys(own, "deleted"))
        self.assertFalse(own & self.managed_hosts())
        self.assertFalse(own & self.ingress_hosts())
        self.assertLessEqual(shared, self.managed_hosts())
        for route in routes:
            if route["hostname"] in shared:
                for probe in route.get("probes") or ["/"]:
                    self.assertEqual(json.loads(h.wait_edge(route["hostname"], probe))["module"], ALPHA)
        inventory = json.loads(h.read_file(self.state_file(CMD, "inventory.json")))
        self.assertNotIn(BETA, inventory["services"])

    def test_18_unchanged_modules(self):
        """M18: a push outside every module leaves every module unchanged and restarts no service."""
        h = self.h
        records = self.live_records()
        commands = {record["name"] for record in records if record["kind"] == "Command"}
        units = [record["declaration"]["unit"] for record in records if record["kind"] == "Service"]
        units.append(h.settings["tunnel"]["unit"])
        starts = {unit: self.started(unit) for unit in units}
        files = {unit: h.read_file(self.unit_path(unit)) for unit in units}
        h.repo.write(UNRELATED, f"{UNRELATED}\n")
        stored = self.expect(self.ship("Change a file outside every module"), "deployed", {})
        self.assertEqual(stored["modules"],
                         {name: "deployed" if name in commands else "unchanged" for name in stored["modules"]})
        self.assertEqual(stored["ingress"]["tunnel"], "unchanged", stored)
        self.assertEqual({unit: self.started(unit) for unit in units}, starts)
        self.assertEqual({unit: h.read_file(self.unit_path(unit)) for unit in units}, files)

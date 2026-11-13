"""Process and machine rows P1 to P7: killed activations and receivers, reboots, a full disk and release churn."""
from __future__ import annotations

import json
import shlex
import unittest
from urllib.parse import urlsplit

import harness

CHAOS = harness.CONFIG["chaos"]
ALPHA = "fx-alpha"
GAMMA = "fx-gamma"
SERVICES = [folder for folder in harness.templates() if (harness.TEMPLATES / folder / harness.BEHAVIOR).exists()
            and json.loads((harness.TEMPLATES / folder / harness.DECLARATION).read_text()).get("unit")]
BUILD = "app.py build"
RECONNECT = "Waiting for the deployment receiver to reconnect"
RELEASE_TEMP = "release-"
RECORD_TEMP = ".deploy-"
LINK_TEMP = ".new"
HOLD_DRIVER = "e2e-hold"
HOLD_PATH = "jomaa-deploy/deploy.py"
MOUNT_RELEASES = """set -e
releases="$1" owner="$2" free="$3"
stage=$(mktemp -d)
cp -a "$releases/." "$stage/"
mount -t tmpfs -o mode=0755 tmpfs "$releases"
chown "$owner:" "$releases"
cp -a "$stage/." "$releases/"
rm -rf "$stage"
used=$(df -B1 --output=used "$releases" | tail -n 1)
mount -o "remount,size=$((used + free))" "$releases"
"""
UNMOUNT_RELEASES = 'umount "$1" || umount -l "$1"'


class Chaos(harness.E2ETestCase):
    p2_new_service: dict | None = None
    p3_leaked: list[str] | None = None

    # Helpers

    def commit(self, folder: str, message: str, **behavior: object) -> str:
        """Change a fixture service's behavior, commit and push."""
        self.h.repo.set_behavior(folder, **behavior)
        sha = self.h.repo.commit(message)
        self.h.push()
        return sha

    def releases(self) -> list[str]:
        return self.h.listdir(self.h.deploy_path("releases"))

    def release_temps(self) -> list[str]:
        """Temporary extraction folders left in releases/."""
        return [name for name in self.releases() if name.startswith(RELEASE_TEMP)]

    def records(self) -> dict[str, str | None]:
        return {name: self.h.read(f"modules/{name}/{harness.engine.RECORD}")
                for name in self.h.listdir(self.h.deploy_path("modules"))}

    def temp_files(self) -> list[str]:
        """Half-written records and pointers in modules/."""
        found = []
        for name in self.h.listdir(self.h.deploy_path("modules")):
            found += [f"{name}/{entry}" for entry in self.h.listdir(self.h.deploy_path(f"modules/{name}"))
                      if entry.startswith(RECORD_TEMP) or entry.endswith(LINK_TEMP)]
        return found

    def versions(self) -> dict[str, str | None]:
        return {folder: self.h.version(folder) for folder in SERVICES}

    def wait_versions(self, versions: dict[str, str | None]) -> None:
        harness.wait_for(lambda: self.versions() == versions, harness.TIMEOUTS["bootSeconds"],
                         f"the services do not answer {versions}")

    def current(self) -> str | None:
        return self.h.resolve(self.h.deploy_path("current"))

    def unit(self, folder: str) -> str:
        return self.h.repo.declaration(folder)["unit"]

    def wait_process(self, pattern: str) -> list[int]:
        return harness.wait_for(lambda: self.h.processes(pattern), harness.TIMEOUTS["execSeconds"],
                                f"no process matches {pattern!r}")

    def kill_processes(self, pattern: str) -> None:
        self.h.exec_root("pkill", "-KILL", "-u", harness.JERRY["user"], "-f", pattern, check=False)

    def wait_units(self) -> None:
        """Wait for the receiver, the tunnel and every live service unit."""
        units = [self.h.settings["receiverUnit"], self.h.settings["tunnel"]["unit"]]
        for record in self.h.probe()["records"].values():
            if isinstance(record, dict) and record.get("kind") == "Service" and record.get("declaration"):
                units.append(record["declaration"]["unit"])
        for unit in units:
            harness.wait_for(lambda: self.h.unit_active(unit), harness.TIMEOUTS["bootSeconds"], f"{unit} is not active")

    def wait_receiver(self) -> None:
        """Wait until the receiver answers an unsigned request through the edge with 403."""
        harness.wait_for(lambda: self.h.post_raw(b"{}")[0] == 403, harness.TIMEOUTS["bootSeconds"],
                         "the receiver does not answer through the edge")

    def next_port(self) -> int:
        """One more than the highest origin port of the fixture repository."""
        ports = [urlsplit(json.loads(path.read_text())["origin"]).port
                 for path in self.h.repo.root.glob(f"*/{harness.DECLARATION}")
                 if "origin" in json.loads(path.read_text())]
        return max(ports) + 1

    def hold_extraction(self, marker: str) -> None:
        """Make git archive in the receiver's cache touch marker and wait while it smudges HOLD_PATH."""
        cache = self.h.deploy_path("git-cache")
        command = f"touch {shlex.quote(marker)} && sleep {CHAOS['extractionHoldSeconds']} && cat"
        self.h.exec_as_jerry("git", "-C", cache, "config", f"filter.{HOLD_DRIVER}.smudge", command)
        self.h.write_file(f"{cache}/info/attributes", f"{HOLD_PATH} filter={HOLD_DRIVER}\n")

    def release_extraction(self, marker: str) -> None:
        cache = self.h.deploy_path("git-cache")
        self.h.exec_as_jerry("git", "-C", cache, "config", "--remove-section", f"filter.{HOLD_DRIVER}", check=False)
        self.h.remove_file(f"{cache}/info/attributes")
        self.h.remove_file(marker)

    # Rows

    def test_p1_activation_killed_during_build(self):
        """P1: killing the activation during a build answers 500, releases the lock, writes no record, converges."""
        h = self.h
        versions, records, current = self.versions(), self.records(), self.current()
        sha = self.commit(ALPHA, "Hang the alpha build", version="p1", build="hang")
        pending = h.start_notify(sha)
        self.wait_process(BUILD)
        self.assertFalse(pending.done())
        h.kill_activation()
        result = pending.result()
        self.kill_processes(BUILD)
        self.assertNotEqual(result.code, 0, result.output)
        self.assertIsNone(result.status, result.output)
        self.assertIn("500", result.output)
        self.assertTrue(h.probe()["lockFree"], "deploy.lock is held")
        self.assertEqual(self.records(), records)
        self.assertEqual(self.temp_files(), [])
        self.assertEqual(self.current(), current)
        self.assertEqual(self.versions(), versions)
        self.assertIsNone(h.stored_result(sha, result.run_id, result.attempt))
        h.repo.set_behavior(ALPHA, version="p1-fixed", build="ok")
        h.repo.commit("Fix the alpha build")
        h.converge()
        self.assertEqual(h.version(ALPHA), "p1-fixed")

    def test_p2a_activation_killed_during_health_wait(self):
        """P2: the activation dies in a service's health wait; the next attempt leaves the verified version live."""
        h = self.h
        verified = h.version(ALPHA)
        revision = h.record(ALPHA)["revision"]
        sha = self.commit(ALPHA, "Hang the alpha health check", version="p2", health="hang")
        pending = h.start_notify(sha)
        harness.wait_for(lambda: h.version(ALPHA) == "p2", harness.TIMEOUTS["execSeconds"],
                         "alpha did not switch to the new release")
        self.assertFalse(pending.done())
        h.kill_activation()
        first = pending.result()
        self.assertNotEqual(first.code, 0, first.output)
        self.assertIsNone(first.status, first.output)
        run_id, attempt = h.runs[sha]
        second = h.notify(sha, run_id, attempt + 1)
        self.assertEqual(second.status, "partial", second.output)
        self.assertEqual(second.modules.get(h.repo.declaration(ALPHA)["name"]), "failed", second.output)
        self.assertEqual(h.version(ALPHA), verified)
        self.assertTrue(h.unit_active(self.unit(ALPHA)))
        record = h.record(ALPHA)
        self.assertEqual(record["revision"], revision, record)
        self.assertEqual(h.resolve(h.deploy_path(f"modules/{record['name']}/current")),
                         h.deploy_path(f"releases/{revision}"))
        h.repo.set_behavior(ALPHA, version="p2-fixed", health="ok")
        h.repo.commit("Fix the alpha health check")
        h.converge()
        self.assertEqual(h.version(ALPHA), "p2-fixed")

    def test_p2b_new_service_killed_during_health_wait(self):
        """P2 for a first deploy: the activation dies in a new service's health wait, then the next attempt runs.

        Records what the next attempt leaves running for test_p2c, then removes the service.
        """
        h = self.h
        name, unit = GAMMA, f"jomaa-{GAMMA}"
        h.repo.add_module(GAMMA, template=ALPHA, name=name, unit=unit, origin=f"http://127.0.0.1:{self.next_port()}",
                          routes=[])
        for path in h.repo.declaration(GAMMA)["state"]:
            h.exec_as_jerry("mkdir", "-p", h.source_path(path))
        sha = self.commit(GAMMA, "Add a service whose health check hangs", version="p2b", health="hang")
        try:
            pending = h.start_notify(sha)
            harness.wait_for(lambda: h.version(GAMMA) == "p2b", harness.TIMEOUTS["execSeconds"],
                             f"{GAMMA} did not start")
            self.assertFalse(pending.done())
            h.kill_activation()
            first = pending.result()
            self.assertIsNone(first.status, first.output)
            run_id, attempt = h.runs[sha]
            second = h.notify(sha, run_id, attempt + 1)
            self.assertEqual(second.status, "partial", second.output)
            type(self).p2_new_service = {"status": second.modules.get(name), "active": h.unit_active(unit),
                                         "answers": h.version(GAMMA)}
        finally:
            h.systemctl_user("disable", "--now", f"{unit}.service")
            h.remove_file(f"{h.unit_dir}/{unit}.service")
            h.systemctl_user("daemon-reload")
            h.repo.remove_module(GAMMA)
            h.repo.commit("Remove the hanging service")
            h.remove_file(h.source_path(GAMMA))
        h.converge()
        self.assertFalse(h.exists(h.deploy_path(f"modules/{name}")))

    @unittest.expectedFailure
    def test_p2c_next_attempt_leaves_no_unverified_new_service(self):
        """P2, design section 6: the attempt after a killed first deploy leaves no unverified release running.

        Expected to fail: the killed activation already wrote and started the new unit, so the next attempt's
        restore_replaced() takes that unit as the one it replaced, restores and restarts it, and reports
        failed-unrestored with the unverified release still running.
        """
        observed = type(self).p2_new_service
        if observed is None:
            self.skipTest("test_p2b did not reach the next attempt")
        self.assertFalse(observed["active"], observed)
        self.assertIsNone(observed["answers"], observed)

    def test_p3a_receiver_killed_mid_request(self):
        """P3: killing the receiver mid-request restarts it; notify.py retries and the same attempt deploys."""
        h = self.h
        unit = self.unit(ALPHA)
        before = h.unit_property(unit, "MainPID")
        sha = self.commit(ALPHA, "Start alpha slowly", version="p3", start="slow")
        pending = h.start_notify(sha)
        harness.wait_for(lambda: h.unit_property(unit, "MainPID") not in (before, "0"),
                         harness.TIMEOUTS["execSeconds"], "alpha was not restarted")
        self.assertFalse(pending.done())
        h.kill_receiver()
        result = pending.result()
        self.assertEqual((result.code, result.status), (0, "deployed"), result.output)
        self.assertIn(RECONNECT, result.output)
        self.assertIsNotNone(h.stored_result(sha, result.run_id, result.attempt))
        self.assertEqual(h.version(ALPHA), "p3")
        self.wait_units()
        h.repo.set_behavior(ALPHA, start="ok")
        h.repo.commit("Start alpha normally")
        h.converge()

    def test_p3b_receiver_killed_during_extraction(self):
        """P3 during extraction: the receiver dies while it extracts a release; the retried request deploys.

        Records the temporary folders left in releases/ after that deploy and its pruning for test_p3c, then
        deletes them.
        """
        h = self.h
        marker = h.deploy_path(f"git-cache/{HOLD_DRIVER}")
        sha = self.commit(ALPHA, "Change alpha during extraction", version="p3b")
        self.hold_extraction(marker)
        try:
            pending = h.start_notify(sha)
            harness.wait_for(lambda: h.exists(marker), harness.TIMEOUTS["execSeconds"], "extraction did not start")
        finally:
            self.release_extraction(marker)
        self.assertTrue(self.release_temps(), self.releases())
        self.assertFalse(pending.done())
        h.kill_receiver()
        result = pending.result()
        type(self).p3_leaked = self.release_temps()
        for name in type(self).p3_leaked:
            h.remove_file(h.deploy_path(f"releases/{name}"))
        self.assertEqual((result.code, result.status), (0, "deployed"), result.output)
        self.assertIn(RECONNECT, result.output)
        self.assertEqual(self.current(), h.deploy_path(f"releases/{sha}"))
        self.assertEqual(h.version(ALPHA), "p3b")

    @unittest.expectedFailure
    def test_p3c_extraction_leaves_no_temporary_folder(self):
        """P3, design section 6: no releases/release-* folder survives the next deploy and prune.

        Expected to fail: extract_release() removes its temporary folder only when the receiver process
        survives, and prune_releases() considers only folders with a .revision file.
        """
        leaked = type(self).p3_leaked
        if leaked is None:
            self.skipTest("test_p3b did not reach the retried deploy")
        self.assertEqual(leaked, [])

    def test_p4_reboot(self):
        """P4: after a reboot, lingering starts the receiver, the tunnel and every service from its pointer."""
        h = self.h
        versions, current = self.versions(), self.current()
        h.restart_jerry()
        self.wait_units()
        self.wait_receiver()
        self.wait_versions(versions)
        self.assertEqual(self.current(), current)
        host = h.repo.declaration(ALPHA)["routes"][0]["hostname"]
        self.assertEqual(json.loads(h.wait_edge(host, "/"))["version"], versions[ALPHA])

    def test_p5_reboot_mid_deploy(self):
        """P5: a reboot during a hanging build keeps the deployed versions, and the next attempt converges."""
        h = self.h
        versions, current = self.versions(), self.current()
        sha = self.commit(ALPHA, "Hang the alpha build", version="p5", build="hang")
        pending = h.start_notify(sha)
        self.wait_process(BUILD)
        self.assertFalse(pending.done())
        h.restart_jerry()
        self.wait_units()
        result = pending.result()
        self.assertNotEqual(result.status, "deployed", result.output)
        self.kill_processes(BUILD)
        self.wait_versions(versions)
        self.assertTrue(h.probe()["lockFree"], "deploy.lock is held")
        if result.status is None:
            self.assertEqual(self.current(), current)
        h.repo.set_behavior(ALPHA, version="p5-fixed", build="ok")
        h.repo.commit("Fix the alpha build")
        h.converge()
        self.assertEqual(h.version(ALPHA), "p5-fixed")

    def test_p6_disk_full(self):
        """P6: a full releases/ fails extraction with 500, keeps current and services, and leaks no folder."""
        h = self.h
        versions, records, current = self.versions(), self.records(), self.current()
        sha = self.commit(ALPHA, "Change alpha on a full disk", version="p6")
        releases = h.deploy_path("releases")
        h.exec_root("sh", "-c", MOUNT_RELEASES, "sh", releases, harness.JERRY["user"],
                    str(CHAOS["releasesFreeBytes"]))
        try:
            result = h.notify(sha)
            leaked = self.release_temps()
        finally:
            h.exec_root("sh", "-c", UNMOUNT_RELEASES, "sh", releases)
        self.assertNotEqual(result.code, 0, result.output)
        self.assertIsNone(result.status, result.output)
        self.assertIn("500", result.output)
        self.assertEqual(leaked, [])
        self.assertEqual(self.release_temps(), [])
        self.assertNotIn(sha, self.releases())
        self.assertEqual(self.current(), current)
        self.assertEqual(self.records(), records)
        self.assertEqual(self.versions(), versions)
        h.converge()
        self.assertEqual(h.version(ALPHA), "p6")

    def test_p7_release_churn(self):
        """P7: more pushes than releasesKept prune old releases and their results, keeping every pointer's."""
        h = self.h
        keep = h.settings["releasesKept"]
        pushed = []
        for number in range(keep + 2):
            sha = self.commit(ALPHA, f"Release churn {number}", version=f"p7-{number}")
            result = h.notify(sha)
            self.assertEqual((result.code, result.status), (0, "deployed"), result.output)
            pushed.append(result)
        pointers = [h.deploy_path("current")]
        for name in h.listdir(h.deploy_path("modules")):
            pointers += [h.deploy_path(f"modules/{name}/current"), h.deploy_path(f"modules/{name}/previous")]
        used = {target.rsplit("/", 1)[1] for target in map(h.resolve, pointers) if target is not None}
        newest = {result.sha for result in pushed[-keep:]}
        self.assertEqual(set(self.releases()), newest | used)
        for name in used:
            self.assertEqual((h.read(f"releases/{name}/.revision") or "").strip(), name)
        pruned = [result for result in pushed if result.sha not in newest | used]
        self.assertTrue(pruned, used)
        for result in pruned:
            self.assertIsNone(h.stored_result(result.sha, result.run_id, result.attempt))
        for stored in h.listdir(h.deploy_path("results")):
            self.assertIn(stored.split("-", 1)[0], used | newest, stored)

"""Ingress rows I1 to I7: tunnel validation, route conflicts, per-host DNS faults and the tunnel restart."""
from __future__ import annotations

import json
import math
import time
import unittest
import uuid

import harness

EXTERNAL_TEMPLATE = "fx-shell"
TUNNEL_FILE = "tunnel.yml"
RECONNECT = "Waiting for the deployment receiver to reconnect"
CATCH_ALL_PATH = "^/.*$"
MUTATIONS = ("POST", "PUT", "DELETE")


class Ingress(harness.E2ETestCase):

    # Fixture changes and their deployment

    @property
    def zone(self) -> str:
        """The fixture's DNS zone, the parent domain of the fixture's external route."""
        return self.h.repo.declaration(EXTERNAL_TEMPLATE)["routes"][0]["hostname"].split(".", 1)[1]

    def add_external(self, folder: str, routes: list[dict]) -> None:
        """A copy of the fixture's External module, named after its folder, with these routes."""
        self.h.repo.add_module(folder, template=EXTERNAL_TEMPLATE, name=folder, routes=routes)

    def ship(self, message: str) -> tuple[harness.NotifyResult, dict]:
        """Commit, push and notify; return what notify.py printed and the stored result."""
        h = self.h
        sha = h.repo.commit(message)
        h.push()
        result = h.notify(sha)
        stored = h.stored_result(sha, result.run_id, result.attempt)
        self.assertIsNotNone(stored, result.output)
        return result, stored

    def retire(self, *folders: str) -> dict:
        """Remove fixture modules and deploy that; every removed module reports removed."""
        for folder in folders:
            self.h.repo.remove_module(folder)
        result, stored = self.ship("Remove " + ", ".join(folders))
        self.assertEqual(result.status, "deployed", result.output)
        for folder in folders:
            self.assertEqual(stored["modules"][folder], "removed", stored)
        return stored

    # Observations on jerry and the fakes

    def tunnel_path(self) -> str:
        return f"{self.h.native}/{TUNNEL_FILE}"

    def tunnel_digest(self) -> str:
        return self.h.exec_as_jerry("sha256sum", self.tunnel_path()).out.split()[0]

    def tunnel_process(self) -> tuple[str, str]:
        unit = self.h.settings["tunnel"]["unit"]
        return self.h.unit_property(unit, "ExecMainStartTimestamp"), self.h.unit_property(unit, "MainPID")

    def managed_hosts(self) -> list[str]:
        return self.h.read_json(harness.INGRESS_FILE)["hosts"]

    def records_for(self, host: str) -> list[dict]:
        return [r for r in self.h.fakes.records() if r.get("name") == host]

    def cloudflare_mutations(self, since: int) -> list[dict]:
        prefix = harness.FAKES["cloudflarePath"]
        return [r for r in self.h.fakes.requests(since=since)
                if r["path"].startswith(prefix) and r["method"] in MUTATIONS]

    def edge_module(self, host: str, path: str) -> str:
        status, body = self.h.edge_request(host, path)
        self.assertEqual(status, 200, body)
        return json.loads(body)["module"]

    def wait_idle(self) -> None:
        """Wait until no activation runs and the receiver answers again."""
        h = self.h
        harness.wait_for(lambda: not h.processes("deploy.py activate"), harness.TIMEOUTS["execSeconds"],
                         "an activation is still running")
        receiver = h.settings["receiverUnit"]
        harness.wait_for(lambda: h.unit_active(receiver), harness.TIMEOUTS["bootSeconds"],
                         f"{receiver} is not active")

    # Rows

    def test_1_shadowed_route(self):
        """I1: a catch-all path route of one module ahead of another module's path route on the same host
        fails real cloudflared rule matching; tunnel.yml and the tunnel process stay as they were."""
        h = self.h
        beta = h.repo.declaration("fx-beta")["routes"][1]
        shadow = "fx-a-shadow"
        self.assertLess(shadow, "fx-beta")
        digest, process = self.tunnel_digest(), self.tunnel_process()
        self.add_external(shadow, [{"hostname": beta["hostname"], "path": CATCH_ALL_PATH, "probes": ["/"]}])
        result, stored = self.ship("Shadow the fx-beta path route")
        self.assertEqual(result.status, "partial", result.output)
        self.assertEqual(stored["modules"][shadow], "deployed", stored)
        self.assertEqual(stored["ingress"]["tunnel"], "failed", stored)
        self.assertEqual(stored["ingress"]["conflicts"], [], stored)
        self.assertEqual(self.tunnel_digest(), digest)
        self.assertEqual(self.tunnel_process(), process)
        self.assertEqual(self.edge_module(beta["hostname"], beta["probes"][0]), "fx-beta")
        self.assertEqual({s for s in stored["ingress"]["dns"].values()}, {"unchanged"}, stored)
        stored = self.retire(shadow)
        self.assertEqual(stored["ingress"]["tunnel"], "unchanged", stored)
        self.assertEqual(self.tunnel_digest(), digest)

    def test_2_route_conflict(self):
        """I2: a second module claiming fx-beta's hostname and path is left out and listed as a conflict."""
        h = self.h
        host = h.repo.declaration("fx-beta")["routes"][0]["hostname"]
        claimant = "fx-conflict"
        self.assertGreater(claimant, "fx-beta")
        digest, process = self.tunnel_digest(), self.tunnel_process()
        self.add_external(claimant, [{"hostname": host}])
        result, stored = self.ship("Claim the fx-beta hostname twice")
        self.assertEqual(result.status, "partial", result.output)
        self.assertEqual(result.ingress, stored["ingress"], result.output)
        self.assertEqual(stored["modules"][claimant], "deployed", stored)
        conflicts = stored["ingress"]["conflicts"]
        self.assertEqual(len(conflicts), 1, stored)
        for part in (host, claimant, "fx-beta"):
            self.assertIn(part, conflicts[0])
        self.assertEqual(stored["ingress"]["tunnel"], "unchanged", stored)
        self.assertEqual(self.tunnel_digest(), digest)
        self.assertEqual(self.tunnel_process(), process)
        self.assertEqual(stored["ingress"]["dns"][host], "unchanged", stored)
        self.assertEqual(self.edge_module(host, "/"), "fx-beta")
        stored = self.retire(claimant)
        self.assertEqual(stored["ingress"]["conflicts"], [], stored)

    def test_3_dns_failure_on_one_host(self):
        """I3: a Cloudflare 500 on a host being removed, and a host in a missing zone, fail only those hosts;
        the removed host stays in ingress.json with its record, and the other hosts reconcile."""
        h = self.h
        folder = "fx-dns"
        missing_zone = f"nozone-{self.zone}"
        gone, kept, new = (f"dns-{name}.{self.zone}" for name in ("gone", "kept", "new"))
        orphan = f"orphan.{missing_zone}"
        self.add_external(folder, [{"hostname": gone}, {"hostname": kept}])
        result, stored = self.ship("Add the DNS fixture module")
        self.assertEqual(result.status, "deployed", result.output)
        self.assertEqual((stored["ingress"]["dns"][gone], stored["ingress"]["dns"][kept]), ("created", "created"))
        gone_records = self.records_for(gone)
        self.assertEqual(len(gone_records), 1, gone_records)

        h.repo.update_declaration(folder, routes=[{"hostname": kept}, {"hostname": new}, {"hostname": orphan}])
        h.fakes.set_dns_fault(gone, 500)
        h.fakes.set_missing_zones(missing_zone)
        result, stored = self.ship("Move the DNS fixture module's hosts")
        self.assertEqual(result.status, "partial", result.output)
        dns = stored["ingress"]["dns"]
        self.assertEqual(dns[gone], "failed", stored)
        self.assertEqual(dns[orphan], "failed", stored)
        self.assertEqual(dns[kept], "unchanged", stored)
        self.assertEqual(dns[new], "created", stored)
        for host, status in dns.items():
            if host not in (gone, orphan):
                self.assertIn(status, ("unchanged", "created"), stored)
        self.assertEqual(stored["modules"][folder], "deployed", stored)
        self.assertEqual(stored["ingress"]["tunnel"], "updated", stored)
        self.assertTrue({gone, kept, new, orphan} <= set(self.managed_hosts()), self.managed_hosts())
        self.assertEqual(self.records_for(gone), gone_records)
        self.assertEqual(len(self.records_for(new)), 1)
        self.assertEqual(self.records_for(orphan), [])

        h.fakes.clear_faults()
        stored = self.retire(folder)
        dns = stored["ingress"]["dns"]
        self.assertEqual((dns[gone], dns[kept], dns[new]), ("deleted", "deleted", "deleted"), dns)
        self.assertEqual(dns[orphan], "unmanaged", dns)
        hosts = set(self.managed_hosts())
        self.assertFalse({gone, kept, new, orphan} & hosts, hosts)
        for host in (gone, kept, new):
            self.assertEqual(self.records_for(host), [], host)

    @unittest.expectedFailure
    def test_4_cloudflare_hangs(self):
        """I4: with Cloudflare hanging on more hosts than notify.deadlineSeconds allows at
        cloudflare.timeoutSeconds each, the activation still answers within notify.deadlineSeconds.

        Cloudflare requests have their own timeout outside the module budget, so the ingress phase takes
        one timeout per hanging host and the answer comes after notify.py gave up.
        """
        h = self.h
        folder = "fx-hang"
        deadline = h.settings["notify"]["deadlineSeconds"]
        count = math.ceil(deadline / h.settings["cloudflare"]["timeoutSeconds"]) + 1
        hosts = [f"hang-{i}.{self.zone}" for i in range(count)]
        self.add_external(folder, [{"hostname": host} for host in hosts])
        sha = h.repo.commit("Publish many hosts")
        h.push()
        for host in hosts:
            h.fakes.set_dns_fault(host, "hang")
        try:
            started = time.monotonic()
            result = h.notify(sha)
            elapsed = time.monotonic() - started
            self.assertEqual(result.status, "partial", result.output)
            self.assertLess(elapsed, deadline, result.output)
            stored = h.stored_result(sha, result.run_id, result.attempt)
            for host in hosts:
                self.assertEqual(stored["ingress"]["dns"][host], "failed", stored)
            self.assertEqual(stored["modules"][folder], "deployed", stored)
        finally:
            h.fakes.clear_faults()
            self.wait_idle()
            h.repo.remove_module(folder)
            h.repo.commit("Remove the many hosts")
            h.converge()

    def test_5_conflicting_record(self):
        """I5: a pre-existing A record for a new route's host is reported as a conflict and left alone."""
        h = self.h
        folder = "fx-taken"
        host = f"taken.{self.zone}"
        record = {"id": uuid.uuid4().hex, "type": "A", "name": host, "content": "192.0.2.10", "proxied": False,
                  "ttl": 1}
        h.fakes.seed_records(record)
        mark = h.fakes.mark()
        self.add_external(folder, [{"hostname": host}])
        result, stored = self.ship("Route a host with a foreign record")
        self.assertEqual(result.status, "partial", result.output)
        self.assertEqual(stored["ingress"]["dns"][host], "conflict", stored)
        self.assertEqual(stored["modules"][folder], "deployed", stored)
        self.assertEqual(self.records_for(host), [record])
        self.assertEqual([r for r in self.cloudflare_mutations(mark)
                          if r["path"].endswith(f"/{record['id']}") or (r["body"] or {}).get("name") == host], [])
        self.assertIn(host, self.managed_hosts())
        h.converge()
        self.assertEqual(h.last_result["ingress"]["dns"][host], "created", h.last_result)
        self.assertEqual([r["content"] for r in self.records_for(host)], [h.dns_target])
        stored = self.retire(folder)
        self.assertEqual(stored["ingress"]["dns"][host], "deleted", stored)

    def test_6_unmanaged_record_on_removal(self):
        """I6: a record of a removed route that lost the managed comment is reported unmanaged and kept."""
        h = self.h
        folder = "fx-handmade"
        host = f"handmade.{self.zone}"
        self.add_external(folder, [{"hostname": host}])
        result, stored = self.ship("Route a host")
        self.assertEqual(result.status, "deployed", result.output)
        self.assertEqual(stored["ingress"]["dns"][host], "created", stored)
        [created] = self.records_for(host)
        edited = {k: v for k, v in created.items() if k != "comment"}
        h.fakes.seed_records(edited)
        self.assertEqual(self.records_for(host), [edited])
        mark = h.fakes.mark()
        stored = self.retire(folder)
        self.assertEqual(stored["ingress"]["dns"][host], "unmanaged", stored)
        self.assertEqual(self.records_for(host), [edited])
        self.assertEqual([r for r in self.cloudflare_mutations(mark) if r["path"].endswith(f"/{created['id']}")], [])
        self.assertNotIn(host, self.managed_hosts())
        h.converge()

    def test_7_tunnel_restart_mid_request(self):
        """I7: a new route restarts the tunnel during the deployment request; notify.py retries through the
        dropped connection and prints the result."""
        h = self.h
        host = f"restart.{self.zone}"
        routes = h.repo.declaration("fx-beta")["routes"]
        h.repo.update_declaration("fx-beta", routes=[*routes, {"hostname": host}])
        process = self.tunnel_process()
        result, stored = self.ship("Route a new host to fx-beta")
        self.assertEqual((result.code, result.status), (0, "deployed"), result.output)
        self.assertIn(RECONNECT, result.output)
        self.assertEqual(stored["ingress"]["tunnel"], "updated", stored)
        self.assertEqual(stored["ingress"]["dns"][host], "created", stored)
        self.assertEqual(stored["modules"]["fx-beta"], "deployed", stored)
        now = self.tunnel_process()
        self.assertNotEqual(now[0], process[0])
        self.assertNotEqual(now[1], process[1])
        self.assertEqual(json.loads(h.wait_edge(host, "/"))["module"], "fx-beta")

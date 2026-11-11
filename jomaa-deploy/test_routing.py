"""Exercise DNS reconciliation and cloudflared validation without live changes."""
import copy
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import manifest
import routing


class Cloudflare:
    def __init__(self, records=()):
        self.records = {str(i): {"id": str(i), **r} for i, r in enumerate(records, start=1)}
        self.next_id = len(self.records) + 1
        self.mutations = []

    def find_zone(self, host):
        return {"id": "zone"}

    def call(self, method, path, body=None, query=None):
        if method == "GET":
            return [copy.deepcopy(r) for r in self.records.values() if r["name"] == query["name"]]
        self.mutations.append((method, path, body))
        if method == "POST":
            id = str(self.next_id)
            self.next_id += 1
            self.records[id] = {"id": id, **body}
            return self.records[id]
        id = path.rsplit("/", 1)[1]
        if method == "DELETE":
            del self.records[id]
        else:
            self.records[id] = {"id": id, **body}
            return self.records[id]


class DNSTest(unittest.TestCase):
    def record(self, name, **values):
        return {"type": "CNAME", "name": name, "content": "tunnel.cfargotunnel.com", "proxied": True,
                "ttl": 1, "comment": routing.DNS_COMMENT, **values}

    def test_creates_adopts_removes_and_is_idempotent(self):
        cf = Cloudflare([self.record("keep.jomaa.org", comment="other"), self.record("remove.jomaa.org")])
        dns = routing.DNS(cf, "tunnel")
        dns.apply({"keep.jomaa.org", "new.jomaa.org"}, {"keep.jomaa.org", "remove.jomaa.org"})
        self.assertEqual({r["name"] for r in cf.records.values()}, {"keep.jomaa.org", "new.jomaa.org"})
        self.assertTrue(all(r["comment"] == routing.DNS_COMMENT for r in cf.records.values()))
        cf.mutations.clear()
        dns.apply({"keep.jomaa.org", "new.jomaa.org"}, {"keep.jomaa.org", "new.jomaa.org"})
        self.assertEqual(cf.mutations, [])

    def test_conflicts_fail_before_any_mutation(self):
        for record in (self.record("conflict.jomaa.org", type="A", content="192.0.2.1"),
                       self.record("conflict.jomaa.org", content="another.cfargotunnel.com")):
            cf = Cloudflare([record])
            with self.assertRaisesRegex(ValueError, "conflicts"):
                routing.DNS(cf, "tunnel").apply({"new.jomaa.org", "conflict.jomaa.org"}, set())
            self.assertEqual(cf.mutations, [])

    def test_does_not_remove_unmanaged_records(self):
        cf = Cloudflare([self.record("removed.jomaa.org", comment="another owner")])
        dns = routing.DNS(cf, "tunnel")
        dns.apply(set(), {"removed.jomaa.org"})
        self.assertEqual(len(cf.records), 1)
        self.assertEqual(cf.mutations, [])

    def test_restores_created_updated_and_deleted_records(self):
        cf = Cloudflare([self.record("keep.jomaa.org", comment="original", proxied=False),
                         self.record("remove.jomaa.org")])
        original = [routing.DNS.record_body(r) for r in cf.records.values()]
        dns = routing.DNS(cf, "tunnel")
        dns.apply({"keep.jomaa.org", "new.jomaa.org"}, {"keep.jomaa.org", "remove.jomaa.org"})
        dns.restore()
        actual = [routing.DNS.record_body(r) for r in cf.records.values()]
        self.assertCountEqual(actual, original)


class IngressTest(unittest.TestCase):
    def test_shadowed_route_fails_validation_without_replacing_config(self):
        config = manifest.load(Path(__file__).resolve().parent.parent)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "tunnel.yml"
            original = 'tunnel: fixture\ningress:\n  - service: http_status:404\n'
            path.write_text(original)
            with mock.patch.object(routing.subprocess, "run", side_effect=[
                    SimpleNamespace(stdout=""), SimpleNamespace(stdout="service: http://127.0.0.1:8080")]):
                with self.assertRaisesRegex(ValueError, "does not reach"):
                    routing.prepare(Path("cloudflared"), path, config)
            self.assertEqual(path.read_text(), original)
            self.assertEqual(list(path.parent.iterdir()), [path])


if __name__ == "__main__":
    unittest.main()

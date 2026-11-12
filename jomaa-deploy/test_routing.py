"""DNS reconciliation and cloudflared validation, without live changes."""
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import routing
from fixtures import FakeCloudflare, TARGET, TUNNEL_ID, cname


class DNSTest(unittest.TestCase):
    def test_creates_adopts_removes_and_is_idempotent(self):
        cf = FakeCloudflare([cname("keep.jomaa.org", comment="other"), cname("remove.jomaa.org")])
        dns = routing.DNS(cf, TUNNEL_ID)
        statuses = dns.reconcile({"keep.jomaa.org", "new.jomaa.org"}, {"keep.jomaa.org", "remove.jomaa.org"})
        self.assertEqual(statuses, {"keep.jomaa.org": "updated", "new.jomaa.org": "created",
                                    "remove.jomaa.org": "deleted"})
        self.assertEqual(cf.hosts(), {"keep.jomaa.org", "new.jomaa.org"})
        self.assertTrue(all(r["comment"] == routing.DNS_COMMENT for r in cf.records.values()))
        cf.mutations.clear()
        statuses = dns.reconcile({"keep.jomaa.org", "new.jomaa.org"}, {"keep.jomaa.org", "new.jomaa.org"})
        self.assertEqual(set(statuses.values()), {"unchanged"})
        self.assertEqual(cf.mutations, [])

    def test_a_conflict_is_reported_for_its_host_only(self):
        for record in ({"type": "A", "name": "conflict.jomaa.org", "content": "192.0.2.1"},
                       cname("conflict.jomaa.org", content="another.cfargotunnel.com")):
            cf = FakeCloudflare([record])
            statuses = routing.DNS(cf, TUNNEL_ID).reconcile({"new.jomaa.org", "conflict.jomaa.org"}, set())
            self.assertEqual(statuses, {"conflict.jomaa.org": "conflict", "new.jomaa.org": "created"})
            self.assertEqual([m[0] for m in cf.mutations], ["POST"])
            self.assertEqual(cf.records["1"]["content"], record["content"])

    def test_does_not_remove_unmanaged_records(self):
        cf = FakeCloudflare([cname("removed.jomaa.org", comment="another owner")])
        statuses = routing.DNS(cf, TUNNEL_ID).reconcile(set(), {"removed.jomaa.org"})
        self.assertEqual(statuses, {"removed.jomaa.org": "unmanaged"})
        self.assertEqual(cf.mutations, [])

    def test_an_error_on_one_host_leaves_the_others(self):
        cf = FakeCloudflare()
        cf.broken = {"broken.jomaa.org"}
        with mock.patch("sys.stderr"):
            statuses = routing.DNS(cf, TUNNEL_ID).reconcile({"broken.jomaa.org", "fine.jomaa.org"}, set())
        self.assertEqual(statuses, {"broken.jomaa.org": "failed", "fine.jomaa.org": "created"})
        self.assertEqual(cf.records["1"]["content"], TARGET)


class IngressTest(unittest.TestCase):
    RULES = [{"hostname": "hub.jomaa.org", "path": "^/deploy$", "service": "http://127.0.0.1:8091"},
             {"hostname": "hub.jomaa.org", "service": "http://127.0.0.1:8080"},
             {"service": "http_status:404"}]

    def test_regeneration_preserves_tunnel_options_and_removes_old_routes(self):
        original = (f'tunnel: "{TUNNEL_ID}"\ncredentials-file: "/home/jerry/.cloudflared/private.json"\n'
                    'metrics: 127.0.0.1:9090\ningress:\n'
                    '  - hostname: "removed.jomaa.org"\n    service: http://127.0.0.1:9999\n'
                    '  - service: http_status:404\n')
        updated = routing.render(original, self.RULES)
        self.assertNotIn("removed.jomaa.org", updated)
        self.assertIn('credentials-file: "/home/jerry/.cloudflared/private.json"', updated)
        self.assertIn("metrics: 127.0.0.1:9090", updated)
        self.assertLess(updated.index("^/deploy$"), updated.index("http://127.0.0.1:8080"))
        self.assertEqual(routing.render(updated, self.RULES), updated)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "tunnel.yml"
            path.write_text(updated)
            self.assertEqual(routing.tunnel_id(path), TUNNEL_ID)

    def test_shadowed_route_fails_validation_without_replacing_config(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "tunnel.yml"
            original = 'tunnel: fixture\ningress:\n  - service: http_status:404\n'
            path.write_text(original)
            probes = [("hub.jomaa.org", "/deploy", "http://127.0.0.1:8091")]
            with mock.patch.object(routing.subprocess, "run", side_effect=[
                    SimpleNamespace(stdout=""), SimpleNamespace(stdout="service: http://127.0.0.1:8080")]):
                with self.assertRaisesRegex(ValueError, "does not reach"):
                    routing.prepare(Path("cloudflared"), path, self.RULES, probes, 30)
            self.assertEqual(path.read_text(), original)
            self.assertEqual(list(path.parent.iterdir()), [path])


if __name__ == "__main__":
    unittest.main()

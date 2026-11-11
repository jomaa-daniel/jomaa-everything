"""Check declaration validation, path scoping and extensible services."""
import copy
import json
import re
import tempfile
import unittest
from pathlib import Path

import manifest
import routing


class ManifestTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(__file__).resolve().parent.parent
        self.config = json.loads((self.root / "jomaa-deploy/deploy.json").read_text())

    def load_config(self, config, site_names=("sarah.jomaa.org",)):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "jomaa-deploy").mkdir()
            for service in config["services"].values():
                if "directory" in service:
                    folder = root / service["directory"]
                    if folder.resolve().is_relative_to(root.resolve()):
                        folder.mkdir(exist_ok=True)
            for check in config["checks"]:
                (root / check["directory"]).mkdir(exist_ok=True)
            for name in site_names:
                path = root / "jomaa-static-pages" / name
                path.mkdir(parents=True, exist_ok=True)
                (path / "index.html").write_text("site")
            (root / "jomaa-deploy/deploy.json").write_text(json.dumps(config))
            return manifest.load(root)

    def test_discovers_a_new_site_without_changing_the_manifest(self):
        loaded = self.load_config(self.config, ("sarah.jomaa.org", "new.jomaa.org"))
        sites = {r["hostname"]: r["site"] for r in loaded["routes"] if "site" in r}
        self.assertEqual(sites, {"new.jomaa.org": "jomaa-static-pages/new.jomaa.org",
                                 "sarah.jomaa.org": "jomaa-static-pages/sarah.jomaa.org"})
        self.assertFalse(any("site" in r for r in self.config["routes"]))

    def test_path_route_precedes_the_discovered_site_on_the_same_host(self):
        config = copy.deepcopy(self.config)
        config["services"]["app"] = {
            "origin": "http://127.0.0.1:9000", "unit": "jomaa-app", "directory": "jomaa-app",
            "command": ["{python}", "{release}/jomaa-app/server.py"],
            "health": {"url": "http://127.0.0.1:9000/healthz", "json": {"ok": True}}}
        config["routes"].append({"hostname": "new.jomaa.org", "service": "app",
                                 "path": "^/api$", "probes": ["/api"]})
        loaded = self.load_config(config, ("new.jomaa.org",))
        rules = manifest.ingress(loaded)
        self.assertEqual(rules[-3]["service"], "http://127.0.0.1:9000")
        self.assertEqual(rules[-2]["hostname"], "new.jomaa.org")
        self.assertEqual(rules[0]["path"], "^/deploy$")
        self.assertEqual(rules[-1], {"service": "http_status:404"})

    def test_rejects_a_site_at_an_existing_service_hostname(self):
        for name in ("hub.jomaa.org", "ssh.jomaa.org"):
            with self.subTest(hostname=name), self.assertRaisesRegex(ValueError, "conflicts"):
                self.load_config(self.config, (name,))

    def test_rejects_manual_static_site_entries(self):
        config = copy.deepcopy(self.config)
        config["routes"].append({"hostname": "new.jomaa.org", "service": "static",
                                 "site": "jomaa-static-pages/new.jomaa.org"})
        with self.assertRaisesRegex(ValueError, "fields"):
            self.load_config(config)

    def test_site_discovery_rejects_missing_indexes_and_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pages = root / "jomaa-static-pages"
            pages.mkdir()
            site = pages / "new.jomaa.org"
            site.mkdir()
            with self.assertRaisesRegex(ValueError, "index.html"):
                manifest.discover_sites(root)
            (site / "index.html").write_text("site")
            (pages / "device-panel").mkdir()
            self.assertEqual(len(manifest.discover_sites(root)), 1)
            alias = pages / "alias.jomaa.org"
            alias.symlink_to(site, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, "symlink"):
                manifest.discover_sites(root)

    def test_apex_path_route_serves_devices_and_scan_and_excludes_other_matter_routes(self):
        route = next(r for r in self.config["routes"] if r["hostname"] == "jomaa.org")
        for path in route["probes"]:
            self.assertIsNotNone(re.search(route["path"], path), path)
        for path in ("/devices", "/devices/app.js", "/api/devices", "/api/matter/discover", "/api/matter/register"):
            self.assertIsNotNone(re.search(route["path"], path), path)
        for path in ("/deploy", "/api/matter/nodes", "/api/matter/commission", "/unknown", "/lights-other", "/devices-other"):
            self.assertIsNone(re.search(route["path"], path), path)

    def test_rejects_invalid_routes_state_and_services(self):
        changes = [
            lambda c: c["routes"].append(c["routes"][0]),
            lambda c: c["routes"][0].update(hostname="invalid/host"),
            lambda c: c["routes"][0].update(service="missing"),
            lambda c: c["routes"][0].update(path="/unanchored", probes=["/unanchored"]),
            lambda c: c["routes"][0].update(path="^/x$", probes=["/y"]),
            lambda c: c["state"].append("jomaa-home-hub/data/nested"),
            lambda c: c["state"].append("../outside"),
            lambda c: c["services"]["hub"].update(origin="http://example.org:8080"),
            lambda c: c["services"]["hub"].update(unit="jomaa-deploy"),
            lambda c: c["services"]["static"].update(unit="jomaa-hub"),
            lambda c: c["services"]["hub"].update(command=["{unknown}"]),
            lambda c: c["services"]["hub"].update(directory="../outside"),
        ]
        for change in changes:
            with self.subTest(change=change):
                config = copy.deepcopy(self.config)
                change(config)
                with self.assertRaises(ValueError):
                    self.load_config(config)

    def test_regeneration_preserves_tunnel_credentials_and_removes_old_routes(self):
        original = ('tunnel: "4b03940e-11ab-48c6-b288-4c9deb2cc905"\n'
                    'credentials-file: "/home/jerry/.cloudflared/private.json"\n'
                    'metrics: 127.0.0.1:9090\ningress:\n'
                    '  - hostname: "removed.jomaa.org"\n    service: http://127.0.0.1:9999\n'
                    '  - service: http_status:404\n')
        updated = routing.render(original, self.config)
        self.assertNotIn("removed.jomaa.org", updated)
        self.assertIn('credentials-file: "/home/jerry/.cloudflared/private.json"', updated)
        self.assertIn("metrics: 127.0.0.1:9090", updated)
        self.assertLess(updated.index("^/deploy$"), updated.index("http://127.0.0.1:8080"))
        self.assertEqual(routing.render(updated, self.config), updated)


if __name__ == "__main__":
    unittest.main()

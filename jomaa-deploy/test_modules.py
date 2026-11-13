"""Unit checks of each module class: declarations, fingerprints, activation, rollback and removal."""
import copy
import hashlib
import importlib.util
import json
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import types
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import engine
import settings
from fixtures import APP, BENCH, SHELL, TOOL, WEB, ModuleTestCase
from modules import KINDS, VERIFY_JOB, Checks, Command, Context, External, Module, Service, StaticSite
from modules import ingress
from modules.base import expand, switch_link, unit_text

CHECKOUT = Path(__file__).resolve().parent.parent


class DeclarationTest(unittest.TestCase):
    def test_subclasses_register_themselves(self):
        class Extra(Checks):
            pass

        self.assertIn(Extra, Module.registry)
        self.assertEqual(Extra("extra", BENCH).kind, "Checks")
        self.assertEqual(set(KINDS), {"Checks", "External", "Service", "StaticSite", "Command"})

    def test_rejects_invalid_declarations(self):
        changes = [
            lambda d: d.pop("unit"),
            lambda d: d.update(extra=1),
            lambda d: d.update(name="Bad Name"),
            lambda d: d.update(unit="jomaa-deploy"),
            lambda d: d.update(unit=settings.CONFIG["tunnel"]["unit"]),
            lambda d: d.update(origin="http://example.org:8080"),
            lambda d: d.update(origin="http://127.0.0.1:8080/path"),
            lambda d: d.update(command=["{unknown}"]),
            lambda d: d.update(build=[[]]),
            lambda d: d.update(health={"path": "healthz", "json": {}}),
            lambda d: d.update(state=["other/.env"]),
            lambda d: d.update(state=["app/data", "app/data/nested"]),
            lambda d: d.update(inputs=["../outside"]),
            lambda d: d["routes"].append(d["routes"][0]),
            lambda d: d["routes"][0].update(hostname="invalid/host"),
            lambda d: d["routes"][1].update(path="/unanchored", probes=["/unanchored"]),
            lambda d: d["routes"][1].update(probes=["/other"]),
            lambda d: d["routes"].append({"hostname": settings.CONFIG["webhook"]["hostname"],
                                          "path": "^/.*$", "probes": [settings.WEBHOOK_PATH]}),
        ]
        for change in changes:
            with self.subTest(change=change):
                declaration = copy.deepcopy(APP)
                change(declaration)
                with self.assertRaises(ValueError):
                    Service("app", declaration)

    def test_component_declarations_are_valid(self):
        for path in sorted(CHECKOUT.glob("*/deploy_module.py")):
            with self.subTest(module=path.parent.name):
                declaration = json.loads((path.parent / "deploy.json").read_text())
                self.assertIsInstance(declaration["name"], str)
        modules, failures = engine.discover(CHECKOUT)
        self.assertEqual(failures, {})
        self.assertEqual({m.name: m.kind for m in modules}, {
            "deploy": "Checks", "pico-imaging-bench": "Checks", "ssh": "External", "hub": "Service",
            "static": "Service", "sarah.jomaa.org": "StaticSite", "health": "Command", "tailnet": "Command"})
        units = {m.name: m.unit for m in modules if m.kind == "Service"}
        self.assertEqual(units, {"hub": "jomaa-hub", "static": "jomaa-static-pages"})

    def test_apex_path_route_serves_the_hub_pages_and_excludes_other_paths(self):
        hub = json.loads((CHECKOUT / "jomaa-home-hub/deploy.json").read_text())
        route = next(r for r in hub["routes"] if r["hostname"] == "jomaa.org")
        for path in route["probes"]:
            self.assertIsNotNone(re.search(route["path"], path), path)
        for path in ("/deploy", "/api/matter/nodes", "/api/matter/commission", "/unknown", "/lights-other",
                     "/devices-other"):
            self.assertIsNone(re.search(route["path"], path), path)


class FingerprintTest(ModuleTestCase):
    def test_changes_with_folder_inputs_and_declaration_only(self):
        self.add_all()
        self.write("shared/lib.txt", "one")
        self.write("unrelated.txt", "one")
        declaration = {**APP, "inputs": ["shared"]}
        first = self.context(self.commit())
        module = Service("app", declaration)
        base = module.fingerprint(first)
        self.write("unrelated.txt", "two")
        self.assertEqual(module.fingerprint(self.context(self.commit())), base)
        self.write("shared/lib.txt", "two")
        changed_input = module.fingerprint(self.context(self.commit()))
        self.assertNotEqual(changed_input, base)
        self.write("app/server.py", "changed")
        self.assertNotEqual(module.fingerprint(self.context(self.commit())), changed_input)
        head = self.context(self.git("rev-parse", "HEAD"))
        self.assertNotEqual(Service("app", {**declaration, "build": []}).fingerprint(head),
                            module.fingerprint(head))
        with self.assertRaisesRegex(ValueError, "does not exist"):
            Service("app", {**APP, "inputs": ["missing"]}).fingerprint(head)

    def load(self, path: Path, content: str, **names: object) -> types.ModuleType:
        """Import a file of the release as deploy_module.py files are imported, with the given globals."""
        path.write_text(content)
        name = "fingerprint_fixture_" + hashlib.sha256(str(path).encode()).hexdigest()[:16]
        spec = importlib.util.spec_from_file_location(name, path)
        module = importlib.util.module_from_spec(spec)
        module.__dict__.update(names)
        sys.modules[name] = module
        self.addCleanup(sys.modules.pop, name, None)
        spec.loader.exec_module(module)
        return module

    def test_changes_with_the_module_and_shared_class_files_in_the_release(self):
        self.add_all()
        ctx = self.context(self.commit())
        shared_file = ctx.release / "jomaa-deploy/modules/shared.py"
        shared_file.parent.mkdir(parents=True)
        shared = self.load(shared_file, "from modules import Service\n\n\nclass Shared(Service):\n    pass\n")
        entry = ctx.release / "app/deploy_module.py"
        app = self.load(entry, "class App(Shared):\n    pass\n", Shared=shared.Shared).App("app", APP)
        self.assertEqual(set(app.code(ctx.release)), {"app/deploy_module.py", "jomaa-deploy/modules/shared.py"})
        base = app.fingerprint(ctx)
        self.assertEqual(app.fingerprint(ctx), base)
        shared_file.write_text(shared_file.read_text() + "# shared, second version\n")
        changed_shared = app.fingerprint(ctx)
        self.assertNotEqual(changed_shared, base)
        entry.write_text(entry.read_text() + "# app, second version\n")
        self.assertNotEqual(app.fingerprint(ctx), changed_shared)
        self.assertEqual(Service("app", APP).code(ctx.release), {})


class ServiceTest(ModuleTestCase):
    def setUp(self):
        super().setUp()
        self.add_all()
        self.sha = self.commit()
        self.ctx = self.context(self.sha)
        self.service = Service("app", APP)

    def test_unit_runs_from_the_module_pointer(self):
        self.service.activate(self.ctx, self.ctx.release)
        pointer = self.deploy_dir / "modules/app/current"
        self.assertEqual(pointer.resolve(), self.ctx.release)
        unit = (self.unit_dir / "jomaa-app.service").read_text()
        self.assertEqual(unit, unit_text(expand(APP["command"], pointer), pointer / "app",
                                         {"JOMAA_DEPLOY_HOME": str(self.deploy_dir)}))
        self.assertEqual(self.ctx.calls[-3:], [("systemctl", "--user", "daemon-reload"),
                                               ("systemctl", "--user", "enable", "jomaa-app.service"),
                                               ("systemctl", "--user", "restart", "jomaa-app.service")])
        self.assertTrue(self.service.verify(self.ctx))

    def test_unit_working_directory_is_accepted_by_systemd(self):
        current = self.root / "release with spaces%"
        content = unit_text(["/usr/bin/true"], current / "app", {"JOMAA_DEPLOY_HOME": str(current)})
        value = next(line.partition("=")[2] for line in content.splitlines() if line.startswith("WorkingDirectory="))
        self.assertEqual(value, str(current / "app").replace("%", "%%"))
        checker = shutil.which("systemd-analyze")
        if checker is None:
            self.skipTest("systemd-analyze is not installed")
        (current / "app").mkdir(parents=True)
        unit_file = self.root / "working-directory.service"
        unit_file.write_text(content)
        result = subprocess.run([checker, "verify", str(unit_file)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_build_runs_in_the_release_folder(self):
        self.service.build(self.ctx, self.ctx.release)
        self.assertEqual(self.ctx.calls, [("build-app",)])

    def test_rollback_restores_the_recorded_version_and_reports_health(self):
        old = self.root / "old-release"
        (old / "app").mkdir(parents=True)
        switch_link(self.deploy_dir / "releases/old", old)
        recorded = {**APP, "command": ["{python}", "{release}/app/old.py"]}
        self.service.record = {"name": "app", "kind": "Service", "directory": "app", "revision": "old",
                               "fingerprint": "f", "declaration": recorded, "failed": False}
        snapshot = self.service.snapshot(self.ctx)
        self.service.activate(self.ctx, self.ctx.release)
        self.assertEqual(self.service.rollback(self.ctx, snapshot), "failed")
        self.assertEqual((self.deploy_dir / "modules/app/current").resolve(), old.resolve())
        self.assertIn("app/old.py", (self.unit_dir / "jomaa-app.service").read_text())
        self.ctx.unhealthy = {"http://127.0.0.1:9001/healthz"}
        self.assertEqual(self.service.rollback(self.ctx, snapshot), "failed-unrestored")

    def test_rollback_of_a_new_service_stops_it(self):
        snapshot = self.service.snapshot(self.ctx)
        self.assertEqual(snapshot, {"pointer": None, "unit": None})
        self.service.activate(self.ctx, self.ctx.release)
        self.assertEqual(self.service.rollback(self.ctx, snapshot), "failed")
        self.assertFalse((self.unit_dir / "jomaa-app.service").exists())
        self.assertFalse((self.deploy_dir / "modules/app/current").exists())
        self.assertIn(("systemctl", "--user", "disable", "--now", "jomaa-app.service"), self.ctx.calls)

    def test_renamed_unit_replaces_the_old_one(self):
        self.service.record = {"name": "app", "kind": "Service", "directory": "app", "revision": self.sha,
                               "fingerprint": "f", "declaration": {**APP, "unit": "jomaa-old"}, "failed": False}
        (self.unit_dir / "jomaa-old.service").write_text("old")
        self.service.activate(self.ctx, self.ctx.release)
        self.assertFalse((self.unit_dir / "jomaa-old.service").exists())
        self.assertTrue((self.unit_dir / "jomaa-app.service").exists())

    def test_remove_stops_the_recorded_unit(self):
        (self.unit_dir / "jomaa-app.service").write_text("unit")
        record = {"name": "app", "kind": "Service", "directory": "app", "revision": self.sha,
                  "fingerprint": "f", "declaration": APP, "failed": False}
        Service.from_record(record).remove(self.ctx, record)
        self.assertFalse((self.unit_dir / "jomaa-app.service").exists())
        self.assertIn(("systemctl", "--user", "disable", "--now", "jomaa-app.service"), self.ctx.calls)


class StaticSiteTest(ModuleTestCase):
    def setUp(self):
        super().setUp()
        self.add_all()
        self.write("web/two.example.org/index.html", "two")
        self.sha = self.commit()
        self.ctx = self.context(self.sha)
        self.web = Service.load(self.ctx.release, "web")

    def test_discovers_hostname_folders_and_skips_support_folders(self):
        sites = StaticSite.discover(self.web)
        self.assertEqual([s.name for s in sites], ["one.example.org", "two.example.org"])
        self.assertEqual(sites[0].routes(), [{"hostname": "one.example.org", "probes": None,
                                              "origin": WEB["origin"]}])
        self.assertEqual(sites[0].paths(), ["web/one.example.org"])
        self.assertIsNone(sites[0].check_job())

    def test_build_rejects_missing_indexes_symlinks_and_bad_hostnames(self):
        release = self.ctx.release
        (release / "web/empty.example.org").mkdir()
        (release / "web/alias.example.org").symlink_to(release / "web/one.example.org", target_is_directory=True)
        (release / "web/Bad_Host.org").mkdir()
        sites = {s.name: s for s in StaticSite.discover(self.web)}
        for name, message in (("empty.example.org", "index.html"), ("alias.example.org", "symlink"),
                              ("Bad_Host.org", "hostname")):
            with self.subTest(site=name), self.assertRaisesRegex(ValueError, message):
                sites[name].build(self.ctx, release)
        sites["one.example.org"].build(self.ctx, release)

    def test_activate_writes_the_site_map_and_rollback_restores_it(self):
        site = StaticSite.discover(self.web)[0]
        new = site.snapshot(self.ctx)
        self.assertEqual(new, {"site": None})
        old = str(self.deploy_dir / "releases/old/web/one.example.org")
        self.ctx.sites.set("one.example.org", Path(old))
        snapshot = site.snapshot(self.ctx)
        self.assertEqual(snapshot, {"site": old})
        site.activate(self.ctx, self.ctx.release)
        self.assertEqual(self.ctx.sites.load(), {"one.example.org": str(self.ctx.release / "web/one.example.org")})
        self.assertTrue(site.verify(self.ctx))
        self.assertEqual(site.rollback(self.ctx, snapshot), "failed")
        self.assertEqual(self.ctx.sites.load(), {"one.example.org": old})
        site.rollback(self.ctx, new)
        self.assertEqual(self.ctx.sites.load(), {})

    def test_verify_compares_the_served_bytes_with_the_release_index(self):
        site = StaticSite.discover(self.web)[0]
        site.activate(self.ctx, self.ctx.release)
        self.assertTrue(site.verify(self.ctx))
        self.ctx.served = {"one.example.org": b"one, an older version"}
        self.assertFalse(site.verify(self.ctx))

    def test_build_requires_the_relative_assets_of_the_index_inside_the_folder(self):
        release = self.ctx.release
        folder = release / "web/one.example.org"
        (folder / "img").mkdir()
        (folder / "img/ok.png").write_text("png")
        (folder / "style.css").write_text("css")
        (release / "web/outside.css").write_text("outside")
        page = ('<link rel="stylesheet" href="style.css"><link rel="icon" href="/root.ico">'
                '<script src="https://cdn.example.org/x.js"></script><script src="//cdn.example.org/y.js"></script>'
                '<img src="img/ok.png?v=1#top" /><img src="data:image/png;base64,AA"><img alt="">'
                '<a href="page.html">not an asset</a>')
        (folder / "index.html").write_text(page)
        site = StaticSite.discover(self.web)[0]
        site.build(self.ctx, release)
        (folder / "index.html").write_text(page + '<script src="app.js"></script>'
                                                  '<link rel="stylesheet" href="../outside.css">')
        with self.assertRaisesRegex(ValueError, "missing from its folder: app.js, ../outside.css$"):
            site.build(self.ctx, release)


class ContextRequestTest(unittest.TestCase):
    def test_fetch_returns_the_body_of_a_200_answer_to_a_request_with_the_host_header(self):
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                body = self.headers["Host"].encode()
                self.send_response(200 if self.path == "/" else 404)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.addCleanup(server.server_close)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.shutdown)
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        folder = Path(temp.name)
        ctx = Context(folder, folder, folder, "", folder, unit_dir=folder)
        origin = f"http://127.0.0.1:{server.server_port}"
        self.assertEqual(ctx.fetch({"url": origin + "/", "host": "site.example.org"}), b"site.example.org")
        self.assertIsNone(ctx.fetch({"url": origin + "/missing", "host": "site.example.org"}))
        self.assertTrue(ctx.healthy({"url": origin + "/"}))


class CommandExternalChecksTest(ModuleTestCase):
    def setUp(self):
        super().setUp()
        self.add_all()
        self.ctx = self.context(self.commit())

    def test_command_writes_the_inventory_then_runs(self):
        self.ctx.inventory = {"webhook": "hub.example.org", "services": {}, "routes": []}
        command = Command("tool", TOOL)
        self.assertTrue(command.always)
        command.build(self.ctx, self.ctx.release)
        command.activate(self.ctx, self.ctx.release)
        self.assertEqual(self.ctx.calls, [("tool-build",), ("tool-run",)])
        self.assertEqual(json.loads((self.ctx.release / "tool/inventory.json").read_text()), self.ctx.inventory)
        self.assertEqual(command.snapshot(self.ctx), {})
        self.assertEqual(command.rollback(self.ctx, {}), "failed")

    def test_command_without_inventory_writes_none(self):
        Command("tool", {**TOOL, "inventory": None}).activate(self.ctx, self.ctx.release)
        self.assertFalse((self.ctx.release / "tool/inventory.json").exists())

    def test_external_publishes_routes_only(self):
        external = External("shell", SHELL)
        self.assertEqual(external.routes(), [{"hostname": "shell.example.org", "probes": None,
                                              "origin": "ssh://127.0.0.1:2222"}])
        external.activate(self.ctx, self.ctx.release)
        self.assertEqual(self.ctx.calls, [])

    def test_checks_jobs(self):
        self.assertEqual(Checks("bench", BENCH).check_job(), "check (bench)")
        self.assertIsNone(Checks("bench", {**BENCH, "checks": []}).check_job())

        class Deploy(Checks):
            job = VERIFY_JOB

        self.assertEqual(Deploy("jomaa-deploy", BENCH).check_job(), "verify")


class IngressTest(unittest.TestCase):
    def test_receiver_first_path_routes_before_their_host_and_404_last(self):
        app = Service("app", {**APP, "routes": [{"hostname": "example.org"}, {"hostname": "app.example.org"}]})
        other = External("shell", {**SHELL, "routes": [{"hostname": "example.org", "path": "^/x$",
                                                       "probes": ["/x"]}]})
        site = StaticSite("web", {"name": "site.example.org", "origin": WEB["origin"]})
        routes, conflicts = ingress.ordered_routes([site, other, app], settings.CONFIG)
        self.assertEqual(conflicts, [])
        self.assertEqual([(r["hostname"], r.get("path")) for _, r in routes],
                         [("app.example.org", None), ("example.org", "^/x$"), ("example.org", None),
                          ("site.example.org", None)])
        rules, probes = ingress.rules(routes, settings.CONFIG)
        self.assertEqual(rules[0], {"hostname": settings.CONFIG["webhook"]["hostname"], "path": "^/deploy$",
                                    "service": f"http://127.0.0.1:{settings.CONFIG['webhook']['port']}"})
        self.assertEqual(rules[-1], {"service": "http_status:404"})
        self.assertIn(("example.org", "/x", SHELL["origin"]), probes)
        self.assertIn(("site.example.org", "/", WEB["origin"]), probes)

    def test_a_second_claim_of_a_route_is_a_conflict(self):
        app = Service("app", APP)
        shell = External("shell", {**SHELL, "routes": [{"hostname": "app.example.org"}]})
        site = StaticSite("web", {"name": "example.org", "origin": WEB["origin"]})
        routes, conflicts = ingress.ordered_routes([shell, app, site], settings.CONFIG)
        self.assertEqual(conflicts, ["app.example.org: shell conflicts with app"])
        self.assertEqual([name for name, _ in routes], ["app", "app", "example.org"])

    def test_inventory_lists_services_and_their_routes_without_sites(self):
        site = StaticSite("web", {"name": "site.example.org", "origin": WEB["origin"]})
        value = ingress.inventory([Service("app", APP), External("shell", SHELL), site], settings.CONFIG)
        self.assertEqual(value["webhook"], settings.CONFIG["webhook"]["hostname"])
        self.assertEqual(value["services"]["app"]["health"], {"url": "http://127.0.0.1:9001/healthz",
                                                              "json": {"ok": True}})
        self.assertIsNone(value["services"]["shell"]["health"])
        self.assertEqual([(r["hostname"], r["service"], r["path"], r["probes"]) for r in value["routes"]],
                         [("app.example.org", "app", None, None),
                          ("example.org", "app", "^/app(/.*)?$", ["/app"]),
                          ("shell.example.org", "shell", None, None)])


if __name__ == "__main__":
    unittest.main()

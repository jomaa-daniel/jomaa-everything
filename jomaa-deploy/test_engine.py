"""Engine checks: modules deploy, fail, stay unchanged and disappear independently of each other."""
import contextlib
import io
import json
import shutil
import unittest
from pathlib import Path

import engine
import routing
import settings
from fixtures import APP, SHELL, TUNNEL_HEADER, ModuleTestCase, cname
from modules import Context, ingress
from modules.base import expand, unit_text

ALL_JOBS = {"check (app)": "success", "check (bench)": "success"}
APP_WITHOUT_UNIT = {k: v for k, v in APP.items() if k != "unit"}


RECORD_FIELDS = {"name", "kind", "directory", "revision", "fingerprint", "declaration", "failed"}


class Crash(BaseException):
    """Stops an activation the way a killed process does: no handler catches it."""


class EngineTest(ModuleTestCase):
    def first_deployment(self, **kwargs):
        self.add_all()
        ctx = self.context(self.commit("initial"), **kwargs)
        return ctx, engine.activate(ctx, ALL_JOBS)

    def test_first_deployment_deploys_every_module_and_records_it(self):
        ctx, result = self.first_deployment()
        self.assertEqual(result["status"], "deployed", result)
        self.assertEqual(result["modules"], {"app": "deployed", "bench": "deployed", "one.example.org": "deployed",
                                             "shell": "deployed", "tool": "deployed", "web": "deployed"})
        self.assertEqual((self.deploy_dir / "current").resolve(), ctx.release)
        self.assertEqual(self.restarted(ctx), {"jomaa-app", "jomaa-web", "jomaa-cloudflared"})
        unit = (self.unit_dir / "jomaa-app.service").read_text()
        self.assertIn(f"WorkingDirectory={self.deploy_dir}/modules/app/current/app", unit)
        self.assertIn(f"{self.deploy_dir}/modules/app/current/app/server.py", unit)
        self.assertEqual((self.deploy_dir / "modules/app/current").resolve(), ctx.release)
        record = json.loads((self.deploy_dir / "modules/app/record.json").read_text())
        self.assertEqual((record["revision"], record["declaration"], record["failed"]), (ctx.sha, APP, False))
        self.assertEqual((ctx.release / "app/.env").resolve(), (self.source / "app/.env").resolve())
        self.assertEqual(ctx.sites.load(), {"one.example.org": str(ctx.release / "web/one.example.org")})
        tunnel = self.tunnel.read_text()
        for host in ("app.example.org", "example.org", "shell.example.org", "one.example.org"):
            self.assertIn(f'"{host}"', tunnel)
        self.assertLess(tunnel.index("^/deploy$"), tunnel.index("app.example.org"))
        self.assertTrue(tunnel.rstrip().endswith('service: "http_status:404"'))
        self.assertEqual(set(result["ingress"]["dns"].values()), {"created"})
        inventory = json.loads((ctx.release / "tool/inventory.json").read_text())
        self.assertEqual(inventory, ingress.inventory(
            [engine.instance(r) for r in engine.records(self.deploy_dir).values()], settings.CONFIG))
        self.assertEqual({r["service"] for r in inventory["routes"]}, {"app", "shell"})

    def test_one_failing_module_leaves_the_others_deployed(self):
        ctx, result = self.first_deployment(failing={"build-app"})
        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["modules"]["app"], "failed")
        for name in ("web", "shell", "tool", "bench", "one.example.org"):
            self.assertEqual(result["modules"][name], "deployed", name)
        self.assertNotIn("app.example.org", self.tunnel.read_text())
        self.assertIn("shell.example.org", self.tunnel.read_text())
        self.assertFalse((self.unit_dir / "jomaa-app.service").exists())
        self.assertTrue(json.loads((self.deploy_dir / "modules/app/record.json").read_text())["failed"])

    def test_failed_health_check_restores_the_previous_version(self):
        self.first_deployment()
        old_unit = (self.unit_dir / "jomaa-app.service").read_text()
        previous = (self.deploy_dir / "modules/app/current").resolve()
        self.write("app/server.py", "# broken app\n")
        ctx = self.context(self.commit())
        calls = []

        def healthy(check):
            calls.append(check["url"])
            # The new version is unhealthy; the restored one answers again.
            return check["url"] != "http://127.0.0.1:9001/healthz" or calls.count(check["url"]) > 1
        ctx.healthy = healthy
        result = engine.activate(ctx, ALL_JOBS)
        self.assertEqual(result["modules"]["app"], "failed")
        self.assertEqual((self.deploy_dir / "modules/app/current").resolve(), previous)
        self.assertEqual((self.unit_dir / "jomaa-app.service").read_text(), old_unit)
        self.assertEqual(self.restarted(ctx), {"jomaa-app"})

    def test_unrestorable_module_is_reported(self):
        self.first_deployment()
        self.write("app/server.py", "# broken app\n")
        ctx = self.context(self.commit(), unhealthy={"http://127.0.0.1:9001/healthz"})
        result = engine.activate(ctx, ALL_JOBS)
        self.assertEqual(result["modules"]["app"], "failed-unrestored")
        self.assertEqual(result["status"], "partial")

    def test_unchanged_modules_are_not_rebuilt_or_restarted(self):
        first, _ = self.first_deployment()
        self.write("app/server.py", "# app, second version\n")
        ctx = self.context(self.commit())
        result = engine.activate(ctx, ALL_JOBS)
        self.assertEqual(result["status"], "deployed")
        self.assertEqual(result["modules"], {"app": "deployed", "bench": "unchanged", "one.example.org": "unchanged",
                                             "shell": "unchanged", "tool": "deployed", "web": "unchanged"})
        self.assertEqual(self.restarted(ctx), {"jomaa-app"})
        self.assertEqual(self.built(ctx), {"build-app", "tool-build", "tool-run"})
        self.assertEqual((self.deploy_dir / "modules/web/current").resolve(), first.release)
        self.assertEqual((self.deploy_dir / "modules/app/previous").resolve(), first.release)
        self.assertEqual(result["ingress"]["tunnel"], "unchanged")
        self.assertEqual(set(result["ingress"]["dns"].values()), {"unchanged"})
        self.assertEqual((self.deploy_dir / "current").resolve(), ctx.release)

    def test_input_paths_change_the_fingerprint(self):
        self.add_all()
        self.write("shared/lib.txt", "one")
        self.add_module("app", {**self.app_declaration(), "inputs": ["shared"]})
        engine.activate(self.context(self.commit()), ALL_JOBS)
        self.write("shared/lib.txt", "two")
        result = engine.activate(self.context(self.commit()), ALL_JOBS)
        self.assertEqual(result["modules"]["app"], "deployed")
        self.assertEqual(result["modules"]["web"], "unchanged")

    def app_declaration(self):
        return json.loads((self.repo / "app/deploy.json").read_text())

    def test_failed_module_is_retried_on_the_next_activation(self):
        self.first_deployment(failing={"build-app"})
        ctx = self.context(self.git("rev-parse", "HEAD"))
        result = engine.activate(ctx, ALL_JOBS)
        self.assertEqual(result["modules"]["app"], "deployed")
        self.assertEqual(result["modules"]["web"], "unchanged")
        self.assertIn("app.example.org", self.tunnel.read_text())

    def test_removed_module_is_stopped_and_its_routes_and_dns_go(self):
        self.first_deployment()
        shutil.rmtree(self.repo / "app")
        ctx = self.context(self.commit("remove app"))
        result = engine.activate(ctx, ALL_JOBS)
        self.assertEqual(result["modules"]["app"], "removed")
        self.assertEqual(result["status"], "deployed")
        self.assertIn(("systemctl", "--user", "disable", "--now", "jomaa-app.service"), ctx.calls)
        self.assertFalse((self.unit_dir / "jomaa-app.service").exists())
        self.assertFalse((self.deploy_dir / "modules/app").exists())
        self.assertNotIn("app.example.org", self.tunnel.read_text())
        self.assertEqual(result["ingress"]["dns"]["app.example.org"], "deleted")
        self.assertNotIn("app.example.org", self.cloudflare.hosts())

    def test_module_that_fails_to_import_counts_as_failed_and_keeps_its_version(self):
        first, _ = self.first_deployment()
        self.write("app/deploy_module.py", "from modules import Service\n\nclass App(Service)\n")
        ctx = self.context(self.commit("broken import"))
        result = engine.activate(ctx, ALL_JOBS)
        self.assertEqual(result["modules"]["app"], "failed")
        self.assertEqual(result["status"], "partial")
        self.assertTrue((self.deploy_dir / "modules/app/record.json").exists())
        self.assertEqual((self.deploy_dir / "modules/app/current").resolve(), first.release)
        self.assertNotIn(("systemctl", "--user", "disable", "--now", "jomaa-app.service"), ctx.calls)
        self.assertIn("app.example.org", self.tunnel.read_text())
        self.assertEqual(result["ingress"]["dns"]["app.example.org"], "unchanged")

    def test_invalid_declaration_fails_only_its_module(self):
        self.add_all()
        self.add_module("app", {**APP_WITHOUT_UNIT})
        result = engine.activate(self.context(self.commit()), ALL_JOBS)
        self.assertEqual(result["modules"]["app"], "failed")
        self.assertEqual(result["modules"]["web"], "deployed")

    def test_failing_static_site_keeps_its_previous_directory(self):
        first, _ = self.first_deployment()
        self.write("web/one.example.org/index.html", "one, second version")
        self.write("web/two.example.org/index.html", "two")
        ctx = self.context(self.commit(), unhealthy={"one.example.org", "two.example.org"})
        result = engine.activate(ctx, ALL_JOBS)
        self.assertEqual(result["modules"]["one.example.org"], "failed")
        self.assertEqual(result["modules"]["two.example.org"], "failed")
        self.assertEqual(ctx.sites.load(), {"one.example.org": str(first.release / "web/one.example.org")})
        self.assertIn("one.example.org", self.tunnel.read_text())
        self.assertNotIn("two.example.org", self.tunnel.read_text())
        self.assertEqual(result["modules"]["web"], "unchanged")
        self.assertEqual(self.restarted(ctx), set())

    def test_static_site_serving_other_bytes_fails_and_keeps_its_previous_directory(self):
        first, _ = self.first_deployment()
        self.write("web/one.example.org/index.html", "one, second version")
        ctx = self.context(self.commit(), served={"one.example.org": b"one"})
        result = engine.activate(ctx, ALL_JOBS)
        self.assertEqual(result["modules"]["one.example.org"], "failed")
        self.assertEqual(ctx.sites.load(), {"one.example.org": str(first.release / "web/one.example.org")})
        self.assertTrue(json.loads((self.deploy_dir / "modules/one.example.org/record.json").read_text())["failed"])

    def test_site_with_a_missing_asset_fails_alone(self):
        self.add_all()
        self.write("web/two.example.org/index.html", '<script src="app.js"></script>')
        self.write("web/one.example.org/index.html", '<link rel="stylesheet" href="style.css">')
        self.write("web/one.example.org/style.css", "body {}")
        ctx = self.context(self.commit())
        result = engine.activate(ctx, ALL_JOBS)
        self.assertEqual(result["modules"]["two.example.org"], "failed")
        self.assertEqual(result["modules"]["one.example.org"], "deployed")
        self.assertEqual(result["modules"]["web"], "deployed")
        self.assertEqual(ctx.sites.load(), {"one.example.org": str(ctx.release / "web/one.example.org")})

    def test_site_change_redeploys_only_that_site_and_server_change_the_server(self):
        self.first_deployment()
        self.write("web/one.example.org/index.html", "one, second version")
        ctx = self.context(self.commit())
        result = engine.activate(ctx, ALL_JOBS)
        self.assertEqual((result["modules"]["web"], result["modules"]["one.example.org"]), ("unchanged", "deployed"))
        self.assertEqual(self.restarted(ctx), set())
        self.assertEqual(ctx.sites.load(), {"one.example.org": str(ctx.release / "web/one.example.org")})
        self.write("web/serve.py", "# web, second version\n")
        ctx = self.context(self.commit())
        result = engine.activate(ctx, ALL_JOBS)
        self.assertEqual((result["modules"]["web"], result["modules"]["one.example.org"]), ("deployed", "unchanged"))
        self.assertEqual(self.restarted(ctx), {"jomaa-web"})

    def test_failed_first_activation_restores_a_unit_it_replaced(self):
        old_unit = b"[Service]\nExecStart=/previous/deployer/hub\n"
        (self.unit_dir / "jomaa-app.service").write_bytes(old_unit)
        self.add_all()
        ctx = self.context(self.commit())
        checks = []

        def healthy(check):
            checks.append(check["url"])
            # The new version is unhealthy; the restored unit answers again.
            return check["url"] != "http://127.0.0.1:9001/healthz" or checks.count(check["url"]) > 1
        ctx.healthy = healthy
        result = engine.activate(ctx, ALL_JOBS)
        self.assertEqual(result["modules"]["app"], "failed")
        self.assertEqual((self.unit_dir / "jomaa-app.service").read_bytes(), old_unit)
        self.assertEqual([c for c in ctx.calls if "jomaa-app.service" in c][-1],
                         ("systemctl", "--user", "restart", "jomaa-app.service"))
        self.assertNotIn(("systemctl", "--user", "disable", "--now", "jomaa-app.service"), ctx.calls)
        self.assertFalse((self.deploy_dir / "modules/app/current").exists())
        unhealthy = self.context(self.git("rev-parse", "HEAD"), unhealthy={"http://127.0.0.1:9001/healthz"})
        (self.unit_dir / "jomaa-app.service").write_bytes(old_unit)
        self.assertEqual(engine.activate(unhealthy, ALL_JOBS)["modules"]["app"], "failed-unrestored")
        self.assertEqual((self.unit_dir / "jomaa-app.service").read_bytes(), old_unit)

    def test_site_without_an_index_fails_alone(self):
        self.add_all()
        self.write("web/bad.example.org/readme.txt", "no index")
        result = engine.activate(self.context(self.commit()), ALL_JOBS)
        self.assertEqual(result["modules"]["bad.example.org"], "failed")
        self.assertEqual(result["modules"]["one.example.org"], "deployed")

    def test_removed_site_leaves_the_site_map(self):
        self.first_deployment()
        shutil.rmtree(self.repo / "web/one.example.org")
        ctx = self.context(self.commit())
        result = engine.activate(ctx, ALL_JOBS)
        self.assertEqual(result["modules"]["one.example.org"], "removed")
        self.assertEqual(ctx.sites.load(), {})
        self.assertEqual(result["modules"]["web"], "unchanged")

    def test_dns_conflict_on_one_host_leaves_the_others(self):
        self.cloudflare.records["9"] = {"id": "9", "type": "A", "name": "shell.example.org", "content": "192.0.2.1"}
        _, result = self.first_deployment()
        dns = result["ingress"]["dns"]
        self.assertEqual(dns["shell.example.org"], "conflict")
        self.assertEqual(dns["app.example.org"], "created")
        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["modules"]["shell"], "deployed")
        self.assertEqual(self.cloudflare.records["9"]["type"], "A")

    def test_dns_error_on_one_host_leaves_the_others(self):
        self.cloudflare.broken = {"app.example.org"}
        _, result = self.first_deployment()
        self.assertEqual(result["ingress"]["dns"]["app.example.org"], "failed")
        self.assertEqual(result["ingress"]["dns"]["shell.example.org"], "created")

    def test_module_whose_check_failed_is_ineligible(self):
        self.add_all()
        ctx = self.context(self.commit())
        result = engine.activate(ctx, {"check (app)": "failure", "check (bench)": "success"})
        self.assertEqual(result["modules"]["app"], "ineligible")
        self.assertEqual(result["status"], "partial")
        self.assertNotIn("build-app", self.built(ctx))
        self.assertEqual(result["modules"]["web"], "deployed")
        missing = engine.activate(self.context(self.git("rev-parse", "HEAD")), {"check (app)": "success"})
        self.assertEqual(missing["modules"]["bench"], "ineligible")

    def test_command_failure_does_not_affect_the_others(self):
        ctx, result = self.first_deployment(failing={"tool-run"})
        self.assertEqual(result["modules"]["tool"], "failed")
        self.assertEqual({name for name, status in result["modules"].items() if status != "deployed"}, {"tool"})
        retry = self.context(self.git("rev-parse", "HEAD"))
        self.assertEqual(engine.activate(retry, ALL_JOBS)["modules"]["tool"], "deployed")
        self.assertIn(("tool-run",), retry.calls)

    def test_commands_run_on_every_activation(self):
        self.first_deployment()
        ctx = self.context(self.git("rev-parse", "HEAD"))
        result = engine.activate(ctx, ALL_JOBS)
        self.assertEqual(result["modules"]["tool"], "deployed")
        self.assertEqual(self.built(ctx), {"tool-build", "tool-run"})

    def test_failing_self_check_keeps_current_and_reports_partial(self):
        first, result = self.first_deployment()
        self.assertEqual(result["engine"], "deployed")
        self.assertEqual((self.deploy_dir / "current").resolve(), first.release)
        self.write("jomaa-deploy/deploy.py", "raise SystemExit(1)\n")
        self.write("app/server.py", "# app, second version\n")
        ctx = self.context(self.commit("broken receiver"))
        with contextlib.redirect_stderr(io.StringIO()) as errors:
            result = engine.activate(ctx, ALL_JOBS)
        self.assertEqual(result["engine"], "failed")
        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["modules"]["app"], "deployed")
        self.assertTrue(all(status in engine.SUCCESS for status in result["modules"].values()), result)
        self.assertEqual((self.deploy_dir / "current").resolve(), first.release)
        self.assertEqual((self.deploy_dir / "modules/app/current").resolve(), ctx.release)
        self.assertIn("self-check", errors.getvalue())

    def crash_on_app_health(self, ctx):
        """Make the app's health check stop the activation with an exception that nothing catches."""
        def healthy(check):
            if check["url"] == "http://127.0.0.1:9001/healthz":
                raise Crash()
            return True
        ctx.healthy = healthy
        with self.assertRaises(Crash):
            engine.activate(ctx, ALL_JOBS)

    def watch_build(self, ctx, seen):
        """Record the app pointer and unit text when the app's build starts."""
        original = ctx.run

        def run(*args, cwd=None):
            if args == ("build-app",):
                pointer = self.deploy_dir / "modules/app/current"
                seen.append((pointer.resolve() if pointer.exists() else None,
                             (self.unit_dir / "jomaa-app.service").read_text()))
            original(*args, cwd=cwd)
        ctx.run = run

    def test_deployment_that_stopped_mid_way_is_restored_then_redeployed(self):
        first, _ = self.first_deployment()
        old_unit = (self.unit_dir / "jomaa-app.service").read_text()
        pointer = self.deploy_dir / "modules/app/current"
        record_file = self.deploy_dir / "modules/app/record.json"
        pending_file = self.deploy_dir / "modules/app/pending.json"
        recorded = record_file.read_text()
        self.write("app/server.py", "# app, second version\n")
        sha = self.commit()
        crashed = self.context(sha)
        self.crash_on_app_health(crashed)
        self.assertEqual(json.loads(pending_file.read_text()),
                         {"revision": sha, "snapshot": {"pointer": str(first.release), "unit": old_unit}})
        self.assertEqual(record_file.read_text(), recorded)
        self.assertEqual(pointer.resolve(), crashed.release)
        ctx = self.context(sha)
        seen = []
        self.watch_build(ctx, seen)
        with contextlib.redirect_stderr(io.StringIO()) as errors:
            result = engine.activate(ctx, ALL_JOBS)
        self.assertIn("app stopped while deploying", errors.getvalue())
        self.assertEqual(seen, [(first.release, old_unit)])
        self.assertEqual(result["modules"]["app"], "deployed")
        self.assertEqual(pointer.resolve(), ctx.release)
        self.assertFalse(pending_file.exists())
        record = json.loads(record_file.read_text())
        self.assertEqual((record["revision"], record["failed"]), (sha, False))
        self.assertEqual(set(record), RECORD_FIELDS)

    def test_stopped_first_run_service_restores_the_unit_text_it_replaced(self):
        old_unit = "[Service]\nExecStart=/previous/deployer/hub\n"
        (self.unit_dir / "jomaa-app.service").write_text(old_unit)
        record_file = self.deploy_dir / "modules/app/record.json"
        pending_file = self.deploy_dir / "modules/app/pending.json"
        self.add_all()
        sha = self.commit()
        self.crash_on_app_health(self.context(sha))
        self.assertFalse(record_file.exists())
        self.assertEqual(json.loads(pending_file.read_text())["snapshot"], {"pointer": None, "unit": old_unit})
        self.assertNotEqual((self.unit_dir / "jomaa-app.service").read_text(), old_unit)
        ctx = self.context(sha)
        with contextlib.redirect_stderr(io.StringIO()):
            result = engine.activate(ctx, {**ALL_JOBS, "check (app)": "failure"})
        self.assertEqual(result["modules"]["app"], "ineligible")
        self.assertEqual((self.unit_dir / "jomaa-app.service").read_text(), old_unit)
        self.assertFalse((self.deploy_dir / "modules/app/current").exists())
        self.assertIn(("systemctl", "--user", "restart", "jomaa-app.service"), ctx.calls)
        self.assertFalse(pending_file.exists())
        self.assertEqual(json.loads(record_file.read_text()),
                         {"name": "app", "kind": "Service", "directory": "app", "revision": None,
                          "fingerprint": None, "declaration": None, "failed": True})
        retry = self.context(sha)
        self.assertEqual(engine.activate(retry, ALL_JOBS)["modules"]["app"], "deployed")

    def test_record_written_by_c187fc0_loads_unchanged(self):
        first, _ = self.first_deployment()
        declaration = {key: value for key, value in APP.items() if key != "stateInputs"}
        record = {"name": "app", "kind": "Service", "directory": "app", "revision": first.sha,
                  "fingerprint": "f" * 64, "declaration": declaration, "failed": False}
        (self.deploy_dir / "modules/app/record.json").write_text(json.dumps(record, indent=2) + "\n")
        self.assertEqual(engine.records(self.deploy_dir)["app"], record)

    def test_route_claimed_by_two_modules_is_kept_by_the_first(self):
        self.add_all()
        self.add_module("shell", {**SHELL,
                                  "routes": [{"hostname": "app.example.org"}]})
        result = engine.activate(self.context(self.commit()), ALL_JOBS)
        self.assertEqual(result["ingress"]["conflicts"], ["app.example.org: shell conflicts with app"])
        self.assertEqual(result["status"], "partial")



class FirstRunTest(ModuleTestCase):
    """The first activation over the layout of the previous deployer on jerry."""

    REAL = ("jomaa-deploy", "jomaa-home-hub", "jomaa-static-pages", "jomaa-ssh", "jomaa-tailscale", "jomaa-health",
            "pico-imaging-bench")

    def test_first_run_reuses_units_routes_dns_and_the_tunnel(self):
        checkout = Path(__file__).resolve().parent.parent
        for directory in self.REAL:
            for name in ("deploy_module.py", "deploy.json"):
                self.write(f"{directory}/{name}", (checkout / directory / name).read_text())
        for path in ("jomaa-deploy/boot.py", "jomaa-deploy/settings.py", "jomaa-deploy/config.json",
                     "jomaa-static-pages/device-panel/index.html", "jomaa-static-pages/serve.py",
                     "jomaa-static-pages/sarah.jomaa.org/index.html"):
            self.write(path, "fixture\n")
        for state in ("jomaa-home-hub/.env", "jomaa-home-hub/config.json", "jomaa-tailscale/.env"):
            (self.source / state).parent.mkdir(parents=True, exist_ok=True)
            (self.source / state).write_text("fixture\n")
        (self.source / "jomaa-home-hub/data/matter-data").mkdir(parents=True)
        old = self.deploy_dir / "releases/old"
        (old / "jomaa-deploy").mkdir(parents=True)
        (old / ".revision").write_text("old\n")
        current = self.deploy_dir / "current"
        current.symlink_to(old, target_is_directory=True)
        python = ["{python}"]
        for unit, directory, command in (
                ("jomaa-hub", "jomaa-home-hub", [*python, "{release}/jomaa-deploy/boot.py", "hub"]),
                ("jomaa-static-pages", "jomaa-static-pages", [*python, "{release}/jomaa-static-pages/serve.py"])):
            (self.unit_dir / f"{unit}.service").write_text(unit_text(expand(command, current), current / directory, {}))
        tunnel_unit = self.unit_dir / "jomaa-cloudflared.service"
        tunnel_unit.write_text(ingress.tunnel_unit(self.context_for_paths()))
        hub = json.loads((checkout / "jomaa-home-hub/deploy.json").read_text())
        rules = [{"hostname": "hub.jomaa.org", "path": "^/deploy$", "service": "http://127.0.0.1:8091"},
                 {"hostname": "hub.jomaa.org", "service": "http://127.0.0.1:8080"},
                 {"hostname": "jomaa.org", "service": "http://127.0.0.1:8080", "path": hub["routes"][1]["path"]},
                 {"hostname": "ssh.jomaa.org", "service": "ssh://127.0.0.1:2222"},
                 {"hostname": "sarah.jomaa.org", "service": "http://127.0.0.1:8090"},
                 {"service": "http_status:404"}]
        previous_tunnel = routing.render(TUNNEL_HEADER + "ingress:\n", rules)
        self.tunnel.write_text(previous_tunnel)
        hosts = ("hub.jomaa.org", "jomaa.org", "ssh.jomaa.org", "sarah.jomaa.org")
        self.cloudflare.records = {str(i): {"id": str(i), **cname(h)} for i, h in enumerate(hosts)}
        jobs = {f"check ({name})": "success" for name in ("hub", "static", "ssh", "tailnet", "health",
                                                          "pico-imaging-bench")}
        jobs["verify"] = "success"
        ctx = self.context(self.commit("module system"))
        result = engine.activate(ctx, jobs)

        self.assertEqual(result["status"], "deployed", result)
        self.assertEqual(set(result["modules"].values()), {"deployed"})
        self.assertEqual(set(result["modules"]), {"deploy", "hub", "static", "sarah.jomaa.org", "ssh", "tailnet",
                                                  "health", "pico-imaging-bench"})
        self.assertEqual(current.resolve(), ctx.release)
        self.assertEqual(self.restarted(ctx), {"jomaa-hub", "jomaa-static-pages"})
        hub_unit = (self.unit_dir / "jomaa-hub.service").read_text()
        self.assertIn(f"{self.deploy_dir}/modules/hub/current/jomaa-deploy/boot.py", hub_unit)
        self.assertEqual(sorted(p.name for p in self.unit_dir.iterdir()),
                         ["jomaa-cloudflared.service", "jomaa-hub.service", "jomaa-static-pages.service"])
        self.assertEqual(self.tunnel.read_text(), previous_tunnel)
        self.assertEqual(result["ingress"]["tunnel"], "unchanged")
        self.assertEqual(result["ingress"]["dns"], {h: "unchanged" for h in hosts})
        self.assertEqual(self.cloudflare.mutations, [])
        self.assertEqual(ctx.sites.load(), {"sarah.jomaa.org": str(ctx.release / "jomaa-static-pages/sarah.jomaa.org")})
        for state in ("jomaa-home-hub/.env", "jomaa-home-hub/data", "jomaa-tailscale/.env"):
            self.assertEqual((ctx.release / state).resolve(), (self.source / state).resolve())
        self.assertIn(("npm", "ci", "--no-audit", "--no-fund"), ctx.calls)
        self.assertIn(("npm", "run", "build"), ctx.calls)
        inventory = json.loads((ctx.release / "jomaa-health/inventory.json").read_text())
        fixture = json.loads((checkout / "jomaa-health/src/inventory.fixture.json").read_text())
        self.assertEqual(inventory["webhook"], fixture["webhook"])
        self.assertEqual(set(inventory["services"]), set(fixture["services"]))
        self.assertEqual([(r["hostname"], r["service"], r["path"] is None) for r in inventory["routes"]],
                         [(r["hostname"], r["service"], r["path"] is None) for r in fixture["routes"]])

    def context_for_paths(self):
        return Context(self.source, self.deploy_dir, self.deploy_dir, "", self.repo, unit_dir=self.unit_dir)


if __name__ == "__main__":
    unittest.main()

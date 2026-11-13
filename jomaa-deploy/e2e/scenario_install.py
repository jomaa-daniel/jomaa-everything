"""Install rows N1 and N2, one clean push and deployment of every fixture module through notify.py, then N3 and N4."""
from __future__ import annotations

import hashlib
import json
import secrets

import harness

FIXTURE_MODULES = {folder: json.loads((harness.TEMPLATES / folder / harness.DECLARATION).read_text())["name"]
                   for folder in harness.templates()}
SERVICES = [folder for folder in FIXTURE_MODULES if (harness.TEMPLATES / folder / harness.BEHAVIOR).exists()
            and json.loads((harness.TEMPLATES / folder / harness.DECLARATION).read_text()).get("unit")]
MUTATIONS = ("POST", "PUT", "DELETE")
BINARY = "cloudflared"


class Install(harness.E2ETestCase):
    install = False

    def unit_starts(self) -> dict[str, str]:
        units = [self.h.repo.declaration(folder)["unit"] for folder in SERVICES]
        units.append(self.h.repo.declaration("jomaa-static-pages")["unit"])
        return {unit: self.h.unit_property(unit, "ExecMainStartTimestamp") for unit in units}

    def records(self) -> dict[str, str | None]:
        return {name: self.h.read(f"modules/{name}/{harness.engine.RECORD}")
                for name in self.h.listdir(self.h.deploy_path("modules"))}

    def sync_checkout(self) -> None:
        """Fast-forward jerry's checkout to the fixture main, so installing there activates nothing."""
        self.h.exec_as_jerry("git", "-C", self.h.checkout, "pull", "-q", "--ff-only", "origin", "main")

    def downloads(self) -> list[str]:
        """The cloudflared binary and any partial download of it in the tunnel directory."""
        return [name for name in self.h.listdir(self.h.native) if name.startswith(BINARY)]

    def test_1_fresh_install(self):
        """N1: an empty jerry with a pre-seeded tunnel.yml and credentials file installs and deploys everything."""
        h = self.h
        mark = h.fakes.mark()
        h.prepare_checkout()
        result = h.install()
        self.assertEqual(result.code, 0, result.output)
        activation = h.last_result
        self.assertIsNotNone(activation, result.output)
        self.assertEqual(activation["status"], "deployed", activation)
        self.assertTrue(set(FIXTURE_MODULES.values()) <= set(activation["modules"]), activation)
        self.assertEqual({s for s in activation["modules"].values()}, {"deployed"}, activation)
        self.assertEqual(activation["ingress"]["tunnel"], "updated", activation)
        receiver = h.settings["receiverUnit"]
        self.assertEqual(h.systemctl_user("is-enabled", receiver).out.strip(), "enabled")
        harness.wait_for(lambda: h.unit_active(receiver), harness.TIMEOUTS["bootSeconds"], f"{receiver} is not active")
        tunnel = h.settings["tunnel"]["unit"]
        harness.wait_for(lambda: h.unit_active(tunnel), harness.TIMEOUTS["bootSeconds"], f"{tunnel} is not active")
        binary = h.exec_as_jerry("sha256sum", f"{h.native}/cloudflared").out.split()[0]
        self.assertEqual(binary, hashlib.sha256((harness.E2E / "cloudflared").read_bytes()).hexdigest())
        requests = h.fakes.requests(since=mark)
        tag = f"/releases/tags/{harness.DEPLOY_CONFIG['tunnel']['cloudflaredVersion']}"
        self.assertEqual(len([r for r in requests if r["path"].endswith(tag)]), 1, requests)
        self.assertEqual(len([r for r in requests if r["path"].startswith("/_assets/")]), 1, requests)
        self.assertIsNotNone(h.read(harness.SECRET_FILE))
        host = h.repo.declaration("fx-alpha")["routes"][0]["hostname"]
        body = h.wait_edge(host, "/")
        self.assertEqual(json.loads(body)["version"], h.repo.behavior("fx-alpha")["version"])

    def test_2_reinstall_same_revision(self):
        """N2: installing again at the deployed revision activates nothing."""
        h = self.h
        starts, records = self.unit_starts(), self.records()
        results = h.listdir(h.deploy_path("results"))
        mark = h.fakes.mark()
        result = h.install()
        self.assertEqual(result.code, 0, result.output)
        self.assertIsNone(h.printed_activation(result.out), result.output)
        self.assertEqual(self.unit_starts(), starts)
        self.assertEqual(self.records(), records)
        self.assertEqual(h.listdir(h.deploy_path("results")), results)
        requests = h.fakes.requests(since=mark)
        self.assertEqual([r for r in requests if r["method"] in MUTATIONS], [], requests)
        self.assertEqual([r for r in requests if "/releases/" in r["path"] or r["path"].startswith("/_assets/")],
                         [], requests)

    def test_3_push_deploys_every_fixture_module(self):
        """A push that changes every fixture module deploys each of them through notify.py."""
        h = self.h
        for folder in FIXTURE_MODULES:
            if h.repo.exists(f"{folder}/{harness.BEHAVIOR}"):
                h.repo.set_behavior(folder, version="v2")
            else:
                h.repo.write(f"{folder}/notes.txt", "v2\n")
        sha = h.repo.commit("Change every fixture module")
        h.push()
        result = h.notify(sha)
        self.assertEqual((result.code, result.status), (0, "deployed"), result.output)
        stored = h.stored_result(sha, result.run_id, result.attempt)
        for name in FIXTURE_MODULES.values():
            self.assertEqual(stored["modules"][name], "deployed", stored)
        for name, status in stored["modules"].items():
            if name not in FIXTURE_MODULES.values():
                self.assertEqual(status, "unchanged", stored)
        for folder in SERVICES:
            self.assertEqual(h.version(folder), "v2", folder)
        alpha, beta = h.repo.declaration("fx-alpha")["routes"], h.repo.declaration("fx-beta")["routes"]
        for host, path, module in ((alpha[0]["hostname"], "/", "fx-alpha"), (alpha[1]["hostname"], "/", "fx-alpha"),
                                   (beta[1]["hostname"], beta[1]["probes"][0], "fx-beta")):
            status, body = h.edge_request(host, path)
            self.assertEqual(status, 200, body)
            self.assertEqual((json.loads(body)["module"], json.loads(body)["version"]), (module, "v2"), body)
        runs = h.read_file(h.source_path("fx-cmd/state/runs.log")) or ""
        self.assertIn(f"v2 {sha}", runs.splitlines())
        inventory = json.loads(h.read_file(h.source_path("fx-cmd/state/inventory.json")))
        self.assertTrue({"fx-alpha", "fx-beta", "fx-shell"} <= set(inventory["services"]), inventory)
        self.assertEqual(h.resolve(h.deploy_path("current")), h.deploy_path(f"releases/{sha}"))
        receiver = h.settings["receiverUnit"]
        harness.wait_for(lambda: h.unit_active(receiver), harness.TIMEOUTS["bootSeconds"], f"{receiver} is not active")

    def test_4_bad_cloudflared_digest(self):
        """N3: a cloudflared release whose digest does not match fails the installation and leaves no file."""
        h = self.h
        self.sync_checkout()
        starts, records = self.unit_starts(), self.records()
        h.remove_file(f"{h.native}/{BINARY}")
        try:
            h.fakes.set_release(digest="wrong")
            mark = h.fakes.mark()
            result = h.install()
            self.assertNotEqual(result.code, 0, result.output)
            self.assertIn("checksum", result.output)
            self.assertEqual(self.downloads(), [])
            requests = h.fakes.requests(since=mark)
            self.assertEqual(len([r for r in requests if r["path"].startswith("/_assets/")]), 1, requests)
            self.assertEqual(self.unit_starts(), starts)
            self.assertEqual(self.records(), records)
        finally:
            h.fakes.clear_faults()
            restored = h.install()
        self.assertEqual(restored.code, 0, restored.output)
        self.assertIsNone(h.printed_activation(restored.out), restored.output)
        binary = h.exec_as_jerry("sha256sum", f"{h.native}/{BINARY}").out.split()[0]
        self.assertEqual(binary, hashlib.sha256((harness.E2E / "cloudflared").read_bytes()).hexdigest())

    def test_5_short_password_and_missing_token(self):
        """N4: a short HUB_PASSWORD or a missing CLOUDFLARE_API_TOKEN fails the installation before Cloudflare."""
        h = self.h
        env = h.source_path(h.settings["cloudflare"]["env"])
        original = h.read_file(env)
        minimum = h.settings["hubPasswordMinLength"]
        cases = {"HUB_PASSWORD": f"HUB_PASSWORD={'x' * (minimum - 1)}\nCLOUDFLARE_API_TOKEN={h.token}\n",
                 "CLOUDFLARE_API_TOKEN": f"HUB_PASSWORD={secrets.token_urlsafe(minimum)}\n"}
        starts, records = self.unit_starts(), self.records()
        results = h.listdir(h.deploy_path("results"))
        try:
            for name, content in cases.items():
                with self.subTest(name):
                    h.write_file(env, content)
                    mark = h.fakes.mark()
                    result = h.install()
                    self.assertNotEqual(result.code, 0, result.output)
                    self.assertIn(name, result.output)
                    self.assertIsNone(h.printed_activation(result.out), result.output)
                    requests = h.fakes.requests(since=mark)
                    self.assertEqual([r for r in requests if r["path"].startswith(harness.FAKES["cloudflarePath"])],
                                     [], requests)
                    self.assertEqual(self.unit_starts(), starts)
                    self.assertEqual(self.records(), records)
                    self.assertEqual(h.listdir(h.deploy_path("results")), results)
        finally:
            h.write_file(env, original)


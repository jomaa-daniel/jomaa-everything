"""Node catalogs bound module activation, ingress and deployment destinations."""
import copy
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import engine
import nodes
import notify
import settings
from fixtures import ModuleTestCase
from modules import ingress
from test_config import keys

HERE = Path(__file__).resolve().parent


def catalog():
    data = nodes.catalog(settings.CONFIG)
    remote = json.loads((HERE / "nodes.example.json").read_text())
    remote.update(enabled=True, modules=["app"], moduleOverrides={
        "app": {"routes": [{"hostname": "{node.hostname}"}]}})
    data["nodes"].append(remote)
    return nodes.parse(data)


class NodeTest(unittest.TestCase):
    def test_documents_catalog_and_example(self):
        doc = (HERE / "nodes.md").read_text()
        for filename in ("nodes.json", "nodes.example.json"):
            data = json.loads((HERE / filename).read_text())
            if filename == "nodes.example.json":
                data = {"nodes": [data]}
            for key in keys(data):
                if key.startswith("nodes[].moduleOverrides."):
                    continue
                self.assertIn(f"`{key}`", doc, f"undocumented {filename} setting: {key}")

    def test_invalid_catalog_is_rejected(self):
        invalid = [
            lambda d: d.update(defaultNode="missing"),
            lambda d: d.update(identityFile="../node.json"),
            lambda d: d["nodes"][1].update(hostname="http://example.org"),
            lambda d: d["nodes"][1].update(modules=None),
            lambda d: d["nodes"][1].update(id=d["defaultNode"]),
            lambda d: d["nodes"][1].update(moduleOverrides={"shell": {}}),
            lambda d: d["transport"].update(maxRequestBytes=0),
            lambda d: d["transport"].update(secretMinLength=1),
        ]
        for change in invalid:
            data = catalog()
            change(data)
            with self.subTest(change=change), self.assertRaises(ValueError):
                nodes.parse(data)

    def test_identity_resolves_its_own_tunnel_without_mutating_shared_config(self):
        data = catalog()
        original = copy.deepcopy(settings.CONFIG)
        with tempfile.TemporaryDirectory() as temp, mock.patch.object(nodes, "catalog", return_value=data):
            root = Path(temp)
            (root / data["identityFile"]).write_text(json.dumps({"node": data["nodes"][1]["id"]}))
            remote = nodes.get(settings.CONFIG, deploy_dir=root)
            resolved = nodes.configuration(settings.CONFIG, remote)
            self.assertEqual(resolved["webhook"]["hostname"], remote["hostname"])
            self.assertEqual(resolved["tunnel"]["name"], remote["tunnelName"])
            self.assertEqual(settings.CONFIG, original)
            (root / data["identityFile"]).write_text('{"node":"missing"}')
            with self.assertRaises(ValueError):
                nodes.get(settings.CONFIG, deploy_dir=root)

    def test_remote_notification_ignores_gateway_url_override(self):
        data = catalog()
        node = data["nodes"][1]
        sha = "a" * 40
        env = {"JOMAA_DEPLOY_SECRET": "fixture-signing-key-long-enough-for-hmac",
               "JOMAA_DEPLOY_URL": "https://gateway.example.org/deploy",
               "GITHUB_REPOSITORY": "example/hub", "GITHUB_SHA": sha,
               "GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "1"}
        opener = mock.Mock()
        opener.open.return_value = io.BytesIO(json.dumps({"sha": sha, "status": "deployed",
                                                        "modules": {"app": "deployed"}}).encode())
        with mock.patch.dict(os.environ, env, clear=True), mock.patch.object(nodes, "catalog", return_value=data), \
                mock.patch.object(notify.urllib.request, "build_opener", return_value=opener):
            self.assertEqual(notify.main(["--node", node["id"]]), 0)
        request = opener.open.call_args.args[0]
        self.assertEqual(request.full_url, f"https://{node['hostname']}{settings.WEBHOOK_PATH}")


class NodeActivationTest(ModuleTestCase):
    def test_module_policy_drives_activation_and_cloudflare_routes(self):
        self.add_all()
        sha = self.commit()
        ctx = self.context(sha)
        data = catalog()
        remote = data["nodes"][1]
        (ctx.deploy_dir / data["identityFile"]).write_text(json.dumps({"node": remote["id"]}))
        with mock.patch.object(nodes, "catalog", return_value=data):
            result = engine.activate(ctx, None)
        self.assertEqual(result["modules"], {"app": "deployed"})
        self.assertEqual(result["status"], "deployed")
        self.assertEqual(set(result["ingress"]["dns"]), {remote["hostname"]})
        self.assertNotIn(("tool-run",), ctx.calls)
        modules, failures = engine.discover(ctx.release)
        self.assertEqual(failures, {})
        selected = nodes.select(modules, remote)
        routes, conflicts = ingress.ordered_routes(selected, ctx.config)
        self.assertEqual(conflicts, [])
        rules, _ = ingress.rules(routes, ctx.config)
        self.assertEqual(rules[0]["path"], "^/deploy$")
        self.assertEqual(rules[1]["hostname"], remote["hostname"])
        self.assertEqual(len(selected), 1)

    def test_overrides_cannot_change_identity_checks_or_state(self):
        self.add_all()
        modules, _ = engine.discover(self.context(self.commit()).release)
        for field in ("name", "checks", "inputs", "state"):
            remote = catalog()["nodes"][1]
            remote["moduleOverrides"] = {"app": {field: []}}
            with self.subTest(field=field), self.assertRaises(ValueError):
                nodes.select(modules, remote)

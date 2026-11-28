"""Configuration coverage, camera-source privacy and container isolation."""
import copy
import json
import tempfile
import subprocess
import importlib.util
import sys
import unittest
from pathlib import Path
from unittest import mock

import run
import container

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("frigate_deployment_test", HERE / "deploy_module.py")
assert SPEC is not None and SPEC.loader is not None
DEPLOYMENT = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = DEPLOYMENT
SPEC.loader.exec_module(DEPLOYMENT)
Frigate = DEPLOYMENT.Frigate


def keys(value, prefix=""):
    if isinstance(value, dict):
        return [item for key, field in value.items() for item in [prefix + key, *keys(field, prefix + key + ".")]]
    if isinstance(value, list):
        return [item for field in value for item in keys(field, prefix.rstrip(".") + "[].")]
    return []


class FrigateTest(unittest.TestCase):
    def test_deployment_follows_the_configured_camera_settings_pointer(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = copy.deepcopy(run.CONFIG)
            config["hubSettingsFile"] = "fixtures/hub-settings.json"
            (root / "jomaa-frigate").mkdir()
            (root / "fixtures").mkdir()
            (root / "jomaa-frigate/config.json").write_text(json.dumps(config))
            (root / config["hubSettingsFile"]).write_text(json.dumps({"cameraConfigFile": "fixtures/cameras.json"}))
            declaration = json.loads((HERE / "deploy.json").read_text())
            module = Frigate("jomaa-frigate", declaration, root)
            self.assertIn("fixtures/hub-settings.json", module.inputs)
            self.assertIn("fixtures/cameras.json", module.inputs)
            self.assertNotIn("jomaa-cameras/config.json", module.inputs)

    def test_every_setting_is_documented(self):
        doc = (HERE / "config.md").read_text()
        for key in keys(run.CONFIG):
            self.assertIn(f"`{key}`", doc, f"undocumented setting: {key}")
        self.assertFalse(json.loads((HERE / "deploy.json").read_text())["routes"])

    def test_sources_are_shared_and_not_written_into_config(self):
        cameras = run.cameras_config()
        camera = cameras["cameras"][0]
        source = "rtsp://fixture-user:private-password@camera.example.org/live"
        runtime, secrets = run.runtime_config(run.CONFIG, cameras, {camera["sourceEnv"]: source})
        self.assertEqual(list(runtime["cameras"]), [camera["id"]])
        self.assertNotIn(source, json.dumps(runtime))
        self.assertEqual(list(secrets.values()), [source])
        self.assertEqual(runtime["cameras"][camera["id"]]["ffmpeg"]["inputs"][0]["roles"], ["detect", "record"])

    def test_missing_and_disabled_sources_do_not_launch_monitoring(self):
        cameras = run.cameras_config()
        runtime, secrets = run.runtime_config(run.CONFIG, cameras, {})
        self.assertEqual(runtime["cameras"], {})
        self.assertEqual(secrets, {})
        config = copy.deepcopy(run.CONFIG)
        config["enabled"] = False
        camera = cameras["cameras"][0]
        runtime, secrets = run.runtime_config(config, cameras, {camera["sourceEnv"]: "rtsp://fixture/live"})
        self.assertEqual(runtime["cameras"], {})
        camera["monitoring"]["enabled"] = False
        runtime, secrets = run.runtime_config(run.CONFIG, cameras, {camera["sourceEnv"]: "rtsp://fixture/live"})
        self.assertEqual(runtime["cameras"], {})

    def test_native_masks_and_filters_are_preserved_and_inputs_cannot_be_overridden(self):
        cameras = run.cameras_config()
        camera = cameras["cameras"][0]
        camera["monitoring"]["config"] = {"motion": {"threshold": 40}, "objects": {"track": ["person"]}}
        env = {camera["sourceEnv"]: "rtsp://fixture/live"}
        runtime, _ = run.runtime_config(run.CONFIG, cameras, env)
        self.assertEqual(runtime["cameras"][camera["id"]]["motion"]["threshold"], 40)
        camera["monitoring"]["config"]["ffmpeg"] = {"inputs": [{"path": "unsafe"}]}
        with self.assertRaisesRegex(ValueError, "sourceEnv"):
            run.runtime_config(run.CONFIG, cameras, env)

    def test_invalid_sources_and_environment_injection_are_rejected_without_secrets(self):
        camera = run.cameras_config()["cameras"][0]
        for source in ("file://private-password@local/file", "rtsp://private-password@host/live\nOTHER=secret"):
            with self.assertRaises(ValueError) as error:
                run.runtime_config(run.CONFIG, run.cameras_config(), {camera["sourceEnv"]: source})
            self.assertNotIn("private-password", str(error.exception))

    def test_secret_files_are_private(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "runtime" / "env"
            run.private_write(path, "SECRET=fixture\n")
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(path.parent.stat().st_mode & 0o777, 0o700)

    def test_container_is_digest_pinned_and_publishes_only_loopback(self):
        config = copy.deepcopy(run.CONFIG["container"])
        container.validate(config)
        for change in (lambda: config.update(image="upstream:latest"),
                       lambda: config["ports"]["api"].update(origin="http://0.0.0.0:5000")):
            config = copy.deepcopy(run.CONFIG["container"])
            change()
            with self.assertRaises(ValueError):
                container.validate(config)
        args = container.arguments(run.CONFIG["container"], {}, Path("private.env"))
        self.assertNotIn("--privileged", args)
        self.assertNotIn("--network=host", args)
        self.assertNotIn("--publish-all", args)

    def test_unconfigured_prepare_does_not_require_a_runtime(self):
        with mock.patch.object(run.settings, "load_env", return_value={}), \
                mock.patch.dict(run.os.environ, {}, clear=True), \
                mock.patch.object(run.sys, "argv", ["run.py", "--prepare"]), \
                mock.patch.object(container, "prepare") as prepare:
            run.main()
            prepare.assert_not_called()

    def test_container_cleanup_rejects_an_unmanaged_name_collision(self):
        with mock.patch.object(container.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "{}")), \
                mock.patch.object(container, "stop") as stop:
            with self.assertRaisesRegex(RuntimeError, "unmanaged"):
                container.clear_stopped_service(run.CONFIG["container"])
            stop.assert_not_called()

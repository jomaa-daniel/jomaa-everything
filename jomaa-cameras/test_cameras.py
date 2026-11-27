"""Configuration, secret handling and verified camera service build checks."""
import copy
import json
import unittest
from pathlib import Path
from unittest import mock
import build
import run

HERE = Path(__file__).resolve().parent


def keys(value, prefix=""):
    if isinstance(value, dict):
        return [item for key, field in value.items() for item in [prefix + key, *keys(field, prefix + key + ".")]]
    if isinstance(value, list):
        return [item for field in value for item in keys(field, prefix.rstrip(".") + "[].")]
    return []


class CameraTest(unittest.TestCase):
    def test_all_settings_are_documented(self):
        config = json.loads((HERE / "config.json").read_text())
        doc = (HERE / "config.md").read_text()
        for key in keys(config):
            self.assertIn(f"`{key}`", doc, f"undocumented camera setting: {key}")
        self.assertTrue(config["server"]["metrics"])
        self.assertTrue(config["server"]["hls"])
        self.assertEqual(len(config["cameras"]), 2)

    def test_missing_sources_are_not_opened_and_secrets_are_runtime_only(self):
        config = copy.deepcopy(run.CONFIG)
        server = run.runtime_config(config, {}, run.DECLARATION["origin"])
        self.assertEqual(server["paths"], {})
        camera = config["cameras"][0]
        secret = "rtsp://fixture-user:fixture-password@camera.example.org/live"
        server = run.runtime_config(config, {camera["sourceEnv"]: secret}, run.DECLARATION["origin"])
        self.assertEqual(server["paths"], {camera["id"]: {"source": "publisher"}})
        self.assertNotIn(secret, json.dumps(config))
        self.assertNotIn(secret, json.dumps(server))
        self.assertEqual(server["metricsAddress"], run.DECLARATION["origin"].removeprefix("http://"))

    def test_invalid_source_error_does_not_expose_credentials(self):
        camera = run.CONFIG["cameras"][0]
        secret = "file://fixture-user:fixture-password@local/path"
        with self.assertRaises(ValueError) as error:
            run.runtime_config(run.CONFIG, {camera["sourceEnv"]: secret}, run.DECLARATION["origin"])
        self.assertNotIn("fixture-password", str(error.exception))

    def test_downloads_reject_incorrect_checksums(self):
        with mock.patch.object(build.urllib.request, "urlopen") as request:
            request.return_value.__enter__.return_value.read.return_value = b"bad artifact"
            with self.assertRaisesRegex(ValueError, "checksum"):
                build.download("https://example.test/artifact", "0" * 64)

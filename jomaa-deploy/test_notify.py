"""Check that the GitHub sender produces requests the receiver authenticates."""
import contextlib
import importlib.util
import io
import json
import os
import time
import unittest
from pathlib import Path
from unittest import mock

import deploy

path = Path(__file__).resolve().parent / "notify.py"
spec = importlib.util.spec_from_file_location("notify", path)
notify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(notify)


class SenderTest(unittest.TestCase):
    def test_sender_signs_the_exact_request_without_printing_the_secret(self):
        key = "fixture-secret-that-is-long-enough-for-hmac"
        sha = "a" * 40
        env = {"JOMAA_DEPLOY_SECRET": key, "GITHUB_REPOSITORY": "example/hub", "GITHUB_SHA": sha,
               "GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "1"}

        class Opener:
            def open(self, request, timeout):
                self.assert_url = request.full_url
                payload = deploy.authenticate(request.data, request.get_header("X-jomaa-signature"),
                                                      key.encode(), "example/hub", time.time())
                assert payload["sha"] == sha and payload["run_id"] == 123
                return io.BytesIO(json.dumps({"status": "deployed", "sha": sha}).encode())

        opener = Opener()
        output = io.StringIO()
        with mock.patch.dict(os.environ, env, clear=True), \
                mock.patch.object(notify.urllib.request, "build_opener", return_value=opener), \
                contextlib.redirect_stdout(output):
            self.assertEqual(notify.main(), 0)
        self.assertEqual(opener.assert_url, "https://hub.jomaa.org/deploy")
        self.assertNotIn(key, output.getvalue())

    def test_sender_requires_secret(self):
        with mock.patch.dict(os.environ, {}, clear=True), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(notify.main(), 1)

    def test_reconnect_after_tunnel_restart_accepts_already_deployed_revision(self):
        sha = "a" * 40
        env = {"JOMAA_DEPLOY_SECRET": "fixture-secret-that-is-long-enough-for-hmac",
               "GITHUB_REPOSITORY": "example/hub", "GITHUB_SHA": sha,
               "GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "1"}
        response = io.BytesIO(json.dumps({"status": "already-deployed", "sha": sha}).encode())
        opener = mock.Mock()
        opener.open.side_effect = [ConnectionResetError("tunnel restarted"), response]
        with mock.patch.dict(os.environ, env, clear=True), \
                mock.patch.object(notify.urllib.request, "build_opener", return_value=opener), \
                mock.patch.object(notify.time, "sleep") as sleep, \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(notify.main(), 0)
        self.assertEqual(opener.open.call_count, 2)
        sleep.assert_called_once_with(5)


if __name__ == "__main__":
    unittest.main()

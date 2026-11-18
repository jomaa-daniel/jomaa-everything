"""PWM readback, command acknowledgment, retries and imaging dependencies."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import runpy
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

HERE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("fan_images", HERE / "images.py")
images = importlib.util.module_from_spec(spec)
spec.loader.exec_module(images)


class PWM:
    def __init__(self, pin, freq, duty_u16):
        self.pin, self.frequency, self.duty = pin, freq, duty_u16
    def freq(self):
        return self.frequency
    def duty_u16(self, value=None):
        if value is not None:
            self.duty = value
        return self.duty


class FanTests(unittest.TestCase):
    def setUp(self):
        self.config = images.load_config()
        self.now = 0
        clock = SimpleNamespace(ticks_ms=lambda: self.now, ticks_diff=lambda a, b: a-b,
                                ticks_add=lambda a, b: a+b)
        self.machine = SimpleNamespace(PWM=PWM, Pin=lambda pin: pin)
        with patch.dict(sys.modules, {"machine": self.machine, "time": clock}):
            self.firmware = runpy.run_path(str(HERE / "firmware/fan.py"))

    def fan(self, **settings):
        with patch("builtins.open", return_value=io.StringIO(json.dumps({**self.config["fan"], **settings}))):
            return self.firmware["Fan"]("a" * 16, "b" * 32)

    def test_readback_and_inverting_driver_match_logical_duty(self):
        for inverted in (False, True):
            for percent, duty in ((0, 0), (25, 16384), (50, 32768), (100, 65535)):
                with self.subTest(inverted=inverted, percent=percent):
                    fan = self.fan(inverted=inverted, startupPercent=percent)
                    self.assertEqual(fan.pwm.duty, 65535-duty if inverted else duty)
                    self.assertEqual(fan.state()["percentCurrent"], percent)
                    self.assertIsNone(fan.state()["appliedRevision"])
                    self.assertEqual(fan.state()["frequencyHz"], self.config["fan"]["frequencyHz"])

    def test_failed_delivery_holds_pwm_and_retries_the_same_report(self):
        fan = self.fan(startupPercent=100)
        client = Mock()
        client.post.side_effect = OSError("connection lost")
        with self.assertRaises(OSError):
            fan.exchange(client)
        first = client.post.call_args.args[0].copy()
        self.assertEqual(fan.state()["percentCurrent"], 100)
        client.post.side_effect = None
        client.post.return_value = {"command": {"revision": 2, "percentSetting": 40}}
        fan.exchange(client)
        self.assertEqual(client.post.call_args.args, (first, "fan/report"))
        self.assertEqual(fan.state()["percentCurrent"], 40)
        self.assertEqual(fan.state()["appliedRevision"], 2)
        fan.exchange(client)
        self.assertEqual(client.post.call_count, 2)
        self.now += self.config["fan"]["pollMilliseconds"]
        fan.exchange(client)
        self.assertEqual(client.post.call_args.args[0]["appliedRevision"], 2)
        self.assertEqual(client.post.call_args.args[0]["sequence"], 1)

    def test_invalid_or_older_commands_never_change_pwm(self):
        fan = self.fan(startupPercent=50)
        client = Mock()
        client.post.return_value = {"command": {"revision": 3, "percentSetting": 50}}
        fan.exchange(client)
        for revision, percent in ((2, 0), (3, 25), (4, -1), (4, 101), (4, True), (True, 25), (4, None)):
            self.now += self.config["fan"]["pollMilliseconds"]
            client.post.return_value = {"command": {"revision": revision, "percentSetting": percent}}
            with self.subTest(revision=revision, percent=percent), self.assertRaises(ValueError):
                fan.exchange(client)
            self.assertEqual(fan.state()["percentCurrent"], 50)
            self.assertEqual(fan.revision, 3)

    def test_feature_requires_health_wifi_and_installs_pwm_before_health(self):
        request = {"features": ["fan", "health", "wifi"],
                   "wifi": {"ssid": "fixture", "password": "fixture", "transport": "esp8285"}}
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / "prepared"
            image = images.prepare(output, request, self.config)
            self.assertIn("fan", image["features"])
            self.assertEqual(json.loads((output / "fan_settings.json").read_text()), self.config["fan"])
            self.assertTrue((output / "fan.py").exists())
            for features in (["fan"], ["fan", "wifi"]):
                with self.assertRaises(images.ImageError):
                    images.validate_request({**request, "features": features}, self.config)
            for gpio, extra_features in ((0, []), (1, []), (4, ["i2c"]), (7, ["i2c"])):
                with self.subTest(gpio=gpio), self.assertRaises(images.ImageError):
                    images.validate_request({**request, "features": request["features"] + extra_features},
                                            {**self.config, "fan": {**self.config["fan"], "gpio": gpio}})
            self.machine.unique_id = lambda: b"12345678"
            data = {"image.json": image, "image_settings.json": self.config["telemetry"],
                    "fan_settings.json": self.config["fan"]}
            def fake_open(name, *args): return io.StringIO(json.dumps(data[name]))
            with patch("builtins.open", fake_open), patch.dict(sys.modules, {
                    "machine": self.machine,
                    "time": self.firmware["time"],
                    "fan": SimpleNamespace(Fan=self.firmware["Fan"])}), contextlib.redirect_stdout(io.StringIO()):
                status = runpy.run_path(str(HERE / "firmware/image_status.py"))
                self.assertEqual(status["fan"].state()["percentCurrent"], self.config["fan"]["startupPercent"])


if __name__ == "__main__":
    unittest.main()

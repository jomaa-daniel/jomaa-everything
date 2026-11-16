"""USB inventory, installed functions, and observed verification with simulated hardware."""
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
from unittest.mock import MagicMock, Mock, patch

HERE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("images", HERE / "images.py")
images = importlib.util.module_from_spec(spec)
spec.loader.exec_module(images)


class ImagesTests(unittest.TestCase):
    def setUp(self):
        self.config = images.load_config()
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name)

    def test_settings_documented_and_reject_bad_values(self):
        doc = (HERE / "config.md").read_text()
        def check(value, prefix=""):
            for key, item in value.items():
                name = prefix + key
                self.assertIn("`" + name + "`", doc)
                if isinstance(item, dict):
                    check(item, name + ".")
                elif isinstance(item, list) and item and isinstance(item[0], dict):
                    check(item[0], name + "[].")
        check(self.config)
        for key in ("usbTimeoutSeconds", "verificationSeconds", "healthReports"):
            invalid = {**self.config, key: 0}
            file = self.path / "config.json"
            file.write_text(json.dumps(invalid))
            with self.assertRaises(images.ImageError):
                images.load_config(file)

    def test_feature_dependencies_invalid_requests_have_no_outputs(self):
        for request in ({"features": []}, {"features": ["temperature", "temperature"]},
                        {"features": ["unknown"]}, {"features": ["health"]}, {"features": ["i2c"]},
                        {"features": ["temperature"], "wifi": {}},
                        {"features": ["wifi"], "wifi": {"ssid": "a" * 33, "password": "secret", "transport": "native"}}):
            with self.subTest(request=request), self.assertRaises(images.ImageError):
                images.prepare(self.path / "image", request, self.config)
            self.assertFalse((self.path / "image").exists())

    def test_preparation_installs_only_selected_modules_and_private_config(self):
        output = self.path / "temperature"
        image = images.prepare(output, {"features": ["temperature"]}, self.config)
        self.assertEqual(image["features"], ["temperature"])
        self.assertEqual({p.name for p in output.iterdir()}, {"main.py", "image_status.py", "image.json", "image_settings.json"})
        request = {"features": ["wifi", "health"], "wifi": {"ssid": "test-network", "password": "private-fixture", "transport": "esp8285"}}
        output = self.path / "health"
        image = images.prepare(output, request, self.config)
        self.assertEqual(image["features"], ["health", "wifi"])
        self.assertTrue((output / "health.py").exists())
        self.assertFalse((output / "stream.py").exists())
        self.assertNotIn("private-fixture", (output / "image.json").read_text())
        for file in output.iterdir():
            self.assertEqual(file.stat().st_mode & 0o777, 0o600)

    def test_inventory_uses_usb_identity_and_does_not_open_consoles(self):
        settings = self.config["discovery"].copy()
        for key in ("ttyDirectory", "blockDirectory", "deviceDirectory", "serialDirectory"):
            path = self.path / key
            path.mkdir()
            settings[key] = str(path)
        usb = self.path / "usb-identity"
        usb.mkdir()
        (usb / "idVendor").write_text(settings["vendorId"])
        (usb / "idProduct").write_text(settings["runtimeProductId"])
        (usb / "serial").write_text("5303284720e42a9c")
        tty = Path(settings["ttyDirectory"]) / "ttyACM0"
        tty.mkdir()
        (tty / "device").symlink_to(usb, target_is_directory=True)
        port = Path(settings["deviceDirectory"]) / "ttyACM0"
        port.touch()
        link = Path(settings["serialDirectory"]) / "pico-5303284720e42a9c"
        link.symlink_to(port)
        result = SimpleNamespace(stdout=json.dumps({"blockdevices": []}).encode())
        config = {**self.config, "discovery": settings}
        with patch.object(sys, "platform", "linux"), patch.object(images.subprocess, "run", return_value=result):
            first = images.discover(config)
            self.assertEqual(len(first), 1)
            self.assertEqual(first[0]["uniqueId"], "5303284720e42a9c")
            self.assertNotIn(str(port), json.dumps(first))
            tty.rename(tty.with_name("ttyACM9"))
            port.rename(port.with_name("ttyACM9"))
            link.unlink()
            link.symlink_to(port.with_name("ttyACM9"))
            second = images.discover(config)
            self.assertEqual(second[0]["id"], first[0]["id"])
            (usb / "idVendor").write_text("ffff")
            self.assertEqual(images.discover(config), [])

    def test_disabled_i2c_starts_no_collector(self):
        source = HERE.parent / "jomaa-home-hub/devices/pico-health/main.py"
        namespace = runpy.run_path(str(source))
        config = {"runtime": {}}
        content = {"device_config.json": json.dumps(config), "stream.json": "{}"}
        def fake_open(name, *args, **kwargs):
            return io.StringIO(content[name])
        function = namespace["run"]
        collector = Mock()
        report = Mock()
        with patch("builtins.open", fake_open), patch.dict(sys.modules, {"stream": SimpleNamespace(I2CCapture=collector)}), \
                patch.dict(function.__globals__, {"tls_context": lambda c: None, "report_loop": report}):
            function(capture_enabled=False)
        collector.assert_not_called()
        self.assertIsNone(report.call_args.args[2])

    def test_unselected_temperature_does_not_access_adc(self):
        machine = SimpleNamespace(ADC=Mock(), unique_id=lambda: b"12345678")
        clock = SimpleNamespace(ticks_ms=lambda: 0, ticks_diff=lambda a, b: a-b, ticks_add=lambda a, b: a+b)
        data = {"image.json": {"installId": "test", "features": ["wifi"]}, "image_settings.json": self.config["telemetry"]}
        def fake_open(name, *args, **kwargs): return io.StringIO(json.dumps(data[name]))
        with patch.dict(sys.modules, {"machine": machine, "time": clock}), patch("builtins.open", fake_open), contextlib.redirect_stdout(io.StringIO()):
            status = runpy.run_path(str(HERE / "firmware/image_status.py"))
            status["tick"]()
        machine.ADC.assert_not_called()

    def verify(self, features, statuses, client=None, baseline=None):
        config = {**self.config, "verificationSeconds": 1, "pollMilliseconds": 1}
        host = images.Host(config)
        host.client = client
        image = {"installId": "installed", "features": features}
        uid = "5303284720e42a9c"
        lines = [images.MARKER + json.dumps({"installId": "installed", "uniqueId": uid,
                 "bootId": "abcdef0123456789", "features": features, **status}).encode() + b"\n" for status in statuses]
        stream = SimpleNamespace(in_waiting=1, read=lambda n: lines.pop(0) if lines else b"")
        serial = MagicMock()
        serial.return_value.__enter__.return_value = stream
        now = [0]
        def ticks(): now[0] += .01; return now[0]
        events = []
        request = {"features": features}
        if "wifi" in features:
            request["wifi"] = {"ssid": "fixture", "password": "private", "transport": "esp8285"}
        with patch.dict(sys.modules, {"serial": SimpleNamespace(Serial=serial)}), patch.object(images.time, "monotonic", ticks):
            host.verify("fixture-port", uid, image, request, baseline, events.append)
        return events

    def test_verification_observes_all_functions_from_installed_boot(self):
        features = ["health", "wifi", "temperature", "i2c"]
        boot = "abcdef0123456789"
        reports = [{"id": i, "heartbeat": {"bootId": boot, "sequence": i, "ip": "192.0.2.1", "freeHeapBytes": 1234}} for i in range(1,4)]
        capture = {"bootId": boot, "bus": 0, "sequence": 4, "data": "000102", "dropped": 0}
        client = SimpleNamespace(request=lambda path: {"logs": [capture] if path.endswith("/i2c") else reports}
                    if path.endswith(("/i2c", "/logs")) else {"device": {"status": "online", "latest": {"bootId": boot}}})
        events = self.verify(features, [{"ip": "192.0.2.1", "celsius": 23.5}], client, {"id": "pico-test", "health": 0, "captures": {}})
        passed = {e["check"]["feature"]: e["check"]["evidence"] for e in events if e["check"]["status"] == "passed"}
        self.assertEqual(set(passed), set(features))
        self.assertEqual(passed["health"]["reports"], 3)
        self.assertEqual(passed["i2c"]["bytes"], 3)

    def test_old_reports_and_duplicate_sequences_never_pass(self):
        boot = "abcdef0123456789"
        reports = [{"id": i, "heartbeat": {"bootId": boot, "sequence": 1, "ip": "192.0.2.1", "freeHeapBytes": 1234}} for i in range(1,5)]
        client = SimpleNamespace(request=lambda path: {"logs": reports})
        for baseline in (0, 100):
            with self.subTest(baseline=baseline), self.assertRaises(images.ImageError):
                self.verify(["health", "wifi"], [{"ip": "192.0.2.1"}], client, {"id": "pico-test", "health": baseline, "captures": {}})

    def test_missing_or_mismatched_startup_is_a_failure(self):
        for statuses in ([], [{"installId": "old", "celsius": 20}], [{"uniqueId": "wrong", "celsius": 20}], [{"celsius": float("nan")}]):
            with self.subTest(statuses=statuses), self.assertRaises(images.ImageError):
                self.verify(["temperature"], statuses)

    def test_empty_capture_reports_no_sensor_data(self):
        capture = {"bootId": "abcdef0123456789", "bus": 0, "sequence": 1, "data": "", "dropped": 0}
        client = SimpleNamespace(request=lambda path: {"logs": [capture]})
        events = self.verify(["i2c"], [{}], client, {"id": "pico-test", "health": 0, "captures": {}})
        result = next(e["check"] for e in events if e["check"]["status"] == "passed")
        self.assertEqual(result["evidence"]["bytes"], 0)
        self.assertIn("no responding", result["message"])

    def test_capture_errors_do_not_pass_logging_verification(self):
        capture = {"bootId": "abcdef0123456789", "bus": 0, "sequence": 1, "data": "0001", "dropped": 1}
        client = SimpleNamespace(request=lambda path: {"logs": [capture]})
        with self.assertRaises(images.ImageError):
            self.verify(["i2c"], [{}], client, {"id": "pico-test", "health": 0, "captures": {}})

    def test_wrong_returning_uid_preserves_the_returning_filesystem(self):
        host = images.Host(self.config)
        uid = "5303284720e42a9c"
        wrong = "530328472857581c"
        host.bootstrap = Mock()
        host.wifi = Mock()
        host.wifi.ports.return_value = {uid: "fixture-port"}
        host.wifi.returning_port.return_value = (wrong, "wrong-port")
        host.inspect = Mock(side_effect=[{"uniqueId": uid, "config": {}}, {"uniqueId": wrong, "config": {}}])
        host.mount = Mock(return_value=self.path)
        host.usb = Mock()
        bootsel = {"id": "bootsel-fixture", "mode": "bootsel", "device": "fixture-disk", "mount": str(self.path)}
        target = {"id": "runtime-fixture", "uniqueId": uid, "port": "fixture-port", "mode": "runtime"}
        with patch.object(images, "discover", side_effect=[[target], [bootsel]]), self.assertRaises(images.ImageError):
            host.reimage(target,
                         {"features": ["temperature"]}, self.path, lambda value: None)
        host.usb.assert_not_called()
        host.inspect.assert_called_once_with("fixture-port")

    def test_disconnected_target_has_no_usb_operations(self):
        host = Mock()
        with patch.object(images, "ROOT", self.path), patch.object(images, "discover", return_value=[]), self.assertRaises(images.ImageError):
            images.execute("gone", {"features": ["temperature"]}, self.config, lambda value: None, host)
        host.reimage.assert_not_called()

    def test_offline_device_does_not_pass_from_earlier_reports(self):
        boot = "abcdef0123456789"
        reports = [{"id": i, "heartbeat": {"bootId": boot, "sequence": i, "ip": "192.0.2.1", "freeHeapBytes": 1234}} for i in range(1,4)]
        client = SimpleNamespace(request=lambda path: {"logs": reports} if path.endswith("/logs") else
                                 {"device": {"status": "offline", "latest": {"bootId": boot}}})
        with self.assertRaises(images.ImageError):
            self.verify(["health", "wifi"], [{"ip": "192.0.2.1"}], client, {"id": "pico-test", "health": 0, "captures": {}})

    def test_wifi_image_applies_settings_and_reconnects(self):
        connected = [True]
        calls = []
        def connect(*args):
            calls.append(args)
            connected[0] = True
        wifi = SimpleNamespace(active=lambda value: None, disconnect=lambda: None,
                               connect=connect, isconnected=lambda: connected[0], ifconfig=lambda: ("192.0.2.1",))
        ticks = [0]
        def sleep(value):
            ticks[0] += 1000
            connected[0] = False
            if len(calls) >= 2:
                raise StopIteration()
        clock = SimpleNamespace(ticks_ms=lambda: ticks[0], ticks_diff=lambda a,b: a-b,
                                ticks_add=lambda a,b: a+b, sleep_ms=sleep)
        status = SimpleNamespace(image={"features": ["wifi"]}, settings=self.config["telemetry"], tick=lambda ip: None)
        config = {"wifi_transport": "native", "wifi_ssid": "requested-network", "wifi_password": "private",
                  "runtime": {"joinTimeoutMilliseconds": 10000, "joinPollMilliseconds": 1}}
        with patch.dict(sys.modules, {"image_status": status, "time": clock, "network": SimpleNamespace(WLAN=lambda value: wifi, STA_IF=0)}), \
                patch("builtins.open", return_value=io.StringIO(json.dumps(config))):
            namespace = runpy.run_path(str(HERE / "firmware/main.py"))
            with self.assertRaises(StopIteration):
                namespace["run"]()
        self.assertEqual(calls, [("requested-network", "private"), ("requested-network", "private")])

    def test_existing_custom_identity_and_name_are_preserved(self):
        host = images.Host(self.config)
        host.origin = "https://example.test"
        requests = []
        device = {"id": "named-pico", "name": "Family Pico", "status": "online"}
        def request(path, body=None, method=None):
            requests.append((path, body))
            return {"devices": [device]} if path == "/api/devices" else {"device": device}
        host.client = SimpleNamespace(request=request)
        installed = {"id": "named-pico", "hub_host": "example.test", "hub_port": 443, "token": "a" * 64}
        result = host.credential("5303284720e42a9c", installed)
        self.assertEqual(result["id"], "named-pico")
        self.assertEqual(requests[-1][1]["name"], "Family Pico")
        self.assertFalse(any(path.endswith("/enroll") for path,body in requests))


if __name__ == "__main__":
    unittest.main()

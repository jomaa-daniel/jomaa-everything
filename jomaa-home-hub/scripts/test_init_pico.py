from __future__ import annotations

import contextlib
import importlib.util
import io
import json
from pathlib import Path
import ssl
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import init_pico

spec = importlib.util.spec_from_file_location("pico_firmware", init_pico.FIRMWARE)
firmware = importlib.util.module_from_spec(spec)
spec.loader.exec_module(firmware)


class ProvisioningTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temp.name)
        cls.cert = cls.root / "ca.pem"
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
                        "-subj", "/CN=Test CA", "-keyout", str(cls.root / "key.pem"), "-out", str(cls.cert)],
                       check=True, capture_output=True)
        cls.credentials = cls.root / "credential.json"
        cls.credentials.write_text(json.dumps({"id": "pico-test", "token": "a" * 64}))
        cls.credentials.chmod(0o600)
        cls.wifi = cls.root / "wifi-password"
        cls.wifi.write_text("test-password\n")
        cls.wifi.chmod(0o600)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def args(self, output):
        return ["--id", "pico-test", "--name", "Test Pico", "--ssid", "Test Wi-Fi",
                "--wifi-password-file", str(self.wifi), "--credential-file", str(self.credentials),
                "--ca-cert", str(self.cert), "--output", str(output)]

    def test_prepare_writes_private_files_without_usb_or_network(self):
        output = self.root / "prepared"
        with patch.object(init_pico, "install") as install, patch.object(init_pico, "request") as request, \
                patch.object(init_pico.subprocess, "run") as run, contextlib.redirect_stdout(io.StringIO()) as printed:
            self.assertEqual(init_pico.main(self.args(output)), 0)
        install.assert_not_called()
        request.assert_not_called()
        run.assert_not_called()
        config = json.loads((output / "device_config.json").read_text())
        self.assertEqual(config["hub_host"], "hub.jomaa.org")
        self.assertEqual(config["wifi_password"], "test-password")
        self.assertEqual(output.stat().st_mode & 0o777, 0o700)
        for name in ("main.py", "device_config.json", "health_ca.der"):
            self.assertEqual((output / name).stat().st_mode & 0o777, 0o600)
        self.assertNotIn("a" * 64, printed.getvalue())
        self.assertNotIn("test-password", printed.getvalue())
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(init_pico.main(self.args(output)), 1)

    def test_install_requires_explicit_port_and_flag(self):
        for extra in (["--install"], ["--port", "/dev/ttyACM0"]):
            with patch.object(init_pico, "install") as install, contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(init_pico.main(self.args(self.root / "invalid-install") + extra), 1)
                install.assert_not_called()
        output = self.root / "explicit-install"
        with patch.object(init_pico.importlib.util, "find_spec", return_value=object()), \
                patch.object(init_pico, "install") as install, contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(init_pico.main(self.args(output) + ["--install", "--port", "/dev/test-port"]), 0)
        install.assert_called_once_with("/dev/test-port", output)

    def test_prepare_esp8285_includes_transport_and_private_module(self):
        output = self.root / "prepared-esp8285"
        with patch.object(init_pico, "install") as install, contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(init_pico.main(self.args(output) + ["--wifi-transport", "esp8285"]), 0)
        install.assert_not_called()
        self.assertEqual(json.loads((output / "device_config.json").read_text())["wifi_transport"], "esp8285")
        self.assertEqual((output / "esp8285.py").stat().st_mode & 0o777, 0o600)

    def test_install_passes_the_isolated_tools_environment_to_all_usb_operations(self):
        output = self.root / "usb-environment"
        output.mkdir()
        (output / "device_config.json").write_text(json.dumps({"wifi_transport": "esp8285"}))
        env = {"PYTHONPATH": "/private/usb-tools"}
        with patch.object(init_pico.subprocess, "run") as run:
            run.return_value.returncode = 0
            init_pico.install("/dev/selected", output, env=env)
        self.assertTrue(run.call_args_list)
        self.assertTrue(all(call.kwargs["env"] == env for call in run.call_args_list))

    def test_insecure_origins_and_redirects_are_refused(self):
        for url in ("http://hub.jomaa.org", "https://user:password@hub.jomaa.org", "https://hub.jomaa.org/api",
                    "https://hub.jomaa.org?query", "https://hub.jomaa.org#fragment", "https://[::1]"):
            with self.assertRaises(ValueError):
                init_pico.hub_origin(url)
        self.assertIsNone(init_pico.NoRedirect().redirect_request(None, None, 302, "", {}, "https://elsewhere"))

    def test_credential_permissions_and_bad_ca_fail_before_usb(self):
        bad = self.root / "bad-ca.pem"
        bad.write_text("not a certificate")
        with self.assertRaises((ValueError, ssl.SSLError)):
            init_pico.certificate(bad)
        with self.assertRaises(FileExistsError):
            init_pico.private_write(self.credentials, b"overwrite")
        self.assertEqual(json.loads(self.credentials.read_text())["token"], "a" * 64)


class FirmwareProtocolTests(unittest.TestCase):
    def stream(self, response):
        class Stream(io.BytesIO):
            def write(self, data):
                self.sent += data[:7]
                return min(7, len(data))
        stream = Stream(response)
        stream.sent = b""
        return stream

    def send(self, stream, wrap_error=None):
        config = {"hub_host": "hub.example", "hub_port": 443, "id": "pico-test", "token": "a" * 64}
        with patch.object(firmware.socket, "socket") as raw, patch.object(firmware.socket, "getaddrinfo", return_value=[(0, 0, 0, "", ("127.0.0.1", 443))]):
            tls = unittest.mock.Mock()
            if wrap_error:
                tls.wrap_socket.side_effect = wrap_error
            else:
                tls.wrap_socket.return_value = stream
            result = firmware.post_health(config, tls, {"test": "payload"})
            tls.wrap_socket.assert_called_once_with(raw.return_value, server_hostname="hub.example")
            return result

    def test_chunked_and_content_length_responses(self):
        body = b'{"ok":true,"nextIntervalSeconds":60}'
        for response in (b"HTTP/1.1 201 Created\r\nContent-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body,
                         b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n" + ("%x" % len(body)).encode() + b"\r\n" + body + b"\r\n0\r\n\r\n"):
            stream = self.stream(response)
            self.assertEqual(self.send(stream)["nextIntervalSeconds"], 60)
            self.assertIn(b"POST /api/devices/pico-test/health", stream.sent)

    def test_cert_failure_never_sends_credential_and_http_errors_are_retried(self):
        stream = self.stream(b"")
        with self.assertRaises(ssl.SSLCertVerificationError):
            self.send(stream, ssl.SSLCertVerificationError("untrusted certificate"))
        self.assertEqual(stream.sent, b"")
        for response in (b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 2\r\n\r\n{}",
                         b"HTTP/1.1 302 Found\r\nContent-Length: 2\r\n\r\n{}",
                         b"HTTP/1.1 200 OK\r\nContent-Length: 10000\r\n\r\n"):
            with self.assertRaises(OSError):
                self.send(self.stream(response))

    def test_esp_transport_still_verifies_hostname_and_closes_on_bad_certificate(self):
        config = {"hub_host": "hub.example", "hub_port": 443, "id": "pico-test", "token": "a" * 64}
        radio = unittest.mock.Mock()
        tls = unittest.mock.Mock()
        tls.wrap_socket.side_effect = ssl.SSLCertVerificationError("untrusted certificate")
        with patch.object(firmware.socket, "socket") as socket, self.assertRaises(ssl.SSLCertVerificationError):
            firmware.post_health(config, tls, {"test": "payload"}, radio)
        socket.assert_not_called()
        tls.wrap_socket.assert_called_once_with(radio.open_tcp.return_value, server_hostname="hub.example")
        radio.open_tcp.return_value.write.assert_not_called()
        radio.open_tcp.return_value.close.assert_called_once()

    def test_uart_stream_waits_for_data_and_times_out_without_data(self):
        machine = unittest.mock.Mock()
        spec = importlib.util.spec_from_file_location("pico_esp_transport", init_pico.ESP_FIRMWARE)
        transport = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"machine": machine}):
            spec.loader.exec_module(transport)
        radio = unittest.mock.Mock()
        radio.uart.readinto.side_effect = [None, 3]
        with patch.object(transport.time, "ticks_add", side_effect=lambda a, b: a+b, create=True), \
                patch.object(transport.time, "ticks_diff", side_effect=lambda a, b: a-b, create=True), \
                patch.object(transport.time, "ticks_ms", return_value=0, create=True), \
                patch.object(transport.time, "sleep_ms", create=True) as sleep:
            stream = transport.TCPStream(radio)
            self.assertEqual(stream.readinto(bytearray(3)), 3)
            sleep.assert_called_once_with(1)
            with patch.object(transport.time, "ticks_ms", return_value=30001):
                with self.assertRaises(OSError) as error:
                    stream.readinto(bytearray(3))
                self.assertEqual(error.exception.args[0], 110)
            stream.close()
        radio.close_tcp.assert_called_once()


if __name__ == "__main__":
    unittest.main()

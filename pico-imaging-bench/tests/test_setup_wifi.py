from __future__ import annotations

import contextlib
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import setup_wifi
from test_bench import uf2


class WifiSetupTests(unittest.TestCase):
    def test_firmware_verification_rejects_bad_digest_and_block(self):
        data = uf2()
        with patch.object(setup_wifi, "FIRMWARE_SHA256", hashlib.sha256(data).hexdigest()):
            setup_wifi.validate_firmware(data)
            with self.assertRaises(setup_wifi.SetupError):
                setup_wifi.validate_firmware(data + b"bad")
        invalid = b"\0" * 512
        with patch.object(setup_wifi, "FIRMWARE_SHA256", hashlib.sha256(invalid).hexdigest()):
            with self.assertRaises(setup_wifi.SetupError):
                setup_wifi.validate_firmware(invalid)

    def test_wrong_board_never_erases_filesystem(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(setup_wifi, "usb_json", return_value={"uid": "existing"}), \
                patch.object(setup_wifi, "usb") as write, \
                self.assertRaises(setup_wifi.SetupError):
            setup_wifi.provision({}, "/dev/test", "existing", None, {}, Path(directory))
        write.assert_not_called()

    def test_returning_wrong_target_never_erases_filesystem(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(setup_wifi, "usb_json", return_value={"uid": "other"}), \
                patch.object(setup_wifi, "usb") as write, \
                self.assertRaises(setup_wifi.SetupError):
            setup_wifi.provision({}, "/dev/test", "source", "target", {}, Path(directory))
        write.assert_not_called()

    def test_provision_formats_and_installs_only_wifi_files(self):
        config = {"wifi_ssid": "network", "wifi_password": "secret", "transport": "esp8285"}
        calls = []
        def capture(env, port, *args):
            calls.append(args)
            if args[:3] == ("resume", "fs", "cp") and args[-1] == ":wifi_config.json":
                self.assertEqual(json.loads(Path(args[-2]).read_text()), config)
                self.assertEqual(Path(args[-2]).stat().st_mode & 0o777, 0o600)
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(setup_wifi, "usb_json", return_value={"uid": "new"}), \
                patch.object(setup_wifi, "usb", side_effect=capture):
            self.assertEqual(setup_wifi.provision({}, "/dev/test", "existing", "new", config, Path(directory)), "new")
        self.assertIn("progsize=256", calls[0][-1])
        self.assertEqual([call[-1] for call in calls[1:]], [":wifi_config.json", ":main.py"])

    def test_missing_serial_access_precedes_wifi_read_and_hardware_writes(self):
        with patch.object(setup_wifi.sys, "platform", "linux"), \
                patch.object(setup_wifi.os, "geteuid", return_value=1000), \
                patch.object(setup_wifi, "install_tools", return_value={}), \
                patch.object(setup_wifi, "ports", return_value={"target": "/dev/target"}), \
                patch.object(setup_wifi, "require_serial_access", side_effect=setup_wifi.SetupError("serial access denied")), \
                patch.object(setup_wifi, "get_wifi") as read, \
                patch.object(setup_wifi, "provision") as provision, \
                contextlib.redirect_stdout(io.StringIO()), \
                contextlib.redirect_stderr(io.StringIO()) as stderr:
            self.assertEqual(setup_wifi.main(["--configure-port", "/dev/target"]), 1)
        self.assertIn("serial access denied", stderr.getvalue())
        read.assert_not_called()
        provision.assert_not_called()

    def test_usb_permission_failure_never_opens_device(self):
        with tempfile.TemporaryDirectory() as directory:
            port = Path(directory) / "serial"
            port.touch()
            with patch.object(setup_wifi.os, "access", return_value=False), \
                    patch.object(setup_wifi.subprocess, "run") as execute, self.assertRaises(setup_wifi.SetupError):
                setup_wifi.usb({}, str(port), "reset")
            execute.assert_not_called()

    def test_mounted_bootsel_works_as_nonroot_and_refuses_missing_write_access(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(setup_wifi.os, "geteuid", return_value=1000):
            volume = Path(directory)
            self.assertEqual(setup_wifi.mount_bootsel("/dev/bootsel", directory, volume), (volume, False))
            with patch.object(setup_wifi.os, "access", return_value=False), self.assertRaises(setup_wifi.SetupError):
                setup_wifi.mount_bootsel("/dev/bootsel", directory, volume)

    def test_nonroot_mount_uses_udisks_and_reports_actual_mount_failure(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(setup_wifi.sys, "platform", "linux"), \
                patch.object(setup_wifi.os, "geteuid", return_value=1000), \
                patch.object(setup_wifi.sys.stdin, "isatty", return_value=False), \
                patch.object(setup_wifi, "command") as execute, \
                patch.object(setup_wifi, "linux_volumes", return_value=[("/dev/bootsel", directory)]):
            self.assertEqual(setup_wifi.mount_bootsel("/dev/bootsel", None, Path(directory)), (Path(directory), True))
            execute.assert_called_once_with(["udisksctl", "mount", "--block-device", "/dev/bootsel", "--no-user-interaction"], timeout=15)
            execute.side_effect = OSError("mount unavailable")
            with self.assertRaisesRegex(setup_wifi.SetupError, "cannot mount BOOTSEL device"):
                setup_wifi.mount_bootsel("/dev/bootsel", None, Path(directory))

    def test_interactive_mount_authentication_is_limited_to_selected_volume(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(setup_wifi.sys, "platform", "linux"), \
                patch.object(setup_wifi.os, "geteuid", return_value=1000), \
                patch.object(setup_wifi.os, "getuid", return_value=1000), \
                patch.object(setup_wifi.os, "getgid", return_value=1000), \
                patch.object(setup_wifi.sys.stdin, "isatty", return_value=True), \
                patch.object(setup_wifi, "command", side_effect=OSError("mount denied")), \
                patch.object(setup_wifi.subprocess, "run") as execute, \
                contextlib.redirect_stdout(io.StringIO()):
            volume = Path(directory) / "bootsel"
            self.assertEqual(setup_wifi.mount_bootsel("/dev/selected", None, Path(directory)), (volume, True))
            execute.assert_called_once_with(["sudo", "mount", "-t", "vfat", "-o", "uid=1000,gid=1000",
                                             "/dev/selected", str(volume)], check=True, timeout=120)

    def test_configure_runs_as_nonroot_and_uses_installed_firmware(self):
        config = {"wifi_ssid": "network", "wifi_password": "secret", "transport": "esp8285"}
        with patch.object(setup_wifi.sys, "platform", "linux"), \
                patch.object(setup_wifi.os, "geteuid", return_value=1000), \
                patch.object(setup_wifi, "install_tools", return_value={}), \
                patch.object(setup_wifi, "download") as download, \
                patch.object(setup_wifi, "ports", return_value={"target": "/dev/target", "source": "/dev/source"}), \
                patch.object(setup_wifi, "require_serial_access"), \
                patch.object(setup_wifi, "target_identity", return_value="target"), \
                patch.object(setup_wifi, "get_wifi", return_value=(config, "source")) as copy, \
                patch.object(setup_wifi, "enter_bootsel") as boot, \
                patch.object(setup_wifi, "mount_bootsel") as mount, \
                patch.object(setup_wifi, "flash") as flash, \
                patch.object(setup_wifi, "provision", return_value="target") as provision, \
                patch.object(setup_wifi, "reset"), \
                patch.object(setup_wifi, "wait_for_wifi", return_value="192.0.2.10"), \
                contextlib.redirect_stdout(io.StringIO()) as stdout:
            self.assertEqual(setup_wifi.main(["--configure-port", "/dev/target"]), 0)
        copy.assert_called_once_with({}, {"source": "/dev/source"}, "esp8285")
        self.assertEqual(provision.call_args.args[:5], ({}, "/dev/target", "source", "target", config))
        for unused in (download, boot, mount, flash):
            unused.assert_not_called()
        self.assertNotIn("secret", stdout.getvalue())

    def test_target_must_be_a_connected_pico_with_matching_identity(self):
        existing = {"target": "/dev/target", "source": "/dev/source"}
        with patch.object(setup_wifi, "usb_json", return_value={"uid": "target"}):
            self.assertEqual(setup_wifi.target_identity({}, "/dev/target", existing), "target")
        with patch.object(setup_wifi, "usb_json", return_value={"uid": "other"}), \
                self.assertRaises(setup_wifi.SetupError):
            setup_wifi.target_identity({}, "/dev/target", existing)
        with patch.object(setup_wifi, "usb_json") as read, self.assertRaises(setup_wifi.SetupError):
            setup_wifi.target_identity({}, "/dev/unconnected", existing)
        read.assert_not_called()

    def test_reimage_excludes_target_when_copying_source_wifi(self):
        config = {"wifi_ssid": "network", "wifi_password": "secret", "transport": "esp8285"}
        with patch.object(setup_wifi.sys, "platform", "linux"), \
                patch.object(setup_wifi.os, "geteuid", return_value=0), \
                patch.object(setup_wifi, "bootsel_volumes", return_value=[]), \
                patch.object(setup_wifi, "install_tools", return_value={}), \
                patch.object(setup_wifi, "download", return_value=b"firmware"), \
                patch.object(setup_wifi, "validate_firmware"), \
                patch.object(setup_wifi, "ports", return_value={"target": "/dev/target", "source": "/dev/source"}), \
                patch.object(setup_wifi, "require_serial_access"), \
                patch.object(setup_wifi, "target_identity", return_value="target"), \
                patch.object(setup_wifi, "get_wifi", return_value=(config, "source")) as copy, \
                patch.object(setup_wifi, "enter_bootsel", return_value=("/dev/bootsel", None)) as boot, \
                patch.object(setup_wifi, "mount_bootsel", return_value=(Path("/volume"), False)), \
                patch.object(setup_wifi, "flash"), \
                patch.object(setup_wifi, "returning_port", return_value=("target", "/dev/target")) as returning, \
                patch.object(setup_wifi, "provision", return_value="target") as provision, \
                patch.object(setup_wifi, "reset"), \
                patch.object(setup_wifi, "wait_for_wifi", return_value="192.0.2.10"), \
                contextlib.redirect_stdout(io.StringIO()) as stdout:
            self.assertEqual(setup_wifi.main(["--target-port", "/dev/target"]), 0)
        copy.assert_called_once_with({}, {"source": "/dev/source"}, "esp8285")
        returning.assert_called_once_with({"source": "/dev/source"})
        boot.assert_called_once_with("/dev/target")
        self.assertEqual(provision.call_args.args[:5], ({}, "/dev/target", "source", "target", config))
        self.assertNotIn("secret", stdout.getvalue())

    def test_enter_bootsel_preserves_other_boards_and_waits_for_target(self):
        from unittest.mock import Mock
        connection = Mock()
        factory = Mock(return_value=connection)
        transport = SimpleNamespace(SerialTransport=factory)
        with patch.dict(sys.modules, {"mpremote.transport_serial": transport}), \
                patch.object(setup_wifi, "bootsel_volumes", return_value=[("/dev/other", None)]), \
                self.assertRaises(setup_wifi.SetupError):
            setup_wifi.enter_bootsel("/dev/target")
        factory.assert_not_called()
        with patch.dict(sys.modules, {"mpremote.transport_serial": transport}), \
                patch.object(setup_wifi, "bootsel_volumes", side_effect=[[], [], [("/dev/bootsel", None)]]), \
                patch.object(setup_wifi.time, "sleep"):
            self.assertEqual(setup_wifi.enter_bootsel("/dev/target"), ("/dev/bootsel", None))
        factory.assert_called_once_with("/dev/target")
        connection.enter_raw_repl.assert_called_once_with(soft_reset=False)
        connection.exec_raw_no_follow.assert_called_once_with("import machine; machine.bootloader()")
        connection.close.assert_called_once()
        connection.close.side_effect = OSError("device disconnected")
        with patch.dict(sys.modules, {"mpremote.transport_serial": transport}), \
                patch.object(setup_wifi, "bootsel_volumes", side_effect=[[], [("/dev/bootsel", None)]]):
            self.assertEqual(setup_wifi.enter_bootsel("/dev/target"), ("/dev/bootsel", None))
        connection.serial.close.assert_called_once()

    def test_existing_wifi_is_read_and_source_is_restarted(self):
        source = {"ssid": "network", "password": "secret", "uid": "board-a", "token": "private"}
        with patch.object(setup_wifi, "usb_json", return_value=source), \
                patch.object(setup_wifi, "reset") as reset, contextlib.redirect_stdout(io.StringIO()):
            config, source_uid = setup_wifi.get_wifi({}, {"board-a": "/dev/source"}, "esp8285")
        self.assertEqual(source_uid, "board-a")
        self.assertEqual(set(config), {"wifi_ssid", "wifi_password", "transport"})
        reset.assert_called_once_with({}, "/dev/source")

    def test_failed_source_read_still_restarts(self):
        with patch.object(setup_wifi, "usb_json", side_effect=setup_wifi.SetupError("failed")), \
                patch.object(setup_wifi, "reset") as reset, \
                self.assertRaises(setup_wifi.SetupError):
            setup_wifi.get_wifi({}, {"board-a": "/dev/source"}, "native")
        reset.assert_called_once_with({}, "/dev/source")

    def test_returning_port_ignores_existing_and_rejects_ambiguous(self):
        with patch.object(setup_wifi, "ports", return_value={"old": "/dev/old", "new": "/dev/new"}):
            self.assertEqual(setup_wifi.returning_port({"old": "/dev/old"}), ("new", "/dev/new"))
        with patch.object(setup_wifi, "ports", return_value={"new": "/dev/new", "other": "/dev/other"}), \
                self.assertRaises(setup_wifi.SetupError):
            setup_wifi.returning_port({})

    def test_boot_connects_native_wifi_without_printing_settings(self):
        config = {"wifi_ssid": "network", "wifi_password": "secret", "transport": "native"}
        wifi = SimpleNamespace(active=lambda value: None, connect=lambda ssid, password: None,
                               isconnected=lambda: True, ifconfig=lambda: ("192.0.2.10",))
        network = SimpleNamespace(STA_IF=0, WLAN=lambda interface: wifi)
        micropython_time = SimpleNamespace(ticks_ms=lambda: 0, ticks_diff=lambda a, b: a - b)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "wifi_config.json"
            path.write_text(json.dumps(config))
            stdout = io.StringIO()
            with patch("builtins.open", side_effect=lambda name: path.open()), \
                    patch.dict(sys.modules, {"network": network, "time": micropython_time}), contextlib.redirect_stdout(stdout):
                exec(compile(setup_wifi.BOOT, "main.py", "exec"), {})
        self.assertEqual(stdout.getvalue(), "JOMAA_WIFI_READY:192.0.2.10\n")

    def test_boot_connects_esp8285_with_escaped_credentials(self):
        config = {"wifi_ssid": 'net"work', "wifi_password": "pass\\word", "transport": "esp8285"}
        class Radio:
            def __init__(self, *args, **kwargs):
                self.pending = b""
                self.commands = []
            def any(self):
                return len(self.pending)
            def read(self):
                result, self.pending = self.pending, b""
                return result
            def write(self, value):
                if isinstance(value, str):
                    self.commands.append(value)
                    self.pending = (b'+CIFSR:STAIP,"192.0.2.10"\r\n\r\nOK\r\n'
                                    if value.startswith("AT+CIFSR") else b"\r\nOK\r\n")
        radio = Radio()
        machine = SimpleNamespace(UART=lambda *args, **kwargs: radio)
        micropython_time = SimpleNamespace(ticks_ms=lambda: 0, ticks_diff=lambda a, b: a - b,
                                           sleep_ms=lambda value: None, sleep=lambda value: None)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "wifi_config.json"
            path.write_text(json.dumps(config))
            stdout = io.StringIO()
            with patch("builtins.open", side_effect=lambda name: path.open()), \
                    patch.dict(sys.modules, {"machine": machine, "time": micropython_time}), \
                    contextlib.redirect_stdout(stdout):
                exec(compile(setup_wifi.BOOT, "main.py", "exec"), {})
        self.assertEqual(stdout.getvalue(), "JOMAA_WIFI_READY:192.0.2.10\n")
        self.assertIn('AT+CWJAP_CUR="net\\"work","pass\\\\word"\r\n', radio.commands)

    def test_wifi_check_waits_for_new_ready_marker(self):
        class Connection:
            def __enter__(self):
                self.chunks = iter([b"startup output\r\nJOMAA_WIFI_RE", b"ADY:192.0.2.10\r\n"])
                return self
            def __exit__(self, *args):
                pass
            def read(self, size):
                return next(self.chunks)
        serial = SimpleNamespace(Serial=lambda *args, **kwargs: Connection(), SerialException=OSError)
        with patch.dict(sys.modules, {"serial": serial}), \
                patch.object(setup_wifi, "ports", return_value={"uid": "/dev/test"}):
            self.assertEqual(setup_wifi.wait_for_wifi("uid", 10), "192.0.2.10")


if __name__ == "__main__":
    unittest.main()

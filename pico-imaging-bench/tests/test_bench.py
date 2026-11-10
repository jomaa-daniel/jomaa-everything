from __future__ import annotations

import contextlib
import hashlib
import io
import json
from pathlib import Path
import struct
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import common
import flash_pico
import image_and_test


def uf2(family=flash_pico.FAMILIES["rp2040"]):
    block = bytearray(512)
    struct.pack_into("<8I", block, 0, 0x0A324655, 0x9E5D5157, 0x2000,
                     0x10000000, 256, 0, 1, family)
    block[32:288] = bytes(range(256))
    struct.pack_into("<I", block, 508, 0x0AB16F30)
    return bytes(block)


class FlashTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "image.uf2"
        self.source.write_bytes(uf2())
        self.digest = hashlib.sha256(self.source.read_bytes()).hexdigest()
        self.volume = self.root / "RPI-RP2"
        self.volume.mkdir()
        (self.volume / "INFO_UF2.TXT").write_text("UF2 Bootloader\nModel: Raspberry Pi RP2\nBoard-ID: RPI-RP2\n")

    def test_plan_preserves_volume_and_execute_copies_verified_bytes(self):
        args = ["--uf2", str(self.source), "--sha256", self.digest,
                "--bootsel-volume", str(self.volume)]
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(flash_pico.main(args), 0)
            self.assertFalse((self.volume / "firmware.uf2").exists())
            self.assertEqual(flash_pico.main(args + ["--execute"]), 0)
        self.assertEqual((self.volume / "firmware.uf2").read_bytes(), self.source.read_bytes())

    def test_wrong_digest_chip_and_non_bootsel_path_never_write(self):
        cases = [(self.digest.replace(self.digest[0], "f" if self.digest[0] != "f" else "e", 1), self.volume, "rp2040"),
                 (self.digest, self.volume, "rp2350"), (self.digest, self.root, "rp2040")]
        for digest, volume, chip in cases:
            with self.assertRaises(common.BenchError):
                flash_pico.flash(self.source, digest, volume, chip)
        self.assertFalse((self.volume / "firmware.uf2").exists())

    def test_malformed_uf2_is_rejected_even_with_matching_digest(self):
        data = bytearray(uf2())
        struct.pack_into("<I", data, 20, 1)  # Out-of-range block number.
        self.source.write_bytes(data)
        digest = hashlib.sha256(data).hexdigest()
        with self.assertRaises(common.BenchError):
            flash_pico.validate_uf2(self.source, digest, "rp2040")

    def test_wrong_device_identity_prevents_filesystem_erasure(self):
        with patch.object(image_and_test, "usb_json", return_value={"uniqueId": "other"}), \
                patch.object(image_and_test, "usb_command") as write:
            with self.assertRaises(common.BenchError):
                image_and_test.fresh_filesystem("/dev/selected", "expected", "esp8285")
        write.assert_not_called()

    def test_fresh_filesystem_erases_files_and_remounts_with_rp2_program_alignment(self):
        files = {"main.py": "previous startup", "wifi_config.py": "previous settings"}
        class Lfs:
            def __init__(self, device, progsize):
                if progsize != 256:
                    raise OSError("RP2 requires aligned programming")
            @staticmethod
            def mkfs(device, progsize):
                if progsize != 256:
                    raise OSError("RP2 requires aligned programming")
                files.clear()
        vfs = SimpleNamespace(VfsLfs2=Lfs, umount=Mock(), mount=Mock())
        rp2 = SimpleNamespace(Flash=Mock())
        def execute(port, command, code):
            exec(code, {})
        with patch.dict(sys.modules, {"vfs": vfs, "rp2": rp2}), \
                patch.object(image_and_test, "usb_json", return_value={"uniqueId": "expected"}), \
                patch.object(image_and_test, "usb_command", side_effect=execute):
            image_and_test.fresh_filesystem("/dev/selected", "expected", "esp8285")
        self.assertEqual(files, {})
        vfs.mount.assert_called_once()

    def test_imaging_a_rotated_device_replaces_its_long_interval_before_install(self):
        run_dir = self.root / "run"
        module = Mock()
        def prepare(arguments):
            directory = Path(arguments[arguments.index("--output") + 1])
            directory.mkdir(mode=0o700)
            common.private_json(directory / "device_config.json", {"interval_seconds": 3600})
            return 0
        module.main.side_effect = prepare
        observed = []
        def install(port, directory):
            observed.append(json.loads((directory / "device_config.json").read_text())["interval_seconds"])
        module.install.side_effect = install
        result = {"deviceId": "pico-test", "status": "online", "reportsAccepted": 3,
                  "latest": {"ip": "192.168.1.240"}}
        args = ["--uf2", str(self.source), "--sha256", self.digest, "--bootsel-volume", str(self.volume),
                "--port", "/dev/selected", "--id", "pico-test", "--name", "Test Pico", "--ssid", "Test Wi-Fi",
                "--ca-cert", str(self.source), "--run-dir", str(run_dir), "--rotate", "--execute"]
        with patch.object(image_and_test, "provisioner", return_value=module), \
                patch.object(image_and_test.importlib.util, "find_spec", return_value=object()), \
                patch.object(image_and_test, "HubClient"), patch.object(image_and_test, "flash"), \
                patch.object(image_and_test, "wait_for_port"), \
                patch.object(image_and_test, "fresh_filesystem", return_value={"uniqueId": "expected"}), \
                patch.object(image_and_test, "verify_reports", return_value=result), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(image_and_test.main(args), 0)
        self.assertEqual(observed, [15])


def entry(id, boot="boot-a", sequence=0):
    return {"id": id, "heartbeat": {"bootId": boot, "sequence": sequence,
                                    "ip": "192.168.1.240", "freeHeapBytes": 120000}}


class ReportTests(unittest.TestCase):
    def client(self, samples, status="online"):
        client = Mock()
        rounds = iter(samples)
        current = []
        baseline = True
        def request(path):
            nonlocal baseline, current
            if "/logs?" in path:
                if baseline:
                    baseline = False
                    return {"logs": [entry(10)]}
                return {"logs": current}
            current = next(rounds)
            latest = current[0]["heartbeat"] if current else None
            return {"status": status, "latest": latest, "lastSeen": 1000}
        client.request.side_effect = request
        return client

    def test_old_and_duplicate_reports_do_not_satisfy_the_test(self):
        client = self.client([[entry(11, sequence=1), entry(11, sequence=1), entry(10)],
                              [entry(12, sequence=2), entry(11, sequence=1)],
                              [entry(13, sequence=3), entry(12, sequence=2), entry(11, sequence=1)]])
        with patch.object(common.time, "sleep") as sleep:
            result = common.verify_reports(client, "pico-test")
        self.assertEqual(result["reportsAccepted"], 3)
        self.assertEqual(sleep.call_count, 2)

    def test_repeated_reboots_cannot_fake_stable_reporting(self):
        client = self.client([[entry(11, "boot-one")], [entry(12, "boot-two")], [entry(13, "boot-three")]])
        clock = [0]
        def advance(seconds):
            clock[0] += seconds
        with patch.object(common.time, "sleep", side_effect=advance), \
                patch.object(common.time, "monotonic", side_effect=lambda: clock[0]), \
                self.assertRaises(common.BenchError):
            common.verify_reports(client, "pico-test", timeout=5)

    def test_timeout_and_revocation_fail_instead_of_accepting_stale_online_state(self):
        client = self.client([[entry(10)]])
        with self.assertRaises(common.BenchError):
            common.verify_reports(client, "pico-test", timeout=0)
        client = self.client([[entry(11)]], status="revoked")
        with self.assertRaises(common.BenchError):
            common.verify_reports(client, "pico-test")

    def test_private_reports_refuse_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "result.json"
            common.private_json(path, {"ok": True})
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(FileExistsError):
                common.private_json(path, {"ok": False})


if __name__ == "__main__":
    unittest.main()

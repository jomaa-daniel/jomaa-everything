from __future__ import annotations

import importlib.util
import json
import unittest
from unittest.mock import Mock

import init_pico

spec = importlib.util.spec_from_file_location("pico_stream", init_pico.STREAM_FIRMWARE)
stream = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stream)


class CaptureTests(unittest.TestCase):
    def settings(self):
        result = json.loads(init_pico.STREAM_SETTINGS.read_text())
        result["maxDataBytes"] = 32
        return result

    def test_stream_doc_covers_every_committed_setting(self):
        doc = init_pico.STREAM_SETTINGS.with_suffix(".md").read_text()
        def keys(value, prefix=""):
            if isinstance(value, dict):
                for key, child in value.items():
                    yield prefix + key
                    yield from keys(child, prefix + key + ".")
            elif isinstance(value, list):
                for child in value:
                    yield from keys(child, prefix[:-1] + "[].")
        for key in keys(json.loads(init_pico.STREAM_SETTINGS.read_text())):
            self.assertIn("`" + key + "`", doc)

    def test_idle_buses_retain_contiguous_windows_without_buffer_growth(self):
        settings = self.settings()
        i2c = Mock()
        i2c.scan.return_value = []
        capture = stream.I2CCapture(settings, lambda bus: i2c)
        for elapsed in range(1, 100):
            capture.sample(elapsed)
        first = capture.buffer.take(0, "a" * 16)
        self.assertEqual(first["data"], "")
        self.assertEqual(first["startUs"], 0)
        self.assertEqual(first["endUs"], 99)
        self.assertEqual(first["dropped"], 0)
        self.assertIsNone(capture.buffer.take(0, "a" * 16))
        capture.sample(100)
        second = capture.buffer.take(0, "a" * 16)
        self.assertEqual(second["startUs"], first["endUs"])
        self.assertEqual(second["sequence"], first["sequence"] + 1)
        self.assertEqual(capture.buffer.take(1, "a" * 16)["endUs"], 100)
        i2c.readfrom.assert_not_called()

    def test_reads_preserve_addresses_zero_bytes_and_configured_registers(self):
        settings = self.settings()
        settings["buses"][0]["registers"] = {"0x48": 0}
        i2c = Mock()
        i2c.scan.return_value = [0x48, 0x49]
        i2c.readfrom_mem.return_value = b"\x00" * 6
        i2c.readfrom.return_value = b"\x01\x02\x03\x04\x05\x06"
        capture = stream.I2CCapture(settings, lambda bus: i2c)
        capture.sample(100)
        frame = capture.buffer.take(0, "a" * 16)
        self.assertEqual(bytes.fromhex(frame["data"]), b"\x48\x00\x06" + b"\x00" * 6 + b"\x49\x00\x06\x01\x02\x03\x04\x05\x06")
        i2c.readfrom_mem.assert_called_once_with(0x48, 0, 6)
        self.assertEqual(frame["dropped"], 0)

    def test_failed_reads_are_explicit_and_full_buffers_count_discarded_samples(self):
        settings = self.settings()
        i2c = Mock()
        i2c.scan.return_value = [0x48]
        i2c.readfrom.side_effect = OSError("sensor did not respond")
        capture = stream.I2CCapture(settings, lambda bus: i2c)
        capture.sample(100)
        frame = capture.buffer.take(0, "a" * 16)
        self.assertEqual(bytes.fromhex(frame["data"]), bytes((0x48, 255, 255, stream.READ_ERROR)))
        self.assertEqual(frame["dropped"], 1)
        buffer = stream.CaptureBuffer(settings)
        buffer.append(0, 1, b"x" * settings["maxDataBytes"], 0)
        buffer.append(0, 2, b"y", 0)
        result = buffer.take(0, "a" * 16)
        self.assertEqual(result["dropped"], 1)
        self.assertEqual(len(bytes.fromhex(result["data"])), settings["maxDataBytes"])
        self.assertEqual(result["endUs"], 2)


if __name__ == "__main__":
    unittest.main()

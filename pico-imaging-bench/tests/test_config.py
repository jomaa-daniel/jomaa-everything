"""Shared firmware settings are documented."""
import json
from pathlib import Path
import unittest

class FirmwareConfigTests(unittest.TestCase):
    def test_each_setting_is_documented(self):
        root = Path(__file__).resolve().parents[1]
        config = json.loads((root / "config.json").read_text())
        doc = (root / "config.md").read_text()
        for key in config:
            self.assertIn("`" + key + "`", doc)

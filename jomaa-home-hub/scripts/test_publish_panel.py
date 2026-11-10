import re
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import publish_panel as panel

CONFIG = ('tunnel: test\ningress:\n'
          '  - hostname: "hub.jomaa.org"\n    service: http://127.0.0.1:8080\n'
          '  - hostname: "jomaa.org"\n    path: ^/(?:home(?:/.*)?)?$\n'
          '    service: http://127.0.0.1:8080\n'
          '  - hostname: "sarah.jomaa.org"\n    service: http://127.0.0.1:8090\n'
          '  - service: http_status:404\n')


class PanelRoutingTest(unittest.TestCase):
    def test_routes_panel_assets_and_same_origin_api_without_exposing_other_paths(self):
        updated = panel.panel_config(CONFIG)
        self.assertEqual(panel.panel_config(updated), updated)
        for path in panel.URL_PATHS:
            self.assertIsNotNone(re.fullmatch(panel.PATH, path), path)
        for path in ("/deploy", "/api/matter/nodes", "/unrelated", "/lights-other"):
            self.assertIsNone(re.fullmatch(panel.PATH, path), path)
        self.assertIn('hostname: "sarah.jomaa.org"\n    service: http://127.0.0.1:8090', updated)
        self.assertIn('hostname: "hub.jomaa.org"\n    service: http://127.0.0.1:8080', updated)

    def test_refuses_missing_or_conflicting_host_rule(self):
        for config in ("ingress:\n  - service: http_status:404\n",
                       CONFIG.replace('hostname: "jomaa.org"', 'hostname: "other.org"'),
                       CONFIG.replace('path: ^/(?:home(?:/.*)?)?$', 'path: ^/home$').replace(
                           'hostname: "sarah.jomaa.org"\n    service: http://127.0.0.1:8090',
                           'hostname: "jomaa.org"\n    service: http://127.0.0.1:8080')):
            with self.assertRaises(panel.PublishError):
                panel.panel_config(config)

    def test_restart_failure_restores_config_and_removes_temp_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data = root / "data/native"
            data.mkdir(parents=True)
            config = data / "tunnel.yml"
            config.write_text(CONFIG)
            with mock.patch.object(panel, "routed_service", return_value=panel.SERVICE), \
                    mock.patch.object(panel.subprocess, "run", side_effect=[None, OSError("restart failed"), None]):
                with self.assertRaises(OSError):
                    panel.publish(root)
            self.assertEqual(config.read_text(), CONFIG)
            self.assertEqual(list(data.iterdir()), [config])


if __name__ == "__main__":
    unittest.main()

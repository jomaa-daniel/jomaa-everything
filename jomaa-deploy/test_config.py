"""config.md documents every global setting and every key of the module declarations."""
import json
import unittest
from pathlib import Path

from modules import KINDS

HERE = Path(__file__).resolve().parent
CHECKOUT = HERE.parent
# Values of these keys are data rather than settings: the JSON fields a health answer must contain.
DATA = {"health.json"}


def keys(value: object, path: str = "") -> list[str]:
    """Every key path: nested keys join with dots, keys of objects in arrays with []."""
    found = []
    if isinstance(value, dict):
        for key, field in value.items():
            name = f"{path}.{key}" if path else key
            found.append(name)
            if name not in DATA:
                found += keys(field, name)
    elif isinstance(value, list):
        for item in value:
            found += keys(item, f"{path}[]")
    return found


class ConfigDocTest(unittest.TestCase):
    def setUp(self):
        self.doc = (HERE / "config.md").read_text()

    def assertDocumented(self, key: str, where: str) -> None:
        self.assertIn(f"`{key}`", self.doc, f"config.md does not document {key} of {where}")

    def test_documents_every_setting_in_config_json(self):
        for key in keys(json.loads((HERE / "config.json").read_text())):
            self.assertDocumented(key, "config.json")

    def test_documents_every_key_of_every_component_declaration(self):
        declarations = [p.parent / "deploy.json" for p in sorted(CHECKOUT.glob("*/deploy_module.py"))]
        self.assertGreater(len(declarations), 0)
        for path in declarations:
            for key in keys(json.loads(path.read_text())):
                self.assertDocumented(key, f"{path.parent.name}/deploy.json")

    def test_documents_every_key_a_module_kind_declares(self):
        for kind in KINDS.values():
            if kind.kind != "StaticSite":
                for key in kind.keys:
                    self.assertDocumented(key, kind.kind)


if __name__ == "__main__":
    unittest.main()

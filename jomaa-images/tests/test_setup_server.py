"""Root policy plans and constrained mount authorization without changing host policies."""
import contextlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
import setup_server
from images import load_config


class SetupTests(unittest.TestCase):
    def setUp(self):
        self.config = load_config()
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config["setup"] = {**self.config["setup"], "udevRulesFile": str(self.root / "udev.rules"),
                                 "polkitRulesFile": str(self.root / "polkit.rules")}

    def test_plan_and_unprivileged_execution_write_nothing(self):
        file = self.root / "config.json"
        file.write_text(json.dumps(self.config))
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(setup_server.main(["--config", str(file)]), 0)
            with patch.object(setup_server.os, "geteuid", return_value=1000):
                self.assertEqual(setup_server.main(["--config", str(file), "--execute"]), 1)
        self.assertFalse((self.root / "udev.rules").exists())
        self.assertFalse((self.root / "polkit.rules").exists())

    def test_policy_applies_only_to_matching_usb_and_group(self):
        text = setup_server.policies(self.config)[Path(self.config["setup"]["polkitRulesFile"])]
        usb = self.config["discovery"]
        properties = "\n".join(["ID_VENDOR_ID=" + usb["vendorId"], "ID_MODEL_ID=" + usb["bootselProductId"],
                                "ID_FS_LABEL=" + usb["bootselLabel"]])
        script = """const assert = require('node:assert/strict');
let rule; let properties = %s;
globalThis.polkit = {addRule: f => {rule=f;}, spawn: () => properties, Result: {YES:'yes'}};
%s
const action={id:%s,lookup:() => %s};
assert.equal(rule(action,{isInGroup:() => true}),'yes');
assert.equal(rule(action,{isInGroup:() => false}),undefined);
properties='ID_VENDOR_ID=ffff\\nID_MODEL_ID=0003\\nID_FS_LABEL=OTHER';
assert.equal(rule(action,{isInGroup:() => true}),undefined);
assert.equal(rule({...action,id:'unrelated.action'},{isInGroup:() => true}),undefined);
""" % (json.dumps(properties), text, json.dumps(setup_server.MOUNT_ACTIONS[0]),
       json.dumps(usb["deviceDirectory"] + "/fixture"))
        subprocess.run(["node", "-e", script], check=True, capture_output=True)

    def test_existing_foreign_policy_is_preserved_before_any_changes(self):
        foreign = self.root / "udev.rules"
        foreign.write_text("another policy")
        with patch.object(setup_server.os, "geteuid", return_value=0), patch.object(setup_server.grp, "getgrnam", return_value=Mock()), \
                patch.object(setup_server.subprocess, "run") as run, self.assertRaises(ValueError):
            setup_server.apply(self.config)
        self.assertEqual(foreign.read_text(), "another policy")
        self.assertFalse((self.root / "polkit.rules").exists())
        run.assert_not_called()

    def test_applies_policies_and_triggers_only_discovered_picos(self):
        target = {"mode": "runtime", "port": "/dev/ttyACM-fixture"}
        with patch.object(setup_server.os, "geteuid", return_value=0), patch.object(setup_server.grp, "getgrnam", return_value=Mock()), \
                patch.object(setup_server, "discover", return_value=[target]), patch.object(setup_server.subprocess, "run") as run:
            setup_server.apply(self.config)
        for name in ("udev.rules", "polkit.rules"):
            self.assertEqual((self.root / name).stat().st_mode & 0o777, 0o644)
        self.assertEqual(len(run.call_args_list), 2)
        self.assertEqual(run.call_args_list[1].args[0][-1], self.config["discovery"]["ttyDirectory"] + "/ttyACM-fixture")


if __name__ == "__main__":
    unittest.main()

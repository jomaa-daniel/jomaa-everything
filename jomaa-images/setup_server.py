#!/usr/bin/env python3
"""Plan or apply the hub's root-owned Pico USB access policies."""
import argparse
import grp
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

from images import CONFIG_FILE, discover, load_config

HEADER = "Jomaa Pico USB access"
MOUNT_ACTIONS = ("org.freedesktop.udisks2.filesystem-mount",
                 "org.freedesktop.udisks2.filesystem-mount-system",
                 "org.freedesktop.udisks2.filesystem-mount-other-seat")


def policies(config):
    setup, usb = config["setup"], config["discovery"]
    group = setup["group"]
    if not isinstance(group, str) or not re.fullmatch(r"[a-z_][a-z0-9_-]*", group):
        raise ValueError("Invalid setup.group")
    for key in ("udevRulesFile", "polkitRulesFile", "udevadm"):
        if not isinstance(setup[key], str) or not Path(setup[key]).is_absolute():
            raise ValueError("Setup paths must be absolute")
    if Path(setup["udevRulesFile"]) == Path(setup["polkitRulesFile"]):
        raise ValueError("The policy destinations must differ")
    tty = ('SUBSYSTEM=="tty", ATTRS{idVendor}==%s, ATTRS{idProduct}==%s, GROUP=%s, MODE="0660"\n' %
           tuple(json.dumps(value) for value in (usb["vendorId"], usb["runtimeProductId"], group)))
    block = ('SUBSYSTEM=="block", ATTRS{idVendor}==%s, ATTRS{idProduct}==%s, GROUP=%s, MODE="0660"\n' %
             tuple(json.dumps(value) for value in (usb["vendorId"], usb["bootselProductId"], group)))
    required = ["ID_VENDOR_ID=" + usb["vendorId"], "ID_MODEL_ID=" + usb["bootselProductId"],
                "ID_FS_LABEL=" + usb["bootselLabel"]]
    polkit = "// " + HEADER + "\n" + """polkit.addRule(function(action, subject) {
    if (%s.indexOf(action.id) < 0 || !subject.isInGroup(%s)) return;
    var device = action.lookup("device");
    if (!device || device.indexOf(%s) !== 0) return;
    try {
        var properties = polkit.spawn([%s, "info", "--query=property", "--name", device]).split("\\n");
        var required = %s;
        for (var i = 0; i < required.length; i++) {
            if (properties.indexOf(required[i]) < 0) return;
        }
        return polkit.Result.YES;
    } catch (error) { return; }
});
""" % (json.dumps(MOUNT_ACTIONS), json.dumps(group), json.dumps(usb["deviceDirectory"] + "/"),
       json.dumps(setup["udevadm"]), json.dumps(required))
    return {Path(setup["udevRulesFile"]): "# " + HEADER + "\n" + tty + block,
            Path(setup["polkitRulesFile"]): polkit}


def write_policy(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, "w") as output:
            output.write(content)
            os.fchmod(output.fileno(), 0o644)
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def apply(config):
    if os.geteuid() != 0:
        raise ValueError("Run --execute as root on the USB host")
    files = policies(config)
    grp.getgrnam(config["setup"]["group"])
    for path in files:
        if path.is_symlink() or (path.exists() and HEADER not in path.read_text()):
            raise ValueError("A policy destination contains a different policy; inspect it before setup")
    for path, content in files.items():
        write_policy(path, content)
    command = config["setup"]["udevadm"]
    timeout = config["commandTimeoutSeconds"]
    subprocess.run([command, "control", "--reload-rules"], check=True, timeout=timeout)
    for target in discover(config, private=True):
        node = Path(target["port"] if target["mode"] == "runtime" else target["device"]).resolve().name
        directory = config["discovery"]["ttyDirectory" if target["mode"] == "runtime" else "blockDirectory"]
        subprocess.run([command, "trigger", "--action=change", str(Path(directory) / node)], check=True, timeout=timeout)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=CONFIG_FILE)
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args(argv)
    try:
        config = load_config(args.config)
        if args.execute:
            apply(config)
            print("Pico access policies installed; refresh USB Picos in the hub.")
        else:
            for path, content in policies(config).items():
                print(str(path) + "\n" + content)
            print("Plan only. Run with --execute as root to apply it.")
        return 0
    except Exception:
        print("USB access setup failed. Check root access, the configured group and policy destinations.")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

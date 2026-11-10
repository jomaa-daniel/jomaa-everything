#!/usr/bin/env python3
"""Prepare credentials, flash MicroPython, clear the filesystem, install and verify health reporting."""
from __future__ import annotations

import argparse
import importlib.util
from pathlib import Path
import sys

from common import BenchError, HubClient, private_json, provisioner, usb_json, usb_command, verify_reports, wait_for_port
from flash_pico import FAMILIES, flash, validate_uf2, validate_volume
from test_pico import progress


def fresh_filesystem(port: str, expected_uid: str | None, transport: str):
    code = """import machine, ssl, binascii, json, rp2, io, vfs
assert hasattr(ssl, 'SSLContext') and hasattr(ssl, 'CERT_REQUIRED')
assert hasattr(ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT), 'load_verify_locations')
assert hasattr(vfs, 'VfsLfs2')
print('JOMAA_BENCH:'+json.dumps({'uniqueId':binascii.hexlify(machine.unique_id()).decode()}))
"""
    if transport == "native":
        code += "import network; assert hasattr(network, 'WLAN')\n"
    else:
        code += "assert hasattr(machine, 'UART') and hasattr(io, 'IOBase')\n"
    info = usb_json(port, code)
    if expected_uid and info["uniqueId"] != expected_uid:
        raise BenchError("serial port belongs to a different device; filesystem was preserved")
    # UF2 updates can preserve previous main.py and settings. Format the filesystem explicitly.
    usb_command(port, "exec", "import vfs,rp2; vfs.umount('/'); bdev=rp2.Flash(); "
                "vfs.VfsLfs2.mkfs(bdev,progsize=256); vfs.mount(vfs.VfsLfs2(bdev,progsize=256),'/')")
    return info


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--uf2", type=Path, required=True)
    parser.add_argument("--sha256", required=True)
    parser.add_argument("--bootsel-volume", type=Path, required=True)
    parser.add_argument("--chip", choices=FAMILIES, default="rp2040")
    parser.add_argument("--port", required=True, help="explicit serial path expected after flashing")
    parser.add_argument("--expected-uid", help="optional known board identity, checked before clearing its filesystem")
    parser.add_argument("--wifi-transport", choices=("native", "esp8285"), default="native")
    parser.add_argument("--hub-url", default="https://hub.jomaa.org")
    parser.add_argument("--id", required=True)
    parser.add_argument("--name", required=True)
    parser.add_argument("--ssid", required=True)
    parser.add_argument("--wifi-password-file")
    parser.add_argument("--hub-password-file")
    parser.add_argument("--credential-file")
    parser.add_argument("--rotate", action="store_true")
    parser.add_argument("--ca-cert", type=Path, required=True)
    parser.add_argument("--interval", type=int, default=15, help="seconds; short bench intervals speed verification")
    parser.add_argument("--run-dir", type=Path, required=True, help="new private run directory")
    parser.add_argument("--timeout", type=int, default=180)
    parser.add_argument("--execute", action="store_true", help="flash, erase all Pico files, install and test")
    args = parser.parse_args(argv)
    try:
        metadata = validate_uf2(args.uf2, args.sha256, args.chip)
        validate_volume(args.bootsel_volume, args.chip)
        module = provisioner()
        module.hub_origin(args.hub_url)
        module.certificate(args.ca_cert)
        if args.run_dir.exists():
            raise BenchError("choose a new run directory")
        if not 15 <= args.interval <= 3600 or not 10 <= args.timeout <= 3600:
            raise BenchError("interval must be 15–3600 and timeout 10–3600 seconds")
        if args.credential_file and args.rotate:
            raise BenchError("credential-file and rotate cannot be combined")
        if not args.execute:
            print("Validated image plan: %s firmware, %s Wi-Fi, HTTPS hub %s." % (args.chip, args.wifi_transport, args.hub_url))
            print("With --execute: prepare credentials, flash, clear Pico files, install, verify three new database reports.")
            return 0
        if importlib.util.find_spec("mpremote") is None:
            raise BenchError("run with the isolated USB tools Python from setup_tools.py")
        args.run_dir.mkdir(parents=True, mode=0o700)
        prepared = args.run_dir / "prepared"
        prepare_args = ["--hub-url", args.hub_url, "--id", args.id, "--name", args.name, "--ssid", args.ssid,
                        "--wifi-transport", args.wifi_transport, "--ca-cert", str(args.ca_cert),
                        "--interval", str(args.interval), "--output", str(prepared)]
        for flag, value in [("--wifi-password-file", args.wifi_password_file),
                            ("--hub-password-file", args.hub_password_file), ("--credential-file", args.credential_file)]:
            if value:
                prepare_args += [flag, value]
        if args.rotate:
            prepare_args.append("--rotate")
        if module.main(prepare_args):
            raise BenchError("credential preparation failed; flashing was not started")
        # Verify administrator access before erasing hardware, including when a UI credential is supplied.
        client = HubClient(prepared, args.hub_password_file)
        client.request("/api/devices/" + args.id)
        print("Flashing trusted firmware onto the selected BOOTSEL volume.", flush=True)
        flash(args.uf2, args.sha256, args.bootsel_volume, args.chip)
        wait_for_port(args.port)
        device = fresh_filesystem(args.port, args.expected_uid, args.wifi_transport)
        private_json(args.run_dir / "image.json", {**metadata, **device, "deviceId": args.id,
                                                   "wifiTransport": args.wifi_transport})
        module.install(args.port, prepared)
        print("Installed startup reporter. Waiting for new persisted reports.", flush=True)
        result = verify_reports(client, args.id, 3, args.timeout, progress)
        private_json(args.run_dir / "report.json", result)
        print("PASS: %s is %s at %s; startup reporter installed and three reports persisted." % (args.id, result["status"], result["latest"]["ip"]))
        return 0
    except Exception as error:
        print("Imaging failed: " + (str(error) if isinstance(error, BenchError) else type(error).__name__), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

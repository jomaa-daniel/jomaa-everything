#!/usr/bin/env python3
"""Flash, provision through Add Device, and verify a Pico's HTTPS health heartbeats."""
from __future__ import annotations

import argparse
import getpass
import json
from pathlib import Path
import re
import socket
import ssl
import sys
import urllib.error
import urllib.request
import uuid

from common import BENCH, HUB, BenchError, private_json, provisioner, verify_reports
from image_and_test import fresh_filesystem
import setup_wifi as wifi
from test_pico import progress


class Hub:
    def __init__(self, origin, certificate, password):
        self.origin = origin.rstrip("/")
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        context.load_verify_locations(cadata=ssl.DER_cert_to_PEM_cert(certificate))
        self.opener = urllib.request.build_opener(provisioner().NoRedirect,
                                                  urllib.request.HTTPSHandler(context=context))
        self.token = None
        self.token = self.request("/api/login", {"password": password})["token"]

    def request(self, path, body=None, method=None):
        headers = {"User-Agent": "jomaa-home-hub/pico-imaging-bench", "Content-Type": "application/json"}
        if self.token:
            headers["Authorization"] = "Bearer " + self.token
        request = urllib.request.Request(self.origin + path,
                                         None if body is None else json.dumps(body).encode(), headers, method=method)
        try:
            with self.opener.open(request, timeout=20) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            raise BenchError("hub rejected setup request (HTTP %d)" % error.code) from None
        except urllib.error.URLError:
            raise BenchError("cannot reach the hub over verified HTTPS") from None


def trusted_root(origin):
    endpoint = provisioner().hub_origin(origin)
    context = ssl.create_default_context()
    with socket.create_connection((endpoint.hostname, endpoint.port or 443), timeout=20) as raw:
        with context.wrap_socket(raw, server_hostname=endpoint.hostname) as connection:
            root = connection.get_verified_chain()[-1]
    if root not in context.get_ca_certs(binary_form=True):
        raise BenchError("verified hub chain did not end in an OS-trusted root; supply --ca-cert")
    return root


def hub_password(path):
    if path is None:
        return getpass.getpass("Hub administrator password: ")
    if path.stat().st_mode & 0o077:
        raise BenchError("hub password file must have mode 600 or stricter")
    content = path.read_text().strip()
    for line in content.splitlines():
        key, separator, value = line.partition("=")
        if separator and key.strip() == "HUB_PASSWORD":
            return value.strip().strip("'\"")
    if "\n" not in content:
        return content
    raise BenchError("hub password file must contain HUB_PASSWORD or one password")


def inspect_target(env, port, expected_uid):
    data = wifi.usb_json(env, port, """import machine,binascii,json,os
files=os.listdir()
config={}
if 'device_config.json' in files:
 config=json.load(open('device_config.json'))
elif 'wifi_config.json' in files:
 config=json.load(open('wifi_config.json'))
print('JOMAA_SETUP:'+json.dumps({'uid':binascii.hexlify(machine.unique_id()).decode(),
 'config':config,'startup':open('main.py').read() if 'main.py' in files else None}))
""")
    if data["uid"] != expected_uid:
        raise BenchError("selected Pico identity changed; its files were preserved")
    return data


def credentials(client, device_id, name, interval, config, rotate):
    existing = next((device for device in client.request("/api/devices")["devices"]
                     if device["id"] == device_id), None)
    if existing is None:
        issued = client.request("/api/devices/enroll", {"id": device_id, "name": name,
                                                      "intervalSeconds": interval})
    elif rotate:
        issued = client.request("/api/devices/" + device_id + "/credential", {})
    elif (config.get("id") == device_id and isinstance(config.get("token"), str)
          and re.fullmatch(r"[a-f0-9]{64}", config["token"])
          and config.get("hub_host") == provisioner().hub_origin(client.origin).hostname
          and config.get("hub_port") == (provisioner().hub_origin(client.origin).port or 443)
          and existing["status"] != "revoked"):
        issued = {"token": config["token"], "device": existing}
    else:
        raise BenchError("device ID is already enrolled; use --rotate to replace its credential")
    if not isinstance(issued.get("token"), str) or not re.fullmatch(r"[a-f0-9]{64}", issued["token"]):
        raise BenchError("hub returned an invalid device credential")
    return issued


def prepare(module, output, device_id, origin, config, issued, root):
    endpoint = module.hub_origin(origin)
    device = issued["device"]
    settings = {"id": device_id, "token": issued["token"], "hub_host": endpoint.hostname,
                "hub_port": endpoint.port or 443, "wifi_ssid": config["wifi_ssid"],
                "wifi_password": config["wifi_password"], "wifi_transport": config["transport"],
                "interval_seconds": device["intervalSeconds"], "ca_file": "health_ca.der"}
    output.mkdir(mode=0o700)
    private_json(output / "device_config.json", settings)
    module.private_write(output / "health_ca.der", root)
    module.private_write(output / "main.py", module.FIRMWARE.read_bytes())
    if settings["wifi_transport"] == "esp8285":
        module.private_write(output / "esp8285.py", module.ESP_FIRMWARE.read_bytes())


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    selection = parser.add_mutually_exclusive_group()
    selection.add_argument("--target-port", help="reimage a connected MicroPython Pico")
    selection.add_argument("--configure-port", help="install health reporting using installed MicroPython")
    parser.add_argument("--wifi-transport", choices=("esp8285", "native"), default="esp8285")
    parser.add_argument("--ssid", help="Wi-Fi network; defaults to target or source Pico settings, then a prompt")
    parser.add_argument("--wifi-password-file", help="private file containing the Wi-Fi password")
    parser.add_argument("--hub-url", default="https://hub.jomaa.org")
    parser.add_argument("--hub-password-file", type=Path, help="private HUB_PASSWORD env file or password file")
    parser.add_argument("--ca-cert", type=Path, help="trusted root CA; defaults to the OS-verified hub chain")
    parser.add_argument("--id", help="device ID; defaults to the installed ID or pico-UNIQUE_ID")
    parser.add_argument("--name", help="device name; defaults to the enrolled name or Pico UNIQUE_ID")
    parser.add_argument("--interval", type=int, default=15)
    parser.add_argument("--rotate", action="store_true", help="replace an existing target's device credential")
    parser.add_argument("--run-dir", type=Path, help="new private output directory")
    parser.add_argument("--timeout", type=int, default=180)
    parser.add_argument("--execute", action="store_true", help="flash and install startup health reporting")
    args = parser.parse_args(argv)
    try:
        if sys.platform not in ("linux", "darwin"):
            raise BenchError("setup supports Linux and macOS")
        module = provisioner()
        module.hub_origin(args.hub_url)
        if not 15 <= args.interval <= 3600 or not 10 <= args.timeout <= 3600:
            raise BenchError("interval must be 15–3600 and timeout 10–3600 seconds")
        if args.id is not None and not re.fullmatch(r"[a-z0-9][a-z0-9_-]{2,63}", args.id):
            raise BenchError("invalid device ID")
        if args.name is not None and (not 1 <= len(args.name.strip()) <= 80 or any(ord(c) < 32 for c in args.name)):
            raise BenchError("device name must be 1–80 printable characters")
        if args.wifi_password_file and args.ssid is None:
            raise BenchError("--wifi-password-file requires --ssid")
        run = args.run_dir or BENCH / "data" / "runs" / uuid.uuid4().hex
        if run.exists():
            raise BenchError("choose a new run directory")
        if not args.execute:
            print("Plan: verify tools and TLS, obtain Wi-Fi, enroll through Add Device, install startup reporting, verify three persisted heartbeats.")
            print("Add --execute to configure the selected Pico; flashing erases its filesystem.")
            return 0
        selected = args.target_port or args.configure_port
        bootsel_selection = None if selected else wifi.find_bootsel()
        if args.target_port and wifi.bootsel_volumes():
            raise BenchError("disconnect other BOOTSEL Picos before using --target-port")
        run.mkdir(parents=True, mode=0o700)
        root = module.certificate(args.ca_cert) if args.ca_cert else trusted_root(args.hub_url)
        password_file = args.hub_password_file
        if password_file is None and (HUB / ".env").exists():
            password_file = HUB / ".env"
        client = Hub(args.hub_url, root, hub_password(password_file))
        print("Hub authenticated over verified HTTPS. Preparing USB tools.", flush=True)
        env = wifi.install_tools(run / "tools")
        existing = wifi.ports()
        for port in existing.values():
            wifi.require_serial_access(port)
        target = {"uid": None, "config": {}, "startup": None}
        if selected:
            uid = wifi.target_identity(env, selected, existing)
            target = inspect_target(env, selected, uid)
            del existing[uid]
        config = target["config"]
        source_uid = None
        if args.ssid is not None:
            config = {"wifi_ssid": args.ssid,
                      "wifi_password": module.secret(args.wifi_password_file, "Wi-Fi password: ")}
        elif not config.get("wifi_ssid") or not isinstance(config.get("wifi_password"), str):
            config, source_uid = wifi.get_wifi(env, existing, args.wifi_transport)
        config = {**config, "transport": args.wifi_transport}
        if (not isinstance(config.get("wifi_ssid"), str) or not isinstance(config.get("wifi_password"), str)
                or not 1 <= len(config["wifi_ssid"].encode()) <= 32 or len(config["wifi_password"].encode()) > 64):
            raise BenchError("invalid Wi-Fi settings")
        if not args.configure_port:
            payload = wifi.download(wifi.FIRMWARE_URL)
            wifi.validate_firmware(payload)
            device, mounted = wifi.enter_bootsel(selected) if selected else bootsel_selection
            volume, mounted_here = wifi.mount_bootsel(device, mounted, run)
            try:
                print("Flashing verified MicroPython firmware.", flush=True)
                wifi.flash(volume, payload)
            finally:
                if mounted_here:
                    wifi.unmount_bootsel(device, volume)
            uid, selected = wifi.returning_port(existing)
            if target["uid"] and uid != target["uid"]:
                raise BenchError("returning Pico is not the selected target; its filesystem was preserved")
            if uid == source_uid:
                raise BenchError("returning Pico is the Wi-Fi source; its filesystem was preserved")
        uid = target["uid"] if args.configure_port else uid
        device_id = args.id or target["config"].get("id") or "pico-" + uid
        if not isinstance(device_id, str) or not re.fullmatch(r"[a-z0-9][a-z0-9_-]{2,63}", device_id):
            raise BenchError("installed device ID is invalid; supply --id")
        inventory = client.request("/api/devices")["devices"]
        enrolled = next((device for device in inventory if device["id"] == device_id), None)
        name = args.name or (enrolled["name"] if enrolled else "Pico " + uid)
        issued = credentials(client, device_id, name, args.interval, target["config"], args.rotate)
        issued["device"] = client.request("/api/devices/" + device_id,
                                         {"name": name, "intervalSeconds": args.interval}, method="PATCH")["device"]
        prepare(module, run / "prepared", device_id, args.hub_url, config, issued, root)
        if target["startup"] is not None:
            module.private_write(run / "startup-before.py", target["startup"].encode())
        private_json(run / "image.json", {"uniqueId": uid, "deviceId": device_id,
                                          "wifiTransport": args.wifi_transport,
                                          "firmwareSha256": None if args.configure_port else wifi.FIRMWARE_SHA256})
        if not args.configure_port:
            fresh_filesystem(selected, uid, args.wifi_transport)
        print("Installing startup heartbeat reporter for %s." % device_id, flush=True)
        module.install(selected, run / "prepared", env=env)
        print("Waiting for three new persisted heartbeats.", flush=True)
        result = verify_reports(client, device_id, 3, args.timeout, progress)
        private_json(run / "report.json", result)
        print("PASS: %s is %s at %s; three heartbeats persisted. Files: %s" %
              (device_id, result["status"], result["latest"]["ip"], run))
        return 0
    except Exception as error:
        print("Pico setup failed: " + (str(error) if isinstance(error, (BenchError, wifi.SetupError))
                                       else type(error).__name__), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

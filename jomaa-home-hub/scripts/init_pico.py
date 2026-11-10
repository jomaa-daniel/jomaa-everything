#!/usr/bin/env python3
"""Prepare Pico Wi-Fi health firmware; USB writes require --install and an explicit --port.

Requires MicroPython already installed. Does not flash UF2 or auto-select a USB device.
Secrets are read from private files or prompts and written only to a private output directory.
"""
from __future__ import annotations

import argparse
import getpass
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import ssl
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

FIRMWARE = Path(__file__).resolve().parent.parent / "devices" / "pico-health" / "main.py"
ESP_FIRMWARE = FIRMWARE.with_name("esp8285.py")


class ProvisionError(ValueError):
    """A safe, operator-facing provisioning error."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def secret(path: str | None, prompt: str) -> str:
    if path:
        source = Path(path)
        if os.name != "nt" and source.stat().st_mode & 0o077:
            raise ProvisionError("secret files must have mode 600 or stricter")
        return source.read_text().rstrip("\r\n")
    return getpass.getpass(prompt)


def certificate(path: Path) -> bytes:
    value = path.read_bytes()
    if b"-----BEGIN CERTIFICATE-----" in value:
        pem = value.decode("ascii")
        if pem.count("-----BEGIN CERTIFICATE-----") != 1:
            raise ProvisionError("provide exactly one trusted root CA certificate")
        der = ssl.PEM_cert_to_DER_cert(pem)
    else:
        der = value
        pem = ssl.DER_cert_to_PEM_cert(der)
    ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT).load_verify_locations(cadata=pem)
    return der


def hub_origin(value: str) -> urllib.parse.SplitResult:
    origin = urllib.parse.urlsplit(value)
    if (origin.scheme != "https" or not origin.hostname or origin.username or origin.password or
            origin.query or origin.fragment or origin.path not in ("", "/") or ":" in origin.hostname):
        raise ProvisionError("hub URL must be an HTTPS origin with a DNS name or IPv4 address")
    _ = origin.port  # validate port syntax
    return origin


def request(opener, origin: str, path: str, data: dict, token: str | None = None) -> dict:
    headers = {"Content-Type": "application/json", "User-Agent": "jomaa-home-hub/init-pico"}
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(origin.rstrip("/") + path, json.dumps(data).encode(), headers)
    try:
        with opener.open(req, timeout=20) as response:
            result = json.load(response)
    except urllib.error.HTTPError as error:
        # Do not echo remote bodies, which could contain secrets or untrusted text.
        raise ProvisionError("hub API rejected request (HTTP %d)" % error.code) from None
    except urllib.error.URLError:
        raise ProvisionError("cannot reach hub over verified HTTPS") from None
    if not isinstance(result, dict):
        raise ProvisionError("unexpected hub response")
    return result


def private_write(path: Path, data: bytes) -> None:
    # Exclusive creation also prevents following an existing symlink.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as output:
        output.write(data)


def install(port: str, output: Path) -> None:
    def remote(*args):
        result = subprocess.run([sys.executable, "-m", "mpremote", "connect", port, "resume", *args],
                                capture_output=True, timeout=40)
        if result.returncode:
            raise ProvisionError("USB installation failed; prepared files remain in the output directory")
    config = json.loads((output / "device_config.json").read_text())
    remote("exec", "import ssl; assert hasattr(ssl, 'CERT_REQUIRED'); "
           "assert hasattr(ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT), 'load_verify_locations')")
    if config.get("wifi_transport", "native") == "esp8285":
        remote("exec", "import machine, io; assert hasattr(machine, 'UART'); assert hasattr(io, 'IOBase')")
    else:
        remote("exec", "import network; assert hasattr(network, 'WLAN')")
    # Preserve any existing startup program, and refuse to overwrite an earlier backup.
    remote("exec", "import os; files=os.listdir(); assert 'main.pre-health.py' not in files; "
           "os.rename('main.py','main.pre-health.py') if 'main.py' in files else None")
    names = ["device_config.json", "health_ca.der"]
    if config.get("wifi_transport") == "esp8285":
        names.append("esp8285.py")
    for name in names + ["main.py"]:
        remote("fs", "cp", str(output / name), ":" + name)
    # mpremote soft-reset leaves the board in raw REPL and does not run main.py.
    # Its reset shortcut schedules a hardware restart and disconnects without waiting for output.
    remote("reset")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--hub-url", default="https://hub.jomaa.org")
    parser.add_argument("--id", required=True, help="stable device ID: 3–64 lowercase letters/numbers/_/-")
    parser.add_argument("--name", required=True)
    parser.add_argument("--ssid", required=True)
    parser.add_argument("--wifi-transport", choices=("native", "esp8285"), default="native",
                        help="native Pico W radio, or an ESP8285 wired to UART0 GP0/GP1 at 115200 baud")
    parser.add_argument("--wifi-password-file", help="private file containing only the Wi-Fi password")
    parser.add_argument("--hub-password-file", help="private file containing only the hub password")
    parser.add_argument("--credential-file", help="private JSON {id,token} from the management UI; skips enrollment")
    parser.add_argument("--ca-cert", type=Path, required=True, help="one trusted root CA, PEM or DER")
    parser.add_argument("--interval", type=int, default=60)
    parser.add_argument("--output", type=Path, required=True, help="new private directory for prepared files")
    parser.add_argument("--rotate", action="store_true", help="issue a replacement token for an existing device")
    parser.add_argument("--install", action="store_true", help="write prepared firmware over USB and restart it")
    parser.add_argument("--port", help="explicit serial port; used only with --install")
    args = parser.parse_args(argv)
    try:
        origin = hub_origin(args.hub_url)
        if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{2,63}", args.id):
            raise ProvisionError("invalid device ID")
        if not 15 <= args.interval <= 3600:
            raise ProvisionError("interval must be from 15 to 3600 seconds")
        if not 1 <= len(args.name.strip()) <= 80 or any(ord(c) < 32 for c in args.name):
            raise ProvisionError("device name must be 1–80 printable characters")
        if not 1 <= len(args.ssid.encode()) <= 32:
            raise ProvisionError("Wi-Fi SSID must be 1–32 bytes")
        if args.install and not args.port:
            raise ProvisionError("--install requires an explicit --port")
        if args.port and not args.install:
            raise ProvisionError("--port is only used with --install")
        if args.credential_file and args.rotate:
            raise ProvisionError("--credential-file and --rotate cannot be combined")
        if args.install and importlib.util.find_spec("mpremote") is None:
            raise ProvisionError("install mpremote first: python3 -m pip install mpremote")
        if args.output.exists():
            raise ProvisionError("output directory already exists; choose a new private directory")
        ca = certificate(args.ca_cert)
        wifi_password = secret(args.wifi_password_file, "Wi-Fi password: ")
        if len(wifi_password.encode()) > 64:
            raise ProvisionError("Wi-Fi password must be at most 64 bytes")
        interval = args.interval
        if args.credential_file:
            source = Path(args.credential_file)
            if os.name != "nt" and source.stat().st_mode & 0o077:
                raise ProvisionError("credential file must have mode 600 or stricter")
            issued = json.loads(source.read_text())
            if not isinstance(issued, dict) or issued.get("id") != args.id:
                raise ProvisionError("credential file does not match device ID")
            token = issued["token"]
        else:
            # Verify the same root that will be installed on the board, not any OS root.
            ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
            ctx.load_verify_locations(cadata=ssl.DER_cert_to_PEM_cert(ca))
            opener = urllib.request.build_opener(NoRedirect, urllib.request.HTTPSHandler(context=ctx))
            login = request(opener, args.hub_url, "/api/login", {
                "password": secret(args.hub_password_file, "Hub password: ")})
            session = login["token"]
            path = "/api/devices/" + args.id + "/credential" if args.rotate else "/api/devices/enroll"
            body = {} if args.rotate else {"id": args.id, "name": args.name, "intervalSeconds": args.interval}
            issued = request(opener, args.hub_url, path, body, session)
            token = issued["token"]
            interval = issued["device"]["intervalSeconds"]
        if not isinstance(token, str) or not re.fullmatch(r"[a-f0-9]{64}", token):
            raise ProvisionError("invalid device credential")
        config = {"id": args.id, "token": token, "hub_host": origin.hostname, "hub_port": origin.port or 443,
                  "wifi_ssid": args.ssid, "wifi_password": wifi_password,
                  "wifi_transport": args.wifi_transport,
                  "interval_seconds": interval, "ca_file": "health_ca.der"}
        args.output.mkdir(parents=True, mode=0o700)
        private_write(args.output / "device_config.json", (json.dumps(config, indent=2) + "\n").encode())
        private_write(args.output / "health_ca.der", ca)
        private_write(args.output / "main.py", FIRMWARE.read_bytes())
        if args.wifi_transport == "esp8285":
            private_write(args.output / "esp8285.py", ESP_FIRMWARE.read_bytes())
        print("Prepared health firmware for %s in %s" % (args.id, args.output))
        if args.install:
            install(args.port, args.output)
            print("Installed on the selected port and restarted. Check /devices for the first health report.")
        else:
            print("Preparation only: no USB device was opened or changed.")
        return 0
    except ProvisionError as error:
        print("Provisioning failed: " + str(error), file=sys.stderr)
        return 1
    except (ValueError, OSError, KeyError, subprocess.TimeoutExpired):
        # A subprocess or network exception may include secret values; report only a safe summary.
        print("Provisioning failed. Check arguments, private file permissions, HTTPS trust, and hub enrollment state.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

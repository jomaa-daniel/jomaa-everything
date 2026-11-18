#!/usr/bin/env python3
"""Discover USB Picos and prepare, flash and verify selected image functions."""
from __future__ import annotations

import argparse
import contextlib
import fcntl
import hashlib
import importlib
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parent.parent
FIRMWARE = Path(__file__).with_name("firmware")
CONFIG_FILE = Path(__file__).with_name("config.json")
MARKER = b"JOMAA_IMAGE:"
SUPPORTED_FEATURES = {"health", "wifi", "temperature", "i2c", "fan"}
MAX_PERCENT = 100
MAX_GPIO = 28
SSID_MAX_BYTES = 32
PASSWORD_MAX_BYTES = 64
DEVICE_CONFIG_FILE = "device_config.json"
WIFI_CONFIG_FILE = "wifi_config.json"
IMAGE_FILE = "image.json"


class ImageError(ValueError):
    """An error whose message is safe for the imaging panel."""


def load_config(path=CONFIG_FILE):
    config = json.loads(Path(path).read_text())
    for key in ("commandTimeoutSeconds", "inspectionTimeoutSeconds", "flashTimeoutSeconds", "verificationSeconds", "usbTimeoutSeconds",
                "returnTimeoutSeconds", "pollMilliseconds", "retentionHours", "maxOutputBytes",
                "maxRequestBytes", "healthReports", "healthIntervalSeconds"):
        if type(config.get(key)) is not int or config[key] <= 0:
            raise ImageError("Invalid imaging setting: " + key)
    if config["healthReports"] < 3 or not 15 <= config["healthIntervalSeconds"] <= 3600:
        raise ImageError("Invalid health verification settings")
    if config["defaultWifiTransport"] not in ("native", "esp8285"):
        raise ImageError("Invalid defaultWifiTransport")
    for key in ("benchScripts", "hubDeploy", "runDirectory", "runStateFile", "lockFile"):
        value = config.get(key)
        if not isinstance(value, str) or not value or Path(value).is_absolute() or ".." in Path(value).parts:
            raise ImageError("Invalid imaging path: " + key)
    if config.get("trustedCaFile") is not None and not isinstance(config["trustedCaFile"], str):
        raise ImageError("Invalid trustedCaFile")
    discovery = config["discovery"]
    if not isinstance(discovery.get("bootselLabel"), str) or not discovery["bootselLabel"]:
        raise ImageError("Invalid discovery.bootselLabel")
    setup = config["setup"]
    if not isinstance(setup["group"], str) or not re.fullmatch(r"[a-z_][a-z0-9_-]*", setup["group"]):
        raise ImageError("Invalid setup.group")
    for key in ("udevRulesFile", "polkitRulesFile", "udevadm"):
        if not isinstance(setup[key], str) or not Path(setup[key]).is_absolute():
            raise ImageError("Invalid setup path: " + key)
    for key in ("ttyDirectory", "blockDirectory", "deviceDirectory", "serialDirectory"):
        if not isinstance(discovery.get(key), str) or not Path(discovery[key]).is_absolute():
            raise ImageError("Invalid discovery path: " + key)
    for key in ("vendorId", "runtimeProductId", "bootselProductId"):
        if not isinstance(discovery.get(key), str) or not re.fullmatch(r"[a-f0-9]{4}", discovery[key]):
            raise ImageError("Invalid USB identity: " + key)
    for command in (config["command"], discovery["blockCommand"], discovery["mountCommand"]):
        if not isinstance(command, list) or not command or any(not isinstance(x, str) or not x for x in command):
            raise ImageError("Invalid imaging command")
    telemetry_keys = {"sampleMilliseconds", "idleMilliseconds", "baud", "temperatureAdc", "referenceVolts",
                      "referenceCelsius", "referenceSensorVolts", "voltsPerCelsius"}
    if not isinstance(config.get("telemetry"), dict) or set(config["telemetry"]) != telemetry_keys:
        raise ImageError("Invalid telemetry settings")
    for key, value in config["telemetry"].items():
        if type(value) not in (int, float) or not math.isfinite(value) or value <= 0:
            raise ImageError("Invalid telemetry setting: " + key)
        if key in ("sampleMilliseconds", "idleMilliseconds", "baud", "temperatureAdc") and type(value) is not int:
            raise ImageError("Telemetry setting must be a whole number: " + key)
    fan = config.get("fan")
    if not isinstance(fan, dict) or set(fan) != {"gpio", "frequencyHz", "inverted", "startupPercent",
            "lowPercent", "mediumPercent", "pollMilliseconds", "staleMilliseconds"}:
        raise ImageError("Invalid fan settings")
    for key in ("gpio", "frequencyHz", "startupPercent", "lowPercent", "mediumPercent", "pollMilliseconds", "staleMilliseconds"):
        if type(fan[key]) is not int or fan[key] < 0:
            raise ImageError("Invalid fan setting: " + key)
    if (fan["gpio"] > MAX_GPIO or not fan["frequencyHz"] or type(fan["inverted"]) is not bool
            or fan["startupPercent"] > MAX_PERCENT or not 0 < fan["lowPercent"] < fan["mediumPercent"] < MAX_PERCENT
            or not 0 < fan["pollMilliseconds"] < fan["staleMilliseconds"]):
        raise ImageError("Invalid fan PWM or mode settings")
    features = config["features"]
    if not isinstance(features, list) or len(features) != len(SUPPORTED_FEATURES):
        raise ImageError("Invalid image feature catalog")
    ids = [feature["id"] for feature in features]
    if set(ids) != SUPPORTED_FEATURES:
        raise ImageError("Unsupported image feature catalog")
    dependencies = {"health": ["wifi"], "wifi": [], "temperature": [], "i2c": ["health", "wifi"], "fan": ["health", "wifi"]}
    for feature in features:
        if (set(feature) != {"id", "label", "description", "requires", "default"}
                or not all(isinstance(feature[k], str) and feature[k] for k in ("label", "description"))
                or type(feature["default"]) is not bool or feature["requires"] != dependencies[feature["id"]]):
            raise ImageError("Invalid image feature definition")
    return config


def validate_request(value, config):
    if not isinstance(value, dict) or set(value) != {"features", "wifi"}:
        raise ImageError("Use a features list and Wi-Fi settings or null")
    features = value.get("features")
    if (not isinstance(features, list) or not features or any(not isinstance(x, str) for x in features)
            or len(set(features)) != len(features) or set(features) - SUPPORTED_FEATURES):
        raise ImageError("Select at least one supported feature without duplicates")
    for feature in config["features"]:
        if feature["id"] in features and not set(feature["requires"]).issubset(features):
            raise ImageError("Select the required features for " + feature["label"])
    if ("wifi" in features) != (value["wifi"] is not None):
        raise ImageError("Wi-Fi settings are required only for Wi-Fi images")
    if "wifi" in features:
        wifi = value["wifi"]
        if (not isinstance(wifi, dict) or set(wifi) != {"ssid", "password", "transport"}
                or wifi["transport"] not in ("esp8285", "native")
                or not isinstance(wifi["ssid"], str) or (wifi["password"] is not None and not isinstance(wifi["password"], str))
                or not 1 <= len(wifi["ssid"].encode()) <= SSID_MAX_BYTES
                or len((wifi["password"] or "").encode()) > PASSWORD_MAX_BYTES
                or any(c in wifi["ssid"] + (wifi["password"] or "") for c in ("\r", "\n", "\x00"))):
            raise ImageError("Invalid Wi-Fi settings")
    if "fan" in features:
        _, setup = helpers(config)
        runtime = json.loads(setup.provisioner().STREAM_SETTINGS.read_text())
        pin = config["fan"]["gpio"]
        if value["wifi"]["transport"] == "esp8285" and pin in (runtime["espUart"]["tx"], runtime["espUart"]["rx"]):
            raise ImageError("Fan PWM GPIO overlaps the ESP8285 radio")
        if "i2c" in features:
            for bus in runtime["buses"]:
                for bus_pin in (bus["sda"], bus["scl"]):
                    if pin == bus_pin:
                        raise ImageError("Fan PWM GPIO overlaps an I²C pin")
    return {**value, "features": [x["id"] for x in config["features"] if x["id"] in features]}


def private_json(path, value):
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as output:
        json.dump(value, output)
        output.write("\n")


def usb_parent(path):
    resolved = path.resolve()
    for parent in (resolved, *resolved.parents):
        if (parent / "idVendor").is_file() and (parent / "idProduct").is_file():
            return parent
    return None


def discover(config, private=False):
    if not sys.platform.startswith("linux"):
        raise ImageError("USB imaging discovery runs on the Linux hub server")
    settings = config["discovery"]
    targets = {}
    mounts = {}
    result = subprocess.run(settings["blockCommand"], capture_output=True, check=True,
                            timeout=config["commandTimeoutSeconds"])
    def volumes(items):
        for item in items:
            if item.get("label") == settings["bootselLabel"]:
                mounts[item["path"]] = next((x for x in item.get("mountpoints", []) if x), None)
            volumes(item.get("children", []))
    volumes(json.loads(result.stdout)["blockdevices"])
    for mode, directory, product in (("runtime", "ttyDirectory", "runtimeProductId"),
                                      ("bootsel", "blockDirectory", "bootselProductId")):
        for entry in Path(settings[directory]).iterdir():
            parent = usb_parent(entry / "device")
            if parent is None or (parent / "idVendor").read_text().strip().lower() != settings["vendorId"] \
                    or (parent / "idProduct").read_text().strip().lower() != settings[product]:
                continue
            serial_file = parent / "serial"
            serial = serial_file.read_text().strip().lower() if serial_file.is_file() else None
            if mode == "runtime" and (serial is None or not re.fullmatch(r"[a-f0-9]{16}", serial)):
                continue
            device = Path(settings["deviceDirectory"]) / entry.name
            if not device.exists() or (mode == "bootsel" and str(device) not in mounts):
                continue
            port = device
            serial_dir = Path(settings["serialDirectory"])
            if mode == "runtime" and serial_dir.exists():
                for candidate in serial_dir.iterdir():
                    if candidate.resolve() == device.resolve():
                        port = candidate
                        break
            identity = serial or parent.name
            target_id = mode + "-" + hashlib.sha256(identity.encode()).hexdigest()
            mount = mounts.get(str(device))
            available = os.access(port, os.R_OK | os.W_OK) if mode == "runtime" else \
                (not mount or os.access(mount, os.W_OK | os.X_OK))
            target = {"id": target_id, "name": "Pico " + identity, "mode": mode,
                      "uniqueId": serial if mode == "runtime" else None,
                      "description": "MicroPython over USB" if mode == "runtime" else
                      "BOOTSEL · runtime identity is checked after firmware returns",
                      "available": available, "unavailableReason": None if available else
                      "Grant the hub user serial access or a writable BOOTSEL mount, then refresh.",
                      "latestRunId": None}
            if private:
                target.update({"port": str(port), "device": str(device), "mount": mount, "usbLocation": parent.name})
            targets[target_id] = target
    return [targets[key] for key in sorted(targets)]


def helpers(config):
    directory = str(ROOT / config["benchScripts"])
    if directory not in sys.path:
        sys.path.insert(0, directory)
    return importlib.import_module("setup_wifi"), importlib.import_module("setup_pico")


def installed_wifi(installed):
    config = installed["config"]
    transport_key = "transport" if installed["configFile"] == WIFI_CONFIG_FILE else "wifi_transport"
    wifi = {"ssid": config.get("wifi_ssid"), "password": config.get("wifi_password"),
            "transport": config.get(transport_key)}
    if (not isinstance(wifi["ssid"], str) or not 1 <= len(wifi["ssid"].encode()) <= SSID_MAX_BYTES
            or not isinstance(wifi["password"], str) or len(wifi["password"].encode()) > PASSWORD_MAX_BYTES
            or wifi["transport"] not in ("native", "esp8285")
            or any(c in wifi["ssid"] + wifi["password"] for c in ("\r", "\n", "\x00"))):
        return None
    return wifi


def installed_state(installed, config):
    wifi = installed_wifi(installed)
    selected = installed["features"]
    if selected is None:
        selected = ["wifi"] if wifi else []
        if wifi and installed["configFile"] == DEVICE_CONFIG_FILE and installed["config"].get("token"):
            selected.append("health")
            if "stream.py" in installed["files"]:
                selected.append("i2c")
    if not isinstance(selected, list) or any(not isinstance(x, str) for x in selected):
        raise ImageError("The installed image manifest is invalid")
    return {"features": [x["id"] for x in config["features"] if x["id"] in selected],
            "wifi": {"ssid": wifi["ssid"], "transport": wifi["transport"]} if wifi else None}


def prepare(output, request, config, device_config=None, certificate=None):
    request = validate_request(request, config)
    if request["wifi"] is not None and request["wifi"]["password"] is None:
        raise ImageError("Saved Wi-Fi settings must be read from the selected Pico before preparation")
    wifi, setup = helpers(config)
    module = setup.provisioner()
    output.mkdir(mode=0o700, parents=True)
    image = {"features": request["features"], "installId": uuid.uuid4().hex}
    private_json(output / IMAGE_FILE, image)
    private_json(output / "image_settings.json", config["telemetry"])
    shutil.copyfile(FIRMWARE / "main.py", output / "main.py")
    shutil.copyfile(FIRMWARE / "image_status.py", output / "image_status.py")
    if "fan" in request["features"]:
        private_json(output / "fan_settings.json", config["fan"])
        shutil.copyfile(FIRMWARE / "fan.py", output / "fan.py")
    if "wifi" in request["features"]:
        runtime = json.loads(module.STREAM_SETTINGS.read_text())
        runtime["maxDataBytes"] = json.loads((module.FIRMWARE.parents[2] / "settings.json").read_text())["i2c"]["maxDataBytes"]
        selected = request["wifi"]
        private_json(output / DEVICE_CONFIG_FILE, {"wifi_ssid": selected["ssid"],
                     "wifi_password": selected["password"], "wifi_transport": selected["transport"],
                     **({"runtime": runtime} if "health" not in request["features"] else {}),
                     **(device_config or {})})
        if selected["transport"] == "esp8285":
            shutil.copyfile(module.ESP_FIRMWARE, output / "esp8285.py")
        if "health" in request["features"]:
            shutil.copyfile(module.FIRMWARE, output / "health.py")
            private_json(output / "stream.json", runtime)
            if "i2c" in request["features"]:
                shutil.copyfile(module.STREAM_FIRMWARE, output / "stream.py")
            if certificate is not None:
                module.private_write(output / "health_ca.der", certificate)
    for file in output.iterdir():
        file.chmod(0o600)
    return image


class Host:
    """The USB host's concrete imaging operations."""
    def __init__(self, config):
        self.config = config
        self.wifi, self.setup = helpers(config)
        self.env = None
        self.client = None
        self.root = None
        self.console_port = None
        self.console_uid = None

    def stage(self, emit, stage, message):
        emit({"type": "stage", "stage": stage, "message": message, "runtimeTargetId": None})

    def bootstrap(self, directory):
        self.env = self.wifi.install_tools(directory / "tools")

    def usb(self, port, *args):
        result = subprocess.run([sys.executable, "-m", "mpremote", "connect", port, *args],
                                env=self.env, capture_output=True, timeout=self.config["usbTimeoutSeconds"])
        if result.returncode:
            raise ImageError("USB operation failed; check board access and console responsiveness")
        return result.stdout

    def inspect(self, port):
        output = self.usb(port, "resume", "exec", f"""import machine,binascii,json,os
files=os.listdir()
config_file={DEVICE_CONFIG_FILE!r} if {DEVICE_CONFIG_FILE!r} in files else {WIFI_CONFIG_FILE!r} if {WIFI_CONFIG_FILE!r} in files else None
c=json.load(open(config_file)) if config_file else {{}}
features=json.load(open({IMAGE_FILE!r}))['features'] if {IMAGE_FILE!r} in files else None
print('JOMAA_IMAGE:'+json.dumps({{'uniqueId':binascii.hexlify(machine.unique_id()).decode(),'config':c,'configFile':config_file,'features':features,'files':files}}))
""")
        for line in output.splitlines():
            if line.startswith(MARKER):
                value = json.loads(line[len(MARKER):])
                if "config" in value:
                    return value
        raise ImageError("The selected board did not return its USB identity")

    def authenticate(self):
        declaration = json.loads((ROOT / self.config["hubDeploy"]).read_text())
        self.origin = "https://" + declaration["routes"][0]["hostname"]
        password = os.environ.get("HUB_PASSWORD")
        if not password:
            raise ImageError("HUB_PASSWORD is not available to the imaging process")
        trusted = self.config["trustedCaFile"]
        if trusted:
            self.root = self.setup.provisioner().certificate(Path(trusted))
        else:
            try:
                self.root = self.setup.trusted_root(self.origin)
            except AttributeError:
                raise ImageError("Set trustedCaFile to a trusted root CA, or run imaging with Python 3.13 or newer") from None
        self.client = self.setup.Hub(self.origin, self.root, password)

    def mount(self, device, mounted):
        if not mounted:
            subprocess.run([*self.config["discovery"]["mountCommand"], device],
                           capture_output=True, check=True, timeout=self.config["commandTimeoutSeconds"])
            mounted = next((target["mount"] for target in discover(self.config, private=True)
                            if target["device"] == device), None)
        if not mounted or not os.access(mounted, os.W_OK | os.X_OK):
            raise ImageError("Mount the selected BOOTSEL volume with write access for the hub user, then retry")
        return Path(mounted)

    def reimage(self, target, request, directory, emit):
        self.bootstrap(directory)
        old_config = {}
        uid = target["uniqueId"]
        existing = self.wifi.ports()
        if uid:
            inspected = self.inspect(target["port"])
            if inspected["uniqueId"] != uid:
                raise ImageError("Selected USB identity changed; its filesystem was preserved")
            self.console_port = target["port"]
            self.console_uid = uid
            old_config = inspected["config"]
            if request["wifi"] is not None and request["wifi"]["password"] is None:
                saved = installed_wifi(inspected)
                if saved is None or any(saved[key] != request["wifi"][key] for key in ("ssid", "transport")):
                    raise ImageError("Saved Wi-Fi settings changed or are unavailable; reopen the Pico panel")
                request = validate_request({**request, "wifi": saved}, self.config)
            existing.pop(uid, None)
        elif request["wifi"] is not None and request["wifi"]["password"] is None:
            raise ImageError("Saved Wi-Fi settings require a Pico running MicroPython")
        if "health" in request["features"]:
            self.authenticate()
            if uid:
                self.credential(uid, old_config)
        self.stage(emit, "firmware", "Downloading and validating MicroPython firmware")
        payload = self.wifi.download(self.wifi.FIRMWARE_URL)
        self.wifi.validate_firmware(payload)
        connected = discover(self.config, private=True)
        bootsel = [x for x in connected if x["mode"] == "bootsel"]
        if target["mode"] == "runtime":
            current = next((x for x in connected if x["id"] == target["id"]), None)
            if current is None:
                raise ImageError("The selected Pico disconnected before BOOTSEL; no firmware was written")
            target = current
            if bootsel:
                raise ImageError("Disconnect other BOOTSEL boards before flashing this runtime Pico")
            self.wifi.enter_bootsel(target["port"], timeout=self.config["returnTimeoutSeconds"])
            self.console_port = None
            bootsel = [x for x in discover(self.config, private=True) if x["mode"] == "bootsel"]
        if len(bootsel) != 1 or (target["mode"] == "bootsel" and bootsel[0]["id"] != target["id"]):
            raise ImageError("Connect exactly the selected BOOTSEL board; multiple targets cannot be flashed safely")
        volume = self.mount(bootsel[0]["device"], bootsel[0]["mount"])
        self.stage(emit, "flashing", "Writing verified firmware to the selected Pico")
        self.wifi.flash(volume, payload)
        returned_uid, port = self.wifi.returning_port(existing, timeout=self.config["returnTimeoutSeconds"])
        if uid is not None and returned_uid != uid:
            raise ImageError("Returning USB identity did not match; its console and filesystem were preserved")
        if target["mode"] == "bootsel":
            returned = next((x for x in discover(self.config, private=True) if x["uniqueId"] == returned_uid), None)
            if returned is None or returned["usbLocation"] != target["usbLocation"]:
                raise ImageError("The runtime Pico returned on a different USB connection; its filesystem was preserved")
        actual = self.inspect(port)
        if actual["uniqueId"] != returned_uid:
            raise ImageError("Returning Pico identity did not match; its filesystem was preserved")
        uid = returned_uid
        self.console_port = port
        self.console_uid = uid
        emit({"type": "stage", "stage": "returned", "message": "Selected Pico returned with its runtime identity",
              "runtimeTargetId": "runtime-" + hashlib.sha256(uid.encode()).hexdigest()})
        installed = old_config if target["mode"] == "runtime" else actual["config"]
        device_config = self.credential(uid, installed) if "health" in request["features"] else None
        self.stage(emit, "installing", "Erasing the selected filesystem and installing startup functions")
        self.usb(port, "resume", "exec", "import vfs,rp2; vfs.umount('/'); bdev=rp2.Flash(); "
                 "vfs.VfsLfs2.mkfs(bdev,progsize=256); vfs.mount(vfs.VfsLfs2(bdev,progsize=256),'/')")
        output = directory / "prepared"
        image = prepare(output, request, self.config, device_config, self.root)
        for file in sorted(output.iterdir(), key=lambda file: file.name == "main.py"):
            self.usb(port, "resume", "fs", "cp", str(file), ":" + file.name)
        self.stage(emit, "testing", "Restarting the installed image and observing its functions")
        baseline = self.baseline(device_config["id"]) if device_config else None
        self.usb(port, "resume", "reset")
        self.console_port = None
        self.verify(port, uid, image, request, baseline, emit)

    def credential(self, uid, installed):
        origin = self.setup.provisioner().hub_origin(self.origin)
        device_id = installed.get("id") or "pico-" + uid
        if not isinstance(device_id, str) or not re.fullmatch(r"[a-z0-9][a-z0-9_-]{2,63}", device_id):
            raise ImageError("The installed device ID is invalid; restore a valid configuration before imaging")
        existing = next((d for d in self.client.request("/api/devices")["devices"] if d["id"] == device_id), None)
        if existing is not None:
            if (installed.get("id") != device_id or installed.get("hub_host") != origin.hostname
                    or installed.get("hub_port") != (origin.port or 443)
                    or not isinstance(installed.get("token"), str) or not re.fullmatch(r"[a-f0-9]{64}", installed["token"])
                    or existing["status"] == "revoked"):
                raise ImageError("This Pico's hub credential cannot be reused. Replace its credential explicitly before imaging")
            token = installed["token"]
        else:
            issued = self.client.request("/api/devices/enroll", {"id": device_id, "name": "Pico " + uid,
                                          "intervalSeconds": self.config["healthIntervalSeconds"]})
            token = issued["token"]
            installed.update({"id": device_id, "token": token,
                              "hub_host": origin.hostname, "hub_port": origin.port or 443})
        self.client.request("/api/devices/" + device_id, {"name": existing["name"] if existing else "Pico " + uid,
                            "intervalSeconds": self.config["healthIntervalSeconds"]}, method="PATCH")
        return {"id": device_id, "token": token, "hub_host": origin.hostname, "hub_port": origin.port or 443,
                "interval_seconds": self.config["healthIntervalSeconds"], "ca_file": "health_ca.der"}

    def baseline(self, device_id):
        path = "/api/devices/" + device_id
        logs = self.client.request(path + "/logs")["logs"]
        captures = self.client.request(path + "/i2c")["logs"]
        return {"id": device_id, "health": max((x["id"] for x in logs), default=0),
                "captures": {(x["bootId"], x["bus"]): x["sequence"] for x in captures}}

    def verify(self, port, uid, image, request, baseline, emit):
        import serial
        remaining = set(request["features"])
        for feature in request["features"]:
            emit({"type": "check", "check": {"feature": feature, "status": "running", "message": "Waiting for observations after reset", "evidence": None}})
        deadline = time.monotonic() + self.config["verificationSeconds"]
        buffer = b""
        observed = None
        last_hub_poll = 0
        def passed(feature, message, evidence):
            if feature in remaining:
                remaining.remove(feature)
                emit({"type": "check", "check": {"feature": feature, "status": "passed", "message": message, "evidence": evidence}})
        with contextlib.ExitStack() as connections:
            connection = None
            while time.monotonic() < deadline:
                try:
                    if connection is None:
                        connection = connections.enter_context(serial.Serial(port, self.config["telemetry"]["baud"],
                            timeout=self.config["pollMilliseconds"] / 1000))
                    buffer += connection.read(connection.in_waiting or 1)
                except OSError:
                    connections.close()
                    connection = None
                    buffer = b""
                    time.sleep(self.config["pollMilliseconds"] / 1000)
                    continue
                if len(buffer) > self.config["maxOutputBytes"]:
                    raise ImageError("USB observation exceeded its configured output limit")
                while b"\n" in buffer:
                    line, buffer = buffer.split(b"\n", 1)
                    if not line.strip().startswith(MARKER):
                        continue
                    try:
                        status = json.loads(line.strip()[len(MARKER):])
                    except ValueError:
                        continue
                    if status.get("installId") != image["installId"]:
                        continue
                    if status.get("uniqueId") != uid or status.get("features") != image["features"]:
                        raise ImageError("The running image identity or selected functionality did not match")
                    if observed is not None and observed["bootId"] != status["bootId"]:
                        raise ImageError("The installed image restarted during verification")
                    observed = status
                    if "wifi" in remaining:
                        try:
                            ip = ipaddress.ip_address(status.get("ip", ""))
                            if not ip.is_unspecified and not ip.is_loopback:
                                passed("wifi", "The selected radio connected after reset", {"transport": request["wifi"]["transport"], "ip": str(ip)})
                        except ValueError:
                            pass
                    temperature = status.get("celsius")
                    if "temperature" in remaining and type(temperature) in (int, float) and math.isfinite(temperature):
                        passed("temperature", "A temperature sample arrived from the installed image", {"celsius": temperature})
                now = time.monotonic()
                if observed is not None and baseline and now - last_hub_poll >= self.config["pollMilliseconds"] / 1000:
                    last_hub_poll = now
                    path = "/api/devices/" + baseline["id"]
                    if "health" in remaining:
                        logs = self.client.request(path + "/logs")["logs"]
                        reports = {x["heartbeat"]["sequence"] for x in logs if x["id"] > baseline["health"]
                                   and x["heartbeat"]["bootId"] == observed["bootId"]
                                   and x["heartbeat"].get("ip") not in (None, "", "0.0.0.0")
                                   and x["heartbeat"].get("freeHeapBytes", 0) > 0}
                        if len(reports) >= self.config["healthReports"]:
                            device = self.client.request(path)["device"]
                            if device["status"] == "revoked":
                                raise ImageError("The device credential was revoked during verification")
                            if device["status"] in ("online", "degraded") and (device.get("latest") or {}).get("bootId") == observed["bootId"]:
                                passed("health", "New heartbeats from one boot persisted in the hub", {"deviceId": baseline["id"], "bootId": observed["bootId"], "reports": len(reports)})
                    if "i2c" in remaining:
                        captures = self.client.request(path + "/i2c")["logs"]
                        capture = next((x for x in captures if x["bootId"] == observed["bootId"] and
                                        x["sequence"] > baseline["captures"].get((x["bootId"], x["bus"]), -1)), None)
                        if capture and capture["dropped"] == 0:
                            passed("i2c", "Raw bytes persisted" if capture["data"] else "Capture persisted; no responding I²C devices", {"deviceId": baseline["id"], "bootId": capture["bootId"], "sequence": capture["sequence"], "bytes": len(capture["data"]) // 2, "dropped": capture["dropped"]})
                    if "fan" in remaining:
                        pwm = observed.get("fan") or {}
                        if pwm.get("appliedRevision") is not None:
                            fan = self.client.request(path + "/fan")["fan"]
                            report = fan["report"]
                            if (fan["available"] and not fan["pending"]
                                    and report["bootId"] == observed["bootId"]
                                    and report["installId"] == image["installId"]
                                    and pwm["gpio"] == self.config["fan"]["gpio"]
                                    and pwm["inverted"] == self.config["fan"]["inverted"]
                                    and all(pwm[key] == report[key] for key in
                                        ("gpio", "frequencyHz", "inverted", "percentCurrent", "appliedRevision"))):
                                passed("fan", "PWM peripheral readback and hub command acknowledgment matched",
                                       {"deviceId": baseline["id"], "bootId": report["bootId"],
                                        "gpio": report["gpio"], "frequencyHz": report["frequencyHz"],
                                        "percentCurrent": report["percentCurrent"], "appliedRevision": report["appliedRevision"]})
                if observed is not None and not remaining:
                    return
        for feature in request["features"]:
            if feature in remaining:
                emit({"type": "check", "check": {"feature": feature, "status": "failed", "message": "No successful observation before the verification deadline", "evidence": None}})
        raise ImageError("Image verification did not complete before its deadline")


@contextlib.contextmanager
def usb_lock(config):
    lock_path = ROOT / config["lockFile"]
    lock_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with os.fdopen(os.open(lock_path, os.O_WRONLY | os.O_CREAT, 0o600), "w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ImageError("Another USB imaging operation is active on this host") from None
        yield


def inspect_state(target_id, config, host=None):
    with usb_lock(config):
        target = next((x for x in discover(config, private=True) if x["id"] == target_id), None)
        if target is None:
            raise ImageError("The selected Pico is no longer connected")
        if target["mode"] == "bootsel" or not target["available"]:
            return {"features": [], "wifi": None}
        directory = ROOT / config["runDirectory"]
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        host = host or Host(config)
        with tempfile.TemporaryDirectory(dir=directory) as temporary:
            host.bootstrap(Path(temporary))
            try:
                installed = host.inspect(target["port"])
                if installed["uniqueId"] != target["uniqueId"]:
                    raise ImageError("Selected USB identity changed; refresh the USB inventory")
                return installed_state(installed, config)
            finally:
                connected = host.wifi.ports().get(target["uniqueId"])
                if connected:
                    host.usb(host.wifi.stable_port(target["uniqueId"], connected), "resume", "reset")


def execute(target_id, request, config, emit, host=None):
    request = validate_request(request, config)
    with usb_lock(config):
        _execute_locked(target_id, request, config, emit, host)


def _execute_locked(target_id, request, config, emit, host):
    targets = discover(config, private=True)
    target = next((x for x in targets if x["id"] == target_id), None)
    if target is None:
        raise ImageError("The selected Pico is no longer connected")
    if not target["available"]:
        raise ImageError(target["unavailableReason"])
    if len([x for x in targets if x["mode"] == "bootsel"]) > 1:
        raise ImageError("Disconnect other BOOTSEL boards before imaging")
    directory = ROOT / config["runDirectory"] / uuid.uuid4().hex
    directory.mkdir(parents=True, mode=0o700)
    host = host or Host(config)
    try:
        host.reimage(target, request, directory, emit)
    except Exception:
        if host.console_port:
            try:
                connected = host.wifi.ports().get(host.console_uid)
                if connected:
                    host.usb(host.wifi.stable_port(host.console_uid, connected), "resume", "reset")
            except Exception:
                pass
        raise


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("catalog", "discover", "state", "prepare", "flash"))
    parser.add_argument("--config", type=Path, default=CONFIG_FILE)
    parser.add_argument("--target")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args(argv)
    def emit(value):
        print(json.dumps(value, allow_nan=False), flush=True)
    try:
        config = load_config(args.config)
        if args.action == "catalog":
            emit({"features": config["features"], "defaultWifiTransport": config["defaultWifiTransport"]})
        elif args.action == "discover":
            emit({"targets": discover(config)})
        elif args.action == "state":
            if not args.target:
                raise ImageError("Select a Pico target")
            emit(inspect_state(args.target, config))
        else:
            raw = sys.stdin.buffer.read(config["maxRequestBytes"] + 1)
            if len(raw) > config["maxRequestBytes"]:
                raise ImageError("Image request exceeded its configured size limit")
            request = validate_request(json.loads(raw), config)
            if args.action == "prepare":
                if args.output is None or args.output.exists():
                    raise ImageError("Select a new output directory")
                emit({"features": prepare(args.output, request, config)["features"]})
            else:
                if not args.target:
                    raise ImageError("Select a Pico target")
                execute(args.target, request, config, emit)
                emit({"type": "result", "status": "passed", "message": "Installed startup and every selected function verified"})
        return 0
    except Exception as error:
        message = str(error) if isinstance(error, ImageError) else "Imaging failed; check USB access, trusted firmware, TLS, and host dependencies"
        if args.action == "flash":
            emit({"type": "result", "status": "failed", "message": message})
        else:
            print(json.dumps({"error": message}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Flash one BOOTSEL Pico and set up Wi-Fi using only Python 3 and internet access."""
from __future__ import annotations

import argparse
import contextlib
import getpass
import hashlib
import io
import json
import os
from pathlib import Path
import plistlib
import struct
import subprocess
import sys
import tempfile
import time
import urllib.request
import zipfile

FIRMWARE_URL = "https://micropython.org/resources/firmware/RPI_PICO_W-20260824-v1.29.0.uf2"
FIRMWARE_SHA256 = "f918c0a082c6daf53e27998b7f990ba5f065db2e298b21a34024532a20786794"
PACKAGES = {"mpremote": "1.29.0", "pyserial": "3.5", "platformdirs": "4.14.5"}

BOOT = r'''import json
import time

with open("wifi_config.json") as source:
    config = json.load(source)

try:
    if config["transport"] == "esp8285":
        from machine import UART
        uart = UART(0, 115200, timeout=0, rxbuf=4096)

        def command(value, timeout=5):
            while uart.any():
                uart.read()
            uart.write(value + "\r\n")
            response = b""
            start = time.ticks_ms()
            while time.ticks_diff(time.ticks_ms(), start) < timeout * 1000:
                part = uart.read()
                if part:
                    response += part
                    if b"\r\nOK\r\n" in response:
                        return response
                    if b"\r\nERROR\r\n" in response or b"\r\nFAIL\r\n" in response:
                        raise OSError("radio command failed")
                    if len(response) > 8192:
                        raise OSError("radio response too large")
                time.sleep_ms(10)
            raise OSError("radio command timed out")

        def quoted(value):
            if any(c in value for c in ("\r", "\n", "\x00")):
                raise ValueError("invalid Wi-Fi setting")
            return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'

        time.sleep_ms(1100)
        uart.write(b"+++")
        time.sleep_ms(1100)
        uart.write(b"\r\n")
        time.sleep_ms(100)
        command("AT")
        command("ATE0")
        command("AT+CIPMODE=0")
        try:
            command("AT+CIPCLOSE", 3)
        except OSError:
            pass
        command("AT+CWMODE_CUR=1")
        join = "AT+CWJAP_CUR=%s,%s" % (quoted(config["wifi_ssid"]), quoted(config["wifi_password"]))
        try:
            command(join, 30)
        except OSError:
            command("AT+RST")
            time.sleep(3)
            command("ATE0")
            command("AT+CWMODE_CUR=1")
            command(join, 30)
        response = command("AT+CIFSR").decode("utf-8", "replace")
        address = ""
        for line in response.splitlines():
            if "STAIP," in line:
                address = line.split("STAIP,", 1)[1].strip().strip('"')
    else:
        import network
        wifi = network.WLAN(network.STA_IF)
        wifi.active(True)
        wifi.connect(config["wifi_ssid"], config["wifi_password"])
        start = time.ticks_ms()
        while not wifi.isconnected() and time.ticks_diff(time.ticks_ms(), start) < 30000:
            time.sleep_ms(200)
        address = wifi.ifconfig()[0] if wifi.isconnected() else ""
    if not address or address == "0.0.0.0":
        raise OSError("Wi-Fi has no address")
    print("JOMAA_WIFI_READY:" + address)
except Exception:
    print("JOMAA_WIFI_FAILED")
'''


class SetupError(Exception):
    pass


def download(url):
    request = urllib.request.Request(url, headers={"User-Agent": "jomaa-pico-setup/1.0"})
    with urllib.request.urlopen(request, timeout=45) as response:
        return response.read()


def install_tools(target):
    target.mkdir(mode=0o700)
    for package, version in PACKAGES.items():
        metadata = json.loads(download("https://pypi.org/pypi/%s/%s/json" % (package, version)))
        wheels = [item for item in metadata["urls"] if item["filename"].endswith("-none-any.whl")]
        if len(wheels) != 1:
            raise SetupError("could not find a portable wheel for " + package)
        wheel = wheels[0]
        payload = download(wheel["url"])
        if hashlib.sha256(payload).hexdigest() != wheel["digests"]["sha256"]:
            raise SetupError("USB tool download failed its SHA-256 check")
        with zipfile.ZipFile(io.BytesIO(payload)) as archive:
            for member in archive.infolist():
                name = Path(member.filename)
                if name.is_absolute() or ".." in name.parts or ".data" in name.parts or (member.external_attr >> 16) & 0o170000 == 0o120000:
                    raise SetupError("unsafe USB tool archive")
            archive.extractall(target)
    sys.path.insert(0, str(target))
    env = os.environ.copy()
    env["PYTHONPATH"] = str(target)
    return env


def validate_firmware(payload):
    if hashlib.sha256(payload).hexdigest() != FIRMWARE_SHA256:
        raise SetupError("firmware failed its trusted SHA-256 check")
    if not payload or len(payload) % 512:
        raise SetupError("invalid firmware length")
    count = len(payload) // 512
    numbers, addresses = set(), []
    for offset in range(0, len(payload), 512):
        magic0, magic1, flags, address, size, number, total, family = struct.unpack_from("<8I", payload, offset)
        end = struct.unpack_from("<I", payload, offset + 508)[0]
        if ((magic0, magic1, end) != (0x0A324655, 0x9E5D5157, 0x0AB16F30) or flags != 0x2000
                or family != 0xE48BFF56 or not 0 < size <= 476 or total != count or number >= count
                or number in numbers or address < 0x10000000 or address + size > 0x11000000):
            raise SetupError("invalid RP2040 firmware block")
        numbers.add(number)
        addresses.append((address, address + size))
    addresses.sort()
    if any(left[1] > right[0] for left, right in zip(addresses, addresses[1:])):
        raise SetupError("overlapping firmware blocks")


def command(args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, **kwargs)


def linux_volumes():
    result = json.loads(command(["lsblk", "--json", "--paths", "--output", "PATH,LABEL,MOUNTPOINTS"]).stdout)
    found = []
    def visit(items):
        for item in items:
            if item.get("label") == "RPI-RP2":
                mounts = [x for x in item.get("mountpoints", []) if x]
                found.append((item["path"], mounts[0] if mounts else None))
            visit(item.get("children", []))
    visit(result["blockdevices"])
    return found


def mac_volumes():
    disks = plistlib.loads(command(["diskutil", "list", "-plist"]).stdout)
    found = []
    for disk in disks.get("AllDisksAndPartitions", []):
        for part in disk.get("Partitions", []):
            device = "/dev/" + part["DeviceIdentifier"]
            info = plistlib.loads(command(["diskutil", "info", "-plist", device]).stdout)
            if info.get("VolumeName") == "RPI-RP2":
                found.append((device, info.get("MountPoint") or None))
    return found


def bootsel_volumes():
    return linux_volumes() if sys.platform.startswith("linux") else mac_volumes() if sys.platform == "darwin" else []


def find_bootsel():
    volumes = bootsel_volumes()
    if len(volumes) != 1:
        raise SetupError("connect exactly one RP2040 Pico in BOOTSEL mode")
    return volumes[0]


def mount_bootsel(device, mounted, directory):
    if mounted:
        mountpoint = Path(mounted)
        if not os.access(mountpoint, os.W_OK | os.X_OK):
            raise SetupError("BOOTSEL volume is not writable: %s; mount it with access for your user" % mountpoint)
        return mountpoint, False
    if sys.platform.startswith("linux"):
        if os.geteuid() != 0:
            try:
                command(["udisksctl", "mount", "--block-device", device, "--no-user-interaction"], timeout=15)
            except (OSError, subprocess.SubprocessError):
                if not sys.stdin.isatty():
                    raise SetupError("cannot mount BOOTSEL device %s as this user; run from an interactive terminal for mount authentication or supply a writable mount" % device) from None
                mountpoint = directory / "bootsel"
                mountpoint.mkdir()
                print("Administrator authentication is needed to mount the selected BOOTSEL device.", flush=True)
                try:
                    subprocess.run(["sudo", "mount", "-t", "vfat", "-o",
                                    "uid=%d,gid=%d" % (os.getuid(), os.getgid()), device, str(mountpoint)],
                                   check=True, timeout=120)
                except (OSError, subprocess.SubprocessError):
                    raise SetupError("could not mount the selected BOOTSEL device") from None
                return mountpoint, True
            mounts = [path for found, path in linux_volumes() if found == device and path]
            if len(mounts) != 1 or not os.access(mounts[0], os.W_OK | os.X_OK):
                raise SetupError("BOOTSEL device was not mounted with user write access")
            return Path(mounts[0]), True
        mountpoint = directory / "bootsel"
        mountpoint.mkdir()
        try:
            command(["mount", "-t", "vfat", device, str(mountpoint)])
        except subprocess.CalledProcessError:
            raise SetupError("cannot mount BOOTSEL volume; run with administrator privileges") from None
    else:
        command(["diskutil", "mount", device])
        info = plistlib.loads(command(["diskutil", "info", "-plist", device]).stdout)
        mountpoint = Path(info["MountPoint"])
    return mountpoint, True


def unmount_bootsel(device, volume):
    try:
        if sys.platform == "linux" and os.geteuid() != 0:
            try:
                command(["udisksctl", "unmount", "--block-device", device, "--no-user-interaction"], timeout=10)
            except (OSError, subprocess.SubprocessError):
                command(["sudo", "-n", "umount", str(volume)], timeout=10)
        else:
            command(["umount", str(volume)] if sys.platform == "linux" else ["diskutil", "unmount", str(volume)], timeout=10)
    except (OSError, subprocess.SubprocessError):
        pass


def ports():
    from serial.tools import list_ports
    return {p.serial_number: p.device for p in list_ports.comports()
            if p.vid == 0x2E8A and p.pid == 0x0005 and p.serial_number}


def stable_port(serial_number, port):
    if sys.platform.startswith("linux"):
        for path in Path("/dev/serial/by-id").glob("*"):
            if serial_number.lower() in path.name.lower() and path.resolve() == Path(port).resolve():
                return str(path)
    return port


def require_serial_access(port):
    if not Path(port).exists():
        raise SetupError("serial port is not connected: %s" % port)
    if not os.access(port, os.R_OK | os.W_OK):
        raise SetupError("serial port is not readable and writable: %s; use a login with the device's serial group active" % port)


def usb(env, port, *args):
    require_serial_access(port)
    result = subprocess.run([sys.executable, "-m", "mpremote", "connect", port, *args],
                            env=env, capture_output=True, timeout=60)
    if result.returncode:
        raise SetupError("USB operation failed for %s; check device permissions" % port)
    return result.stdout


def usb_json(env, port, code):
    output = usb(env, port, "resume", "exec", code)
    for line in output.splitlines():
        if line.startswith(b"JOMAA_SETUP:"):
            return json.loads(line[len(b"JOMAA_SETUP:"):])
    raise SetupError("Pico did not return its inspection result")


def reset(env, port):
    usb(env, port, "reset")


def target_identity(env, requested, existing):
    matches = [(uid, port) for uid, port in existing.items()
               if Path(port).resolve() == Path(requested).resolve()]
    if len(matches) != 1:
        raise SetupError("selected port must identify one connected MicroPython Pico")
    uid, port = matches[0]
    info = usb_json(env, requested, "import machine,binascii,json; "
                    "print('JOMAA_SETUP:'+json.dumps({'uid':binascii.hexlify(machine.unique_id()).decode()}))")
    if info["uid"] != uid:
        raise SetupError("target serial identity does not match its MicroPython identity")
    return uid


def enter_bootsel(port, timeout=15):
    if bootsel_volumes():
        raise SetupError("disconnect other BOOTSEL Picos before using target-port")
    from mpremote.transport_serial import SerialTransport
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            connection = SerialTransport(port)
            try:
                connection.enter_raw_repl(soft_reset=False)
                connection.exec_raw_no_follow("import machine; machine.bootloader()")
            finally:
                try:
                    connection.close()
                except OSError:
                    connection.serial.close()
    except Exception:
        raise SetupError("could not put the selected Pico into BOOTSEL") from None
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        volumes = bootsel_volumes()
        if len(volumes) == 1:
            return volumes[0]
        if len(volumes) > 1:
            raise SetupError("multiple BOOTSEL Picos appeared")
        time.sleep(0.25)
    raise SetupError("selected Pico did not appear as a BOOTSEL volume")


def get_wifi(env, existing, transport):
    if len(existing) > 1:
        raise SetupError("connect at most one configured MicroPython Pico when copying Wi-Fi")
    if existing:
        port = next(iter(existing.values()))
        code = ("import os,json,machine,binascii; p='wifi_config.json' if 'wifi_config.json' in os.listdir() else 'device_config.json'; c=json.load(open(p)); "
                "print('JOMAA_SETUP:'+json.dumps({'ssid':c['wifi_ssid'],'password':c['wifi_password'],"
                "'uid':binascii.hexlify(machine.unique_id()).decode()}))")
        try:
            data = usb_json(env, port, code)
        finally:
            reset(env, port)
        print("Copied Wi-Fi settings from the existing Pico; it was restarted.", flush=True)
    else:
        data = {"ssid": input("Wi-Fi network name: "), "password": getpass.getpass("Wi-Fi password: "), "uid": None}
    if not isinstance(data.get("ssid"), str) or not data["ssid"] or not isinstance(data.get("password"), str):
        raise SetupError("invalid Wi-Fi settings")
    return {"wifi_ssid": data["ssid"], "wifi_password": data["password"], "transport": transport}, data["uid"]


def flash(volume, payload):
    info = volume / "INFO_UF2.TXT"
    if not info.is_file() or info.is_symlink():
        raise SetupError("selected volume is not an RP2040 BOOTSEL volume")
    description = info.read_text().upper()
    if "RPI-RP2" not in description or "RP2350" in description:
        raise SetupError("selected volume is not an RP2040 BOOTSEL volume")
    destination = volume / "firmware.uf2"
    if destination.is_symlink():
        raise SetupError("invalid firmware destination")
    with destination.open("wb") as output:
        output.write(payload)
        output.flush()
        os.fsync(output.fileno())


def returning_port(existing, timeout=60):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        new = {uid: path for uid, path in ports().items() if uid not in existing}
        if len(new) == 1:
            serial_number, port = next(iter(new.items()))
            return serial_number, stable_port(serial_number, port)
        if len(new) > 1:
            raise SetupError("multiple new serial devices appeared; cannot identify the flashed Pico")
        time.sleep(0.25)
    raise SetupError("the flashed Pico did not return as a MicroPython serial device")


def provision(env, port, source_uid, expected_uid, config, directory):
    identity = "import machine,binascii,json; print('JOMAA_SETUP:'+json.dumps({'uid':binascii.hexlify(machine.unique_id()).decode()}))"
    uid = usb_json(env, port, identity)["uid"]
    if uid == source_uid:
        raise SetupError("target is the existing Pico; its files were preserved")
    if expected_uid is not None and uid != expected_uid:
        raise SetupError("returning Pico is not the selected target; its files were preserved")
    erase = ("import vfs,rp2; vfs.umount('/'); bdev=rp2.Flash(); "
             "vfs.VfsLfs2.mkfs(bdev,progsize=256); vfs.mount(vfs.VfsLfs2(bdev,progsize=256),'/')")
    usb(env, port, "resume", "exec", erase)
    config_file = directory / "wifi_config.json"
    fd = os.open(config_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as output:
        json.dump(config, output)
    boot_file = directory / "main.py"
    boot_file.write_text(BOOT)
    usb(env, port, "resume", "fs", "cp", str(config_file), ":wifi_config.json")
    usb(env, port, "resume", "fs", "cp", str(boot_file), ":main.py")
    return uid


def wait_for_wifi(serial_number, timeout=120):
    import serial
    deadline = time.monotonic() + timeout
    buffer = b""
    while time.monotonic() < deadline:
        port = ports().get(serial_number)
        if not port:
            time.sleep(0.25)
            continue
        try:
            with serial.Serial(port, 115200, timeout=1) as connection:
                while time.monotonic() < deadline:
                    buffer += connection.read(256)
                    while b"\n" in buffer:
                        line, buffer = buffer.split(b"\n", 1)
                        line = line.strip()
                        if line.startswith(b"JOMAA_WIFI_READY:"):
                            address = line.split(b":", 1)[1].decode("ascii")
                            if address and address != "0.0.0.0":
                                return address
                        if line == b"JOMAA_WIFI_FAILED":
                            raise SetupError("Pico could not connect to Wi-Fi")
                    buffer = buffer[-4096:]
        except (OSError, serial.SerialException):
            time.sleep(0.25)
    raise SetupError("timed out waiting for Wi-Fi; check serial permissions and radio wiring")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wifi-transport", choices=("esp8285", "native"), default="esp8285")
    selection = parser.add_mutually_exclusive_group()
    selection.add_argument("--target-port", help="connected MicroPython Pico to reboot into BOOTSEL and reimage")
    selection.add_argument("--configure-port", help="configure a connected Pico using its installed MicroPython firmware")
    args = parser.parse_args(argv)
    try:
        if sys.platform not in ("darwin", "linux"):
            raise SetupError("this script supports Linux and macOS")
        selected = args.target_port or args.configure_port
        if not selected:
            device, mounted = find_bootsel()
            print("Selected BOOTSEL device %s. Its Pico filesystem will be erased." % device, flush=True)
        elif args.target_port and bootsel_volumes():
            raise SetupError("disconnect other BOOTSEL Picos before using target-port")
        with tempfile.TemporaryDirectory(prefix="pico-setup-") as temporary:
            directory = Path(temporary)
            print("Downloading verified USB tools.", flush=True)
            env = install_tools(directory / "tools")
            if not args.configure_port:
                print("Downloading and validating MicroPython firmware.", flush=True)
                payload = download(FIRMWARE_URL)
                validate_firmware(payload)
            existing = ports()
            for serial_port in existing.values():
                require_serial_access(serial_port)
            expected_uid = None
            if selected:
                expected_uid = target_identity(env, selected, existing)
                del existing[expected_uid]
            config, source_uid = get_wifi(env, existing, args.wifi_transport)
            if args.target_port:
                print("Reimaging selected Pico %s; its filesystem will be erased." % expected_uid, flush=True)
                device, mounted = enter_bootsel(args.target_port)
            if args.configure_port:
                serial_number, port = expected_uid, args.configure_port
                print("Configuring selected Pico %s; its filesystem will be erased." % expected_uid, flush=True)
            else:
                volume, mounted_here = mount_bootsel(device, mounted, directory)
                try:
                    print("Flashing %s." % volume, flush=True)
                    flash(volume, payload)
                finally:
                    if mounted_here:
                        unmount_bootsel(device, volume)
                serial_number, port = returning_port(existing)
                print("New Pico serial port: %s." % port, flush=True)
            uid = provision(env, port, source_uid, expected_uid, config, directory)
            print("Configured Pico %s; restarting." % uid, flush=True)
            reset(env, port)
            address = wait_for_wifi(serial_number)
            print("Wi-Fi connected: %s (Pico %s)." % (address, uid))
        return 0
    except (SetupError, OSError, ValueError, subprocess.SubprocessError) as error:
        print("Setup failed: " + (str(error) if isinstance(error, SetupError) else type(error).__name__), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

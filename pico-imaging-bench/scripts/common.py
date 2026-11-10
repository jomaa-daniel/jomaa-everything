"""Shared bench operations. USB output and remote response bodies stay private."""
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.error
import urllib.request

BENCH = Path(__file__).resolve().parents[1]
HUB = BENCH.parent / "jomaa-home-hub"


class BenchError(ValueError):
    pass


def provisioner():
    spec = importlib.util.spec_from_file_location("bench_init_pico", HUB / "scripts/init_pico.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def private_json(path: Path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as output:
        json.dump(value, output, indent=2)
        output.write("\n")


def settings(directory: Path):
    source = directory / "device_config.json"
    if os.name != "nt" and source.stat().st_mode & 0o077:
        raise BenchError("device configuration must have mode 600 or stricter")
    config = json.loads(source.read_text())
    if config.get("ca_file") != "health_ca.der":
        raise BenchError("expected the provisioned health_ca.der certificate")
    return config


def usb_command(port: str, *args, timeout=45):
    result = subprocess.run([sys.executable, "-m", "mpremote", "connect", port, "resume", *args],
                            capture_output=True, timeout=timeout)
    if result.returncode:
        raise BenchError("USB operation failed; check the selected port and firmware capabilities")
    return result.stdout


def usb_json(port: str, code: str):
    output = usb_command(port, "exec", code)
    for line in output.splitlines():
        if line.startswith(b"JOMAA_BENCH:"):
            return json.loads(line[len(b"JOMAA_BENCH:"):])
    raise BenchError("the selected board did not return its inspection result")


def wait_for_port(port: str, timeout=60):
    deadline = time.monotonic() + timeout
    while not Path(port).exists():
        if time.monotonic() >= deadline:
            raise BenchError("Pico serial port did not return after flashing")
        time.sleep(0.25)


class HubClient:
    def __init__(self, directory: Path, password_file: str | None):
        import ssl
        module = provisioner()
        self.config = settings(directory)
        host, port = self.config["hub_host"], self.config["hub_port"]
        self.origin = "https://%s%s" % (host, "" if port == 443 else ":%d" % port)
        module.hub_origin(self.origin)
        ca = module.certificate(directory / "health_ca.der")
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        context.load_verify_locations(cadata=ssl.DER_cert_to_PEM_cert(ca))
        self.opener = urllib.request.build_opener(module.NoRedirect,
                                                  urllib.request.HTTPSHandler(context=context))
        self.token = None
        password = module.secret(password_file, "Hub password for report verification: ")
        self.token = self.request("/api/login", {"password": password})["token"]

    def request(self, path: str, body=None, method=None):
        headers = {"User-Agent": "jomaa-home-hub/pico-imaging-bench", "Content-Type": "application/json"}
        if self.token:
            headers["Authorization"] = "Bearer " + self.token
        request = urllib.request.Request(self.origin + path,
                                         None if body is None else json.dumps(body).encode(), headers, method=method)
        try:
            with self.opener.open(request, timeout=15) as response:
                result = json.load(response)
        except urllib.error.HTTPError as error:
            raise BenchError("hub rejected bench request (HTTP %d)" % error.code) from None
        except urllib.error.URLError:
            raise BenchError("cannot reach the hub over verified HTTPS") from None
        if not isinstance(result, dict):
            raise BenchError("unexpected hub response")
        return result


def verify_reports(client, device_id: str, count=3, timeout=180, progress=None):
    """Require new persisted reports, rather than accepting an already-online inventory row."""
    path = "/api/devices/" + device_id
    old = client.request(path + "/logs?limit=20")["logs"]
    baseline = max((entry["id"] for entry in old), default=0)
    accepted = {}
    last_count = 0
    deadline = time.monotonic() + timeout
    while True:
        result = client.request(path)
        device = result.get("device", result)
        if device["status"] == "revoked":
            raise BenchError("device credential is revoked")
        logs = client.request(path + "/logs?limit=20")["logs"]
        for entry in logs:
            if entry["id"] <= baseline:
                continue
            report = entry["heartbeat"]
            if report.get("ip") in (None, "", "0.0.0.0") or report.get("freeHeapBytes", 0) <= 0:
                continue
            accepted[(report["bootId"], report["sequence"])] = entry
        latest = device.get("latest") or {}
        current = [entry for (boot, sequence), entry in accepted.items() if boot == latest.get("bootId")]
        if len(current) != last_count:
            last_count = len(current)
            if progress:
                progress(min(count, last_count), count)
        if len(current) >= count and device["status"] in ("online", "degraded"):
            return {"deviceId": device_id, "status": device["status"], "reportsAccepted": len(current),
                    "latest": device["latest"], "lastSeen": device["lastSeen"]}
        if time.monotonic() >= deadline:
            raise BenchError("timed out waiting for new persisted health reports")
        time.sleep(min(3, max(0, deadline - time.monotonic())))

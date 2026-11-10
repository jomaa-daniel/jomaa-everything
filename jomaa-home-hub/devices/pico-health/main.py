"""MicroPython Pico Wi-Fi health reporter. Requires verified TLS support."""
import binascii
import gc
import json
import os
import socket
import ssl
import time

FIRMWARE = "jomaa-pico-health/1.0.0"
MAX_RESPONSE = 8192


def _read_exact(stream, count):
    data = b""
    while len(data) < count:
        part = stream.read(count - len(data))
        if not part:
            raise OSError("incomplete HTTP response")
        data += part
    return data


def post_health(config, tls, payload, radio=None):
    """No redirects and no unverified TLS fallback; credentials go only to the configured host."""
    host = config["hub_host"]
    port = config["hub_port"]
    raw = radio.open_tcp(host, port) if radio else socket.socket()
    stream = None
    try:
        if radio is None:
            raw.settimeout(15)
            raw.connect(socket.getaddrinfo(host, port, 0, socket.SOCK_STREAM)[0][-1])
        stream = tls.wrap_socket(raw, server_hostname=host)
        encoded = json.dumps(payload).encode()
        authority = host if port == 443 else "%s:%d" % (host, port)
        headers = ("POST /api/devices/%s/health HTTP/1.1\r\n"
                   "Host: %s\r\nAuthorization: Bearer %s\r\n"
                   "User-Agent: %s\r\n"
                   "Content-Type: application/json\r\nContent-Length: %d\r\n"
                   "Connection: close\r\n\r\n") % (
                       config["id"], authority, config["token"], FIRMWARE, len(encoded))
        # MicroPython streams may return short writes.
        data = headers.encode() + encoded
        offset = 0
        while offset < len(data):
            written = stream.write(data[offset:])
            if not written:
                raise OSError("incomplete HTTP write")
            offset += written
        line = stream.readline()
        if not line or len(line) > 512:
            raise OSError("invalid HTTP status")
        status = int(line.split()[1])
        headers = {}
        total = len(line)
        while True:
            line = stream.readline()
            total += len(line)
            if total > MAX_RESPONSE or not line:
                raise OSError("invalid HTTP headers")
            if line == b"\r\n":
                break
            key, value = line.decode().split(":", 1)
            headers[key.lower()] = value.strip()
        if headers.get("transfer-encoding", "").lower() == "chunked":
            response = b""
            while True:
                size = int(stream.readline().split(b";", 1)[0], 16)
                if not size:
                    break
                if size < 0 or len(response) + size > MAX_RESPONSE:
                    raise OSError("HTTP response too large")
                response += _read_exact(stream, size)
                if _read_exact(stream, 2) != b"\r\n":
                    raise OSError("invalid HTTP chunk")
        elif "content-length" in headers:
            size = int(headers["content-length"])
            if size < 0 or size > MAX_RESPONSE:
                raise OSError("HTTP response too large")
            response = _read_exact(stream, size)
        else:
            response = stream.read(MAX_RESPONSE + 1)
            if len(response) > MAX_RESPONSE:
                raise OSError("HTTP response too large")
        if status not in (200, 201):
            raise OSError("hub rejected health report (%d)" % status)
        result = json.loads(response)
        if result.get("ok") is not True:
            raise OSError("hub did not acknowledge health report")
        return result
    finally:
        try:
            if stream is not None:
                stream.close()
        finally:
            raw.close()


def tls_context(config):
    # Missing CERT_REQUIRED / load_verify_locations is a hard failure.
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.verify_mode = ssl.CERT_REQUIRED
    with open(config["ca_file"], "rb") as source:
        ctx.load_verify_locations(cadata=source.read())
    return ctx


def run():
    with open("device_config.json") as source:
        config = json.load(source)
    tls = tls_context(config)
    radio = None
    transport = config["wifi_transport"]
    if transport == "esp8285":
        from esp8285 import ESP8285
        radio = ESP8285(config)
        wlan = radio
    elif transport == "native":
        import network
        import ntptime
        wlan = network.WLAN(network.STA_IF)
        wlan.active(True)
    else:
        raise ValueError("unsupported Wi-Fi transport")
    boot_id = binascii.hexlify(os.urandom(16)).decode()
    sequence = 0
    interval = config["interval_seconds"]
    retry = 5
    clock_ready = False
    uptime_ms = 0
    last_tick = time.ticks_ms()
    pending = None
    while True:
        now = time.ticks_ms()
        uptime_ms += time.ticks_diff(now, last_tick)
        last_tick = now
        try:
            if not wlan.isconnected():
                if radio:
                    radio.connect()
                else:
                    wlan.disconnect()
                    wlan.connect(config["wifi_ssid"], config["wifi_password"])
                    start = time.ticks_ms()
                    while not wlan.isconnected():
                        if time.ticks_diff(time.ticks_ms(), start) > 20000:
                            raise OSError("Wi-Fi connection timed out")
                        time.sleep_ms(250)
            if not clock_ready:
                if radio:
                    radio.sync_clock()
                else:
                    ntptime.host = config.get("ntp_host", "pool.ntp.org")
                    ntptime.settime()
                clock_ready = True
            if pending is None:
                now = time.ticks_ms()
                uptime_ms += time.ticks_diff(now, last_tick)
                last_tick = now
                gc.collect()
                heap = gc.mem_free()
                pending = {"bootId": boot_id, "sequence": sequence, "firmware": FIRMWARE,
                           "uptimeSeconds": uptime_ms // 1000, "freeHeapBytes": heap,
                           "ip": wlan.ifconfig()[0],
                           "status": "degraded" if heap < 20000 else "healthy"}
                try:
                    pending["rssi"] = wlan.status("rssi")
                except (OSError, ValueError, AttributeError):
                    pass
                if heap < 20000:
                    pending["message"] = "Low free heap"
            result = post_health(config, tls, pending, radio)
            interval = max(15, min(3600, int(result.get("nextIntervalSeconds", interval))))
            pending = None
            sequence += 1
            retry = 5
            print("Health report acknowledged")
            time.sleep(interval)
        except Exception as error:
            # Never print config, tokens, network credentials, or HTTP headers.
            print("Health report failed (%s); retrying in %ds" % (type(error).__name__, retry))
            time.sleep(retry)
            retry = min(60, retry * 2)


if __name__ == "__main__":
    run()

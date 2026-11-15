"""MicroPython Pico Wi-Fi health reporter. Requires verified TLS support."""
import binascii
import gc
import json
import os
import socket
import ssl
import time

FIRMWARE = "jomaa-pico-health/1.1.0"
STREAM_SETTINGS_FILE = "stream.json"
MIN_HEALTH_INTERVAL_SECONDS = 15
MAX_HEALTH_INTERVAL_SECONDS = 3600


def _read_exact(stream, count):
    data = b""
    while len(data) < count:
        part = stream.read(count - len(data))
        if not part:
            raise OSError("incomplete HTTP response")
        data += part
    return data


def post_json(config, tls, payload, action, radio=None):
    """No redirects and no unverified TLS fallback; credentials go only to the configured host."""
    host = config["hub_host"]
    port = config["hub_port"]
    limits = config["runtime"]
    max_response = limits["maxResponseBytes"]
    raw = radio.open_tcp(host, port) if radio else socket.socket()
    stream = None
    try:
        if radio is None:
            raw.settimeout(limits["socketTimeoutSeconds"])
            raw.connect(socket.getaddrinfo(host, port, 0, socket.SOCK_STREAM)[0][-1])
        stream = tls.wrap_socket(raw, server_hostname=host)
        encoded = json.dumps(payload).encode()
        authority = host if port == 443 else "%s:%d" % (host, port)
        headers = ("POST /api/devices/%s/%s HTTP/1.1\r\n"
                   "Host: %s\r\nAuthorization: Bearer %s\r\n"
                   "User-Agent: %s\r\n"
                   "Content-Type: application/json\r\nContent-Length: %d\r\n"
                   "Connection: close\r\n\r\n") % (
                       config["id"], action, authority, config["token"], FIRMWARE, len(encoded))
        # MicroPython streams may return short writes.
        data = headers.encode() + encoded
        offset = 0
        while offset < len(data):
            written = stream.write(data[offset:])
            if not written:
                raise OSError("incomplete HTTP write")
            offset += written
        line = stream.readline()
        if not line or len(line) > limits["maxStatusLineBytes"]:
            raise OSError("invalid HTTP status")
        status = int(line.split()[1])
        headers = {}
        total = len(line)
        while True:
            line = stream.readline()
            total += len(line)
            if total > max_response or not line:
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
                if size < 0 or len(response) + size > max_response:
                    raise OSError("HTTP response too large")
                response += _read_exact(stream, size)
                if _read_exact(stream, 2) != b"\r\n":
                    raise OSError("invalid HTTP chunk")
        elif "content-length" in headers:
            size = int(headers["content-length"])
            if size < 0 or size > max_response:
                raise OSError("HTTP response too large")
            response = _read_exact(stream, size)
        else:
            response = stream.read(max_response + 1)
            if len(response) > max_response:
                raise OSError("HTTP response too large")
        if status not in (200, 201):
            raise OSError("hub rejected report (%d)" % status)
        result = json.loads(response)
        if result.get("ok") is not True:
            raise OSError("hub did not acknowledge report")
        return result
    finally:
        try:
            if stream is not None:
                stream.close()
        finally:
            raw.close()


def post_health(config, tls, payload, radio=None):
    return post_json(config, tls, payload, "health", radio)


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
    with open(STREAM_SETTINGS_FILE) as source:
        config["runtime"] = json.load(source)
    from stream import I2CCapture
    tls = tls_context(config)
    capture = I2CCapture(config["runtime"])
    try:
        capture.start()
        report_loop(config, tls, capture)
    finally:
        capture.stop()


def report_loop(config, tls, capture):
    runtime = config["runtime"]
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
    retry = runtime["retrySeconds"]
    clock_ready = False
    uptime_ms = 0
    last_tick = time.ticks_ms()
    pending = None
    pending_capture = None
    health_due = time.ticks_ms()
    upload_due = health_due
    bus_ids = [bus["id"] for bus in runtime["buses"]]
    next_bus = 0
    connected = False
    while True:
        now = time.ticks_ms()
        uptime_ms += time.ticks_diff(now, last_tick)
        last_tick = now
        try:
            if not connected:
                if not wlan.isconnected():
                    if radio:
                        radio.connect()
                    else:
                        wlan.disconnect()
                        wlan.connect(config["wifi_ssid"], config["wifi_password"])
                        start = time.ticks_ms()
                        while not wlan.isconnected():
                            if time.ticks_diff(time.ticks_ms(), start) > runtime["joinTimeoutMilliseconds"]:
                                raise OSError("Wi-Fi connection timed out")
                            time.sleep_ms(runtime["joinPollMilliseconds"])
                connected = True
            if not clock_ready:
                if radio:
                    radio.sync_clock()
                else:
                    ntptime.host = config.get("ntp_host", "pool.ntp.org")
                    ntptime.settime()
                clock_ready = True
            if pending is None and time.ticks_diff(time.ticks_ms(), health_due) >= 0:
                now = time.ticks_ms()
                uptime_ms += time.ticks_diff(now, last_tick)
                last_tick = now
                gc.collect()
                heap = gc.mem_free()
                pending = {"bootId": boot_id, "sequence": sequence, "firmware": FIRMWARE,
                           "uptimeSeconds": uptime_ms // 1000, "freeHeapBytes": heap,
                           "ip": wlan.ifconfig()[0],
                           "status": "degraded" if heap < runtime["lowHeapBytes"] or capture.stopped else "healthy"}
                try:
                    pending["rssi"] = wlan.status("rssi")
                except (OSError, ValueError, AttributeError):
                    pass
                if heap < runtime["lowHeapBytes"]:
                    pending["message"] = "Low free heap"
                elif capture.stopped:
                    pending["message"] = "I2C capture stopped"
            if pending is not None:
                result = post_health(config, tls, pending, radio)
                interval = max(MIN_HEALTH_INTERVAL_SECONDS,
                               min(MAX_HEALTH_INTERVAL_SECONDS, int(result["nextIntervalSeconds"])))
                pending = None
                sequence += 1
                health_due = time.ticks_add(time.ticks_ms(), interval * 1000)
                retry = runtime["retrySeconds"]
                print("Health report acknowledged")
            elif pending_capture is not None or time.ticks_diff(time.ticks_ms(), upload_due) >= 0:
                if pending_capture is None:
                    for _ in bus_ids:
                        bus = bus_ids[next_bus]
                        next_bus = (next_bus + 1) % len(bus_ids)
                        pending_capture = capture.buffer.take(bus, boot_id)
                        if pending_capture is not None:
                            break
                if pending_capture is not None:
                    post_json(config, tls, pending_capture, "i2c", radio)
                    pending_capture = None
                    upload_due = time.ticks_add(time.ticks_ms(), runtime["uploadMilliseconds"])
                    retry = runtime["retrySeconds"]
                else:
                    time.sleep_ms(runtime["idleMilliseconds"])
            else:
                time.sleep_ms(runtime["idleMilliseconds"])
        except Exception as error:
            # Never print config, tokens, network credentials, or HTTP headers.
            print("Report failed (%s); retrying in %ds" % (type(error).__name__, retry))
            connected = False
            time.sleep(retry)
            retry = min(runtime["retryMaxSeconds"], retry * 2)


if __name__ == "__main__":
    run()

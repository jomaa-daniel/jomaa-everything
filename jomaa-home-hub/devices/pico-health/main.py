"""MicroPython Pico Wi-Fi health reporter. Requires verified TLS support."""
import binascii
import gc
import json
import os
import socket
import ssl
import time

FIRMWARE = "jomaa-pico-health/1.1.1"
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


class HTTPSClient:
    """Verified TLS connection shared by length-framed health and capture requests."""
    def __init__(self, config, tls, radio=None):
        self.config = config
        self.tls = tls
        self.radio = radio
        self.raw = None
        self.stream = None

    def _connect(self):
        host, port = self.config["hub_host"], self.config["hub_port"]
        self.raw = self.radio.open_tcp(host, port) if self.radio else socket.socket()
        if self.radio is None:
            self.raw.settimeout(self.config["runtime"]["socketTimeoutSeconds"])
            self.raw.connect(socket.getaddrinfo(host, port, 0, socket.SOCK_STREAM)[0][-1])
        self.stream = self.tls.wrap_socket(self.raw, server_hostname=host)

    def post(self, payload, action):
        try:
            if self.stream is None:
                self._connect()
            if self.radio is not None:
                self.raw.start_request()
            encoded = json.dumps(payload).encode()
            host, port = self.config["hub_host"], self.config["hub_port"]
            authority = host if port == 443 else "%s:%d" % (host, port)
            headers = ("POST /api/devices/%s/%s HTTP/1.1\r\n"
                       "Host: %s\r\nAuthorization: Bearer %s\r\nUser-Agent: %s\r\n"
                       "Content-Type: application/json\r\nContent-Length: %d\r\n"
                       "Connection: keep-alive\r\n\r\n") % (
                           self.config["id"], action, authority, self.config["token"], FIRMWARE, len(encoded))
            data = headers.encode() + encoded
            offset = 0
            while offset < len(data):
                written = self.stream.write(data[offset:])
                if not written:
                    raise OSError("incomplete HTTP write")
                offset += written
            status, response_headers, response = self._response()
            if status not in (200, 201):
                raise OSError("hub rejected report (%d)" % status)
            result = json.loads(response)
            if result.get("ok") is not True:
                raise OSError("hub did not acknowledge report")
            if response_headers.get("connection", "").lower() == "close":
                self.close()
            return result
        except Exception:
            self.close()
            raise

    def _response(self):
        stream = self.stream
        limits = self.config["runtime"]
        maximum = limits["maxResponseBytes"]
        line = stream.readline()
        if not line or len(line) > limits["maxStatusLineBytes"]:
            raise OSError("invalid HTTP status")
        status = int(line.split()[1])
        headers = {}
        total = len(line)
        while True:
            line = stream.readline()
            total += len(line)
            if not line or total > maximum:
                raise OSError("invalid HTTP headers")
            if line == b"\r\n":
                break
            key, value = line.decode().split(":", 1)
            headers[key.lower()] = value.strip()
        if headers.get("transfer-encoding", "").lower() == "chunked":
            response = b""
            while True:
                line = stream.readline()
                if not line or len(line) > limits["maxStatusLineBytes"]:
                    raise OSError("invalid HTTP chunk")
                size = int(line.split(b";", 1)[0], 16)
                if not size:
                    while True:
                        line = stream.readline()
                        total += len(line)
                        if not line or total > maximum:
                            raise OSError("invalid HTTP trailers")
                        if line == b"\r\n":
                            break
                    break
                if size < 0 or len(response) + size > maximum:
                    raise OSError("HTTP response too large")
                response += _read_exact(stream, size)
                if _read_exact(stream, 2) != b"\r\n":
                    raise OSError("invalid HTTP chunk")
        elif "content-length" in headers:
            size = int(headers["content-length"])
            if size < 0 or size > maximum:
                raise OSError("HTTP response too large")
            response = _read_exact(stream, size)
        else:
            raise OSError("HTTP response requires length framing")
        return status, headers, response

    def close(self):
        raw, stream = self.raw, self.stream
        self.raw = None
        self.stream = None
        try:
            if stream is not None:
                stream.close()
        finally:
            if raw is not None:
                raw.close()


def post_json(config, tls, payload, action, radio=None):
    client = HTTPSClient(config, tls, radio)
    try:
        return client.post(payload, action)
    finally:
        client.close()


def post_health(config, tls, payload, radio=None):
    return post_json(config, tls, payload, "health", radio)


def tls_context(config):
    # Missing CERT_REQUIRED / load_verify_locations is a hard failure.
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.verify_mode = ssl.CERT_REQUIRED
    with open(config["ca_file"], "rb") as source:
        ctx.load_verify_locations(cadata=source.read())
    return ctx


def run(capture_enabled=True, telemetry=None):
    with open("device_config.json") as source:
        config = json.load(source)
    with open(STREAM_SETTINGS_FILE) as source:
        config["runtime"] = json.load(source)
    tls = tls_context(config)
    if capture_enabled:
        from stream import I2CCapture
        capture = I2CCapture(config["runtime"])
    else:
        capture = None
    try:
        if capture is not None:
            capture.start()
        report_loop(config, tls, capture, telemetry)
    finally:
        if capture is not None:
            capture.stop()


def report_loop(config, tls, capture, telemetry=None):
    radio = None
    transport = config["wifi_transport"]
    if transport == "esp8285":
        from esp8285 import ESP8285
        radio = ESP8285(config)
        wlan = radio
    elif transport == "native":
        import network
        wlan = network.WLAN(network.STA_IF)
        wlan.active(True)
    else:
        raise ValueError("unsupported Wi-Fi transport")
    client = HTTPSClient(config, tls, radio)
    try:
        send_loop(config, capture, radio, wlan, client, telemetry)
    finally:
        client.close()


def send_loop(config, capture, radio, wlan, client, telemetry=None):
    runtime = config["runtime"]
    boot_id = telemetry.boot_id if telemetry is not None else binascii.hexlify(os.urandom(16)).decode()
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
    bus_ids = [bus["id"] for bus in runtime["buses"]] if capture is not None else []
    next_bus = 0
    connected = False
    ip = None
    while True:
        if telemetry is not None:
            telemetry.tick(ip)
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
                ip = wlan.ifconfig()[0]
                connected = True
            if not clock_ready:
                if radio:
                    radio.sync_clock()
                else:
                    import ntptime
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
                           "ip": ip,
                           "status": "degraded" if heap < runtime["lowHeapBytes"] or
                           (capture is not None and capture.stopped) else "healthy"}
                try:
                    pending["rssi"] = wlan.status("rssi")
                except (OSError, ValueError, AttributeError):
                    pass
                if heap < runtime["lowHeapBytes"]:
                    pending["message"] = "Low free heap"
                elif capture is not None and capture.stopped:
                    pending["message"] = "I2C capture stopped"
            if pending is not None:
                result = client.post(pending, "health")
                interval = max(MIN_HEALTH_INTERVAL_SECONDS,
                               min(MAX_HEALTH_INTERVAL_SECONDS, int(result["nextIntervalSeconds"])))
                pending = None
                sequence += 1
                health_due = time.ticks_add(time.ticks_ms(), interval * 1000)
                retry = runtime["retrySeconds"]
                print("Health report acknowledged")
            elif capture is not None and (pending_capture is not None or time.ticks_diff(time.ticks_ms(), upload_due) >= 0):
                if pending_capture is None:
                    for _ in bus_ids:
                        bus = bus_ids[next_bus]
                        next_bus = (next_bus + 1) % len(bus_ids)
                        pending_capture = capture.buffer.take(bus, boot_id)
                        if pending_capture is not None:
                            break
                if pending_capture is not None:
                    client.post(pending_capture, "i2c")
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
            try:
                client.close()
            except OSError:
                pass
            connected = False
            time.sleep(retry)
            retry = min(runtime["retryMaxSeconds"], retry * 2)


if __name__ == "__main__":
    run()

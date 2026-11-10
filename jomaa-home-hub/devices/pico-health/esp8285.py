"""ESP8285 AT transport. The Pico verifies TLS over an ordinary TCP UART stream."""
import io
import time
from machine import RTC, UART


def _quoted(value):
    if any(c in value for c in ("\r", "\n", "\x00")):
        raise ValueError("invalid AT argument")
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


class TCPStream(io.IOBase):
    """MicroPython stream protocol with a deadline, suitable for SSLContext.wrap_socket."""
    def __init__(self, radio):
        self.radio = radio
        self._closed = False
        self.deadline = time.ticks_add(time.ticks_ms(), 30000)

    def _check(self):
        if self._closed:
            raise OSError(9)
        if time.ticks_diff(time.ticks_ms(), self.deadline) >= 0:
            raise OSError(110)

    def readinto(self, buffer):
        while True:
            self._check()
            count = self.radio.uart.readinto(buffer)
            if count:
                return count
            time.sleep_ms(1)

    def write(self, data):
        while True:
            self._check()
            count = self.radio.uart.write(data)
            if count:
                return count
            time.sleep_ms(1)

    def ioctl(self, operation, argument):
        if operation == 3:  # MP_STREAM_POLL
            self._check()
            return argument & (4 | (1 if self.radio.uart.any() else 0))
        if operation == 4:  # MP_STREAM_CLOSE
            self.close()
        return 0

    def close(self):
        if not self._closed:
            self._closed = True
            self.radio.close_tcp()


class ESP8285:
    def __init__(self, config):
        self.config = config
        # GP0/GP1 are the board's existing UART0 wiring. Buffer incoming TLS records.
        self.uart = UART(0, 115200, timeout=0, rxbuf=16384, txbuf=2048)
        self.transparent = False

    def _drain(self):
        while self.uart.any():
            self.uart.read()

    def command(self, value, timeout=5, marker=b"\r\nOK\r\n"):
        if self.transparent:
            raise OSError("radio still in TCP mode")
        self._drain()
        self.uart.write(value + "\r\n")
        response = b""
        start = time.ticks_ms()
        while time.ticks_diff(time.ticks_ms(), start) < timeout * 1000:
            data = self.uart.read()
            if data:
                response += data
                if marker in response:
                    return response
                if b"\r\nERROR\r\n" in response or b"\r\nFAIL\r\n" in response:
                    # AT echoes and replies can contain credentials; never include them in errors.
                    raise OSError("radio rejected command")
                if len(response) > 8192:
                    raise OSError("radio response too large")
            time.sleep_ms(10)
        raise OSError("radio command timed out")

    def _recover(self):
        # Escape a TCP session left by an interrupted program. The guard times are required by AT.
        time.sleep_ms(1100)
        self.uart.write(b"+++")
        time.sleep_ms(1100)
        self.uart.write(b"\r\n")
        time.sleep_ms(100)
        self._drain()
        self.transparent = False
        self.command("AT")
        self.command("ATE0")
        self.command("AT+CIPMODE=0")
        try:
            self.command("AT+CIPCLOSE", 3)
        except OSError:
            pass  # Already closed.

    def connect(self):
        self._recover()
        self.command("AT+CWMODE_CUR=1")
        join = "AT+CWJAP_CUR=%s,%s" % (_quoted(self.config["wifi_ssid"]),
                                       _quoted(self.config["wifi_password"]))
        try:
            self.command(join, 30)
        except OSError:
            # Clear stale radio state before one more attempt, preserving stored flash settings.
            self.command("AT+RST")
            time.sleep(3)
            self.command("ATE0")
            self.command("AT+CWMODE_CUR=1")
            self.command(join, 30)
        if not self.isconnected():
            raise OSError("Wi-Fi has no address")

    def ifconfig(self):
        response = self.command("AT+CIFSR").decode("utf-8", "replace")
        for line in response.splitlines():
            if "STAIP," in line:
                return (line.split("STAIP,", 1)[1].strip().strip('"'),)
        raise OSError("radio has no address")

    def isconnected(self):
        try:
            return self.ifconfig()[0] != "0.0.0.0"
        except OSError:
            return False

    def sync_clock(self):
        host = _quoted(self.config.get("ntp_host", "pool.ntp.org"))
        self.command("AT+CIPSNTPCFG=1,0," + host)
        months = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
        start = time.ticks_ms()
        while time.ticks_diff(time.ticks_ms(), start) < 20000:
            response = self.command("AT+CIPSNTPTIME?").decode("utf-8", "replace")
            for line in response.splitlines():
                if line.startswith("+CIPSNTPTIME:"):
                    parts = line.split(":", 1)[1].split()
                    if len(parts) == 5 and 2024 <= int(parts[4]) <= 2100:
                        year, month, day = int(parts[4]), months.index(parts[1]) + 1, int(parts[2])
                        hour, minute, second = [int(n) for n in parts[3].split(":")]
                        RTC().datetime((year, month, day, 0, hour, minute, second, 0))
                        return
            time.sleep(1)
        raise OSError("NTP synchronization timed out")

    def open_tcp(self, host, port):
        self.command("AT+CIPMUX=0")
        self.command("AT+CIPMODE=1")
        try:
            self.command("AT+CIPSTART=\"TCP\",%s,%d" % (_quoted(host), port), 15)
            self.command("AT+CIPSEND", marker=b">")
            # The prompt can have a trailing space/newline. No TLS bytes have been sent yet.
            time.sleep_ms(50)
            self._drain()
            self.transparent = True
            return TCPStream(self)
        except Exception:
            self.close_tcp()
            raise

    def close_tcp(self):
        if self.transparent:
            time.sleep_ms(1100)
            self.uart.write(b"+++")
            time.sleep_ms(1100)
            self.transparent = False
            self._drain()
        try:
            self.command("AT+CIPCLOSE", 3)
        except OSError:
            pass
        self.command("AT+CIPMODE=0")

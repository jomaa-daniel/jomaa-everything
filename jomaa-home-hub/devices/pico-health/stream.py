"""Continuous active I²C reads with bounded per-bus buffers."""
import _thread
import binascii
import time

READ_ERROR_LENGTH = 0xffff
READ_ERROR = 1
SCAN_ERROR = 2


class CaptureBuffer:
    def __init__(self, settings):
        self.limit = settings["maxDataBytes"]
        self.lock = _thread.allocate_lock()
        self.pending = {}
        self.sequences = {}
        for bus in settings["buses"]:
            self.pending[bus["id"]] = self._empty(0)
            self.sequences[bus["id"]] = 0

    def _empty(self, start):
        return {"startUs": start, "endUs": start, "data": bytearray(), "dropped": 0}

    def append(self, bus, end, data, dropped):
        with self.lock:
            frame = self.pending[bus]
            frame["endUs"] = end
            frame["dropped"] += dropped
            if len(frame["data"]) + len(data) <= self.limit:
                frame["data"].extend(data)
            elif data:
                frame["dropped"] += 1

    def take(self, bus, boot_id):
        with self.lock:
            frame = self.pending[bus]
            if frame["endUs"] <= frame["startUs"]:
                return None
            self.pending[bus] = self._empty(frame["endUs"])
            sequence = self.sequences[bus]
            self.sequences[bus] += 1
        frame["data"] = binascii.hexlify(frame["data"]).decode()
        frame.update({"bootId": boot_id, "sequence": sequence, "bus": bus})
        return frame


class I2CCapture:
    def __init__(self, settings, factory=None):
        if factory is None:
            from machine import I2C, Pin
            def factory(bus):
                return I2C(bus["id"], sda=Pin(bus["sda"]), scl=Pin(bus["scl"]),
                           freq=settings["frequencyHz"], timeout=settings["timeoutUs"])
        self.settings = settings
        self.buffer = CaptureBuffer(settings)
        self.buses = [(bus, factory(bus)) for bus in settings["buses"]]
        self.addresses = {bus["id"]: [] for bus in settings["buses"]}
        self.scanned = {bus["id"]: -settings["scanMilliseconds"] for bus in settings["buses"]}
        self.running = False
        self.stopped = True

    def sample(self, elapsed_us):
        for bus, i2c in self.buses:
            bus_id = bus["id"]
            data = bytearray()
            dropped = 0
            if elapsed_us // 1000 - self.scanned[bus_id] >= self.settings["scanMilliseconds"]:
                try:
                    self.addresses[bus_id] = i2c.scan()
                except OSError:
                    self.addresses[bus_id] = []
                    data.extend(bytes((0, READ_ERROR_LENGTH >> 8, READ_ERROR_LENGTH & 255, SCAN_ERROR)))
                    dropped += 1
                self.scanned[bus_id] = elapsed_us // 1000
            for address in self.addresses[bus_id]:
                try:
                    register = bus["registers"].get(hex(address))
                    raw = i2c.readfrom(address, self.settings["readBytes"]) if register is None else \
                        i2c.readfrom_mem(address, register, self.settings["readBytes"])
                    data.extend(bytes((address, len(raw) >> 8, len(raw) & 255)))
                    data.extend(raw)
                except OSError:
                    data.extend(bytes((address, READ_ERROR_LENGTH >> 8, READ_ERROR_LENGTH & 255, READ_ERROR)))
                    dropped += 1
            self.buffer.append(bus_id, elapsed_us, data, dropped)

    def start(self):
        self.running = True
        self.stopped = False
        try:
            _thread.start_new_thread(self._run, ())
        except Exception:
            self.running = False
            self.stopped = True
            raise

    def _run(self):
        elapsed = 0
        last = time.ticks_us()
        try:
            while self.running:
                now = time.ticks_us()
                elapsed += time.ticks_diff(now, last)
                last = now
                self.sample(max(1, elapsed))
                time.sleep_ms(self.settings["sampleMilliseconds"])
        finally:
            self.stopped = True

    def stop(self):
        self.running = False
        while not self.stopped:
            time.sleep_ms(self.settings["idleMilliseconds"])

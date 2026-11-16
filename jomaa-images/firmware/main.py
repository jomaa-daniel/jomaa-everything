"""Run the selected image functions at every hardware boot."""
import image_status as status
import json
import time

def run():
    features = status.image["features"]
    if "health" in features:
        import health
        health.run(capture_enabled="i2c" in features, telemetry=status, apply_wifi=True)
        return
    wifi = None
    if "wifi" in features:
        with open("device_config.json") as source:
            config = json.load(source)
        if config["wifi_transport"] == "esp8285":
            from esp8285 import ESP8285
            wifi = ESP8285(config)
        else:
            import network
            wifi = network.WLAN(network.STA_IF)
            wifi.active(True)
    ip = None
    connection_due = time.ticks_ms()
    configured = False
    while True:
        now = time.ticks_ms()
        if wifi is not None and configured and time.ticks_diff(now, connection_due) >= 0:
            try:
                ip = wifi.ifconfig()[0] if wifi.isconnected() else None
            except Exception:
                ip = None
            connection_due = time.ticks_add(now, status.settings["sampleMilliseconds"])
        status.tick(ip)
        if wifi is not None and ip is None:
            try:
                if config["wifi_transport"] == "esp8285":
                    wifi.connect()
                else:
                    wifi.disconnect()
                    wifi.connect(config["wifi_ssid"], config["wifi_password"])
                    start = time.ticks_ms()
                    while not wifi.isconnected():
                        if time.ticks_diff(time.ticks_ms(), start) >= config["runtime"]["joinTimeoutMilliseconds"]:
                            raise OSError("Wi-Fi connection timed out")
                        time.sleep_ms(config["runtime"]["joinPollMilliseconds"])
                ip = wifi.ifconfig()[0]
                configured = True
                if ip == "0.0.0.0":
                    ip = None
            except Exception:
                ip = None
                time.sleep(config["runtime"]["retrySeconds"])
        time.sleep_ms(status.settings["idleMilliseconds"])

if __name__ == "__main__":
    run()

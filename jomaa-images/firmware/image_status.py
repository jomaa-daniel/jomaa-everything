"""Structured observations from the installed Pico startup."""
import binascii
import json
import machine
import os
import time

MARKER = "JOMAA_IMAGE:"
with open("image.json") as source:
    image = json.load(source)
with open("image_settings.json") as source:
    settings = json.load(source)
boot_id = binascii.hexlify(os.urandom(16)).decode()
unique_id = binascii.hexlify(machine.unique_id()).decode()
adc = machine.ADC(settings["temperatureAdc"]) if "temperature" in image["features"] else None
due = time.ticks_ms()
sequence = 0

def tick(ip=None):
    global due, sequence
    now = time.ticks_ms()
    if time.ticks_diff(now, due) < 0:
        return
    result = {"installId": image["installId"], "uniqueId": unique_id,
              "bootId": boot_id, "sequence": sequence, "features": image["features"]}
    if ip:
        result["ip"] = ip
    if adc is not None:
        voltage = adc.read_u16() * settings["referenceVolts"] / 65535
        result["celsius"] = settings["referenceCelsius"] - \
            (voltage - settings["referenceSensorVolts"]) / settings["voltsPerCelsius"]
    print(MARKER + json.dumps(result))
    sequence += 1
    due = time.ticks_add(now, settings["sampleMilliseconds"])

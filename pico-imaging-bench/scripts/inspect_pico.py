#!/usr/bin/env python3
"""Inspect one selected MicroPython board. Entering raw REPL interrupts its running program."""
from __future__ import annotations

import argparse
import json
import sys

from common import usb_json

CODE = """import os,sys,machine,gc,binascii,json
r={'uniqueId':binascii.hexlify(machine.unique_id()).decode(), 'firmware':sys.version,
   'machine':os.uname().machine, 'freeHeapBytes':gc.mem_free(), 'files':os.listdir()}
try:
 import ssl
 r['verifiedTlsAvailable']=hasattr(ssl,'SSLContext') and hasattr(ssl,'CERT_REQUIRED') and hasattr(ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT),'load_verify_locations')
except ImportError:r['verifiedTlsAvailable']=False
try:
 import network
 w=network.WLAN(network.STA_IF)
 r['nativeWifiActive']=w.active()
 r['nativeWifiConnected']=w.isconnected()
except Exception:r['nativeWifiAvailable']=False
"""

ESP_PROBE = """import time
u=machine.UART(0,115200,timeout=50,rxbuf=4096)
time.sleep_ms(1100);u.write(b'+++');time.sleep_ms(1100);u.write(b'\\r\\n');time.sleep_ms(100)
while u.any():u.read()
u.write(b'AT\\r\\n')
response=b'';start=time.ticks_ms()
while time.ticks_diff(time.ticks_ms(),start)<3000:
 part=u.read()
 if part:
  response+=part
  if b'\\r\\nOK\\r\\n' in response:break
r['esp8285Responsive']=b'\\r\\nOK\\r\\n' in response
"""


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", required=True)
    parser.add_argument("--probe-esp8285", action="store_true")
    args = parser.parse_args(argv)
    try:
        code = CODE + (ESP_PROBE if args.probe_esp8285 else "") + "print('JOMAA_BENCH:'+json.dumps(r))"
        print(json.dumps(usb_json(args.port, code), indent=2))
        return 0
    except Exception as error:
        print("Inspection failed (%s)." % type(error).__name__, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

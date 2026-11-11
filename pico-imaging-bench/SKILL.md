---
name: pico-imaging-bench
description: Image, provision, inspect, and troubleshoot a USB-connected Pico for the Jomaa hub's Wi-Fi health reporting, including RP2040 boards with an external ESP8285 radio.
---

# Pico imaging and health

Use the scripts in this directory for imaging and verification. Read [README.md](README.md) for command
arguments and the complete imaging procedure. The implementation shares provisioning with
`../jomaa-home-hub/scripts/init_pico.py` and firmware with `../jomaa-home-hub/devices/pico-health/`.

## Script responsibilities

| File | Responsibility |
| --- | --- |
| `scripts/setup_pico.py` | BOOTSEL flashing, Add Device enrollment, reporter installation, and heartbeat verification. |
| `scripts/setup_wifi.py` | Firmware and Wi-Fi setup; shared USB discovery, UF2, mount, and tool-bootstrap helpers. |
| `scripts/flash_pico.py` | Explicit UF2 digest, block-layout, chip-family, and BOOTSEL-volume validation. |
| `scripts/image_and_test.py` | Imaging with explicit firmware, volume, serial port, and optional UID guard; LittleFS formatting. |
| `scripts/common.py` | Private files, USB result markers, hub requests, and persisted-report verification. |
| `../jomaa-home-hub/scripts/init_pico.py` | Shared reporter preparation and USB installation. |
| `../jomaa-home-hub/devices/pico-health/` | MicroPython reporter and ESP8285 transport installed on the board. |

`setup_pico.py --configure-port` retains the filesystem and replaces startup reporting files.
`setup_wifi.py --configure-port` formats the filesystem and installs Wi-Fi-only startup. Reimaging
through `--target-port` erases the target filesystem. Keep these distinct effects explicit when
changing the scripts.

The one-shot scripts pin the MicroPython UF2 URL and SHA-256 in `setup_wifi.py`. The firmware must
include `ssl.SSLContext`, `CERT_REQUIRED`, and `load_verify_locations`. Automatic extraction of the
OS-verified root CA in `setup_pico.py` requires host Python 3.13+.

Tool bootstrap downloads pinned universal wheels without pip or `ensurepip`. Pass its returned
environment to USB subprocesses; the downloaded modules must be on the child Python's `PYTHONPATH`.

## Connected hardware

Both hub Picos are RP2040 boards with an **external ESP8285 on UART0, TX GP0 / RX GP1, 115200 baud**.
Use `--wifi-transport esp8285`. A firmware label containing “Pico W” does not identify the physical radio.
Use `native` only for a board with a working native Pico W radio.

| MicroPython unique ID | Stable serial path | Hub device ID |
| --- | --- | --- |
| `5303284720e42a9c` | `/dev/serial/by-id/usb-MicroPython_Board_in_FS_mode_5303284720e42a9c-if00` | `pico-5303284720e42a9c` |
| `530328472857581c` | `/dev/serial/by-id/usb-MicroPython_Board_in_FS_mode_530328472857581c-if00` | `pico-530328472857581c` |

Use stable USB identity rather than a `/dev/ttyACM` number or DHCP address to select a board.
The radio on `5303284720e42a9c` uses ESP AT 1.6.2.0 / SDK 2.2.1, including TCP passthrough and SNTP commands.

## Flash and filesystem constraints

BOOTSEL exposes the UF2 mass-storage volume; MicroPython exposes the runtime serial device after
flashing. Check the volume's `INFO_UF2.TXT`, firmware digest, and UF2 chip family before writing.
Automatic selection requires exactly one BOOTSEL target. Check the returning MicroPython UID before
formatting; the runtime UID guard cannot identify a BOOTSEL volume before flashing.

A UF2 firmware update can retain the Pico's existing filesystem. Clean imaging must format it
explicitly. RP2 LittleFS uses `vfs.VfsLfs2` on `rp2.Flash()` with **`progsize=256`** for both formatting
and mounting. Preserve that flash programming alignment.

## USB operation

Inspect the attached device and select its explicit port. `mpremote` can automatically soft-reset before
operations; use `connect PORT resume exec ...` or `resume fs cp ...` when inspecting or copying without
that reset. Entering raw REPL still interrupts the running program. Capture USB output and emit only an
explicit result marker; existing startup output may contain private configuration.

Copying Wi-Fi settings from a source Pico also interrupts its program; the scripts reset that source
after reading. Check that the returning target UID differs from the source UID before formatting.

Persistent reporting requires `main.py` to invoke the health reporter at boot. Installation replaces
that startup file; having a reporter module present on the filesystem is insufficient.

`mpremote soft-reset` leaves the device in raw REPL and does **not** run startup. Use `mpremote reset`
after installation. For temporary reporting with the installed reporter, use
`SerialTransport.enter_raw_repl(soft_reset=False)` and
`exec_raw_no_follow("import main; main.run()")`, then close the transport without sending
Ctrl-C. Confirm subsequent reports through the hub; an acknowledgment alone does not establish persistence.

## ESP8285 recovery

Use `--wifi-transport esp8285`. A native interface showing inactive or `0.0.0.0` does not describe the
external radio's connection. Query `AT+CIFSR` for its station IP.

For join diagnostics, disable command echo with `ATE0`, select station mode with `AT+CWMODE_CUR=1`,
and join with `AT+CWJAP_CUR`. The `_CUR` commands avoid rewriting saved radio flash settings. The driver
escapes quoted arguments. Never print the join command, its echoed response, SSID, or password.

- `AT+CWLAP` scans; summarize whether the configured network is visible and its RSSI, rather than dumping names.
- `+CWJAP:3` means network not found. It does not establish that the password is wrong.
- If the responsive radio returns an empty scan, reset it with `AT+RST`, wait for boot, then reapply echo
  and station settings and retry once. Boot output is binary; decode with replacement when needed.
- `AT+CWLAPOPT=1,31` requests complete scan output.
- To recover from interrupted TCP passthrough, leave at least 1.1 seconds of silence before and after
  sending `+++`. Return to `AT+CIPMODE=0` and close the old connection before issuing ordinary commands.

## Verified TLS and health

The ESP radio carries TCP bytes in transparent mode (`CIPMUX=0`, `CIPMODE=1`, `CIPSTART="TCP"`, `CIPSEND`).
The Pico's `ssl.SSLContext` wraps the UART stream, sets `CERT_REQUIRED`, loads the DER root CA, and uses
the hub hostname for SNI and certificate verification. Keep certificate validation enabled.
`TCPStream` implements the MicroPython `io.IOBase` stream protocol (`readinto`, `write`, `ioctl`) so
the TLS context can wrap it.

The transport uses a 16 KiB UART receive buffer and a 30-second request deadline. An empty UART poll
does not mean EOF: reads wait for bytes until the deadline. Handle partial writes. Escape passthrough
and close TCP after a report or failed handshake.

Set the Pico's UTC clock before TLS validation. The ESP supports `AT+CIPSNTPCFG=1,0,"pool.ntp.org"` and
`AT+CIPSNTPTIME?`; the driver parses that date into `machine.RTC`. Native Pico W networking uses `ntptime`.
Generate boot IDs with `binascii.hexlify(os.urandom(16)).decode()` for MicroPython compatibility.

The default hub is `https://hub.jomaa.org`. Report to `POST /api/devices/DEVICE_ID/health` with the individual
device bearer token. First accepted report registers the pending device and saves a health log. Reports
include boot ID, increasing sequence, uptime, firmware, free heap, IP, status, and optional RSSI. Reuse the
same report on retries until acknowledged. Management and history use the administrator session.

Use the project's descriptive User-Agent for hub requests. Distinguish HTTP rejection, TLS validation
failure, and device authentication failure when diagnosing a missing heartbeat.

## Credentials and validation

The host administrator password is `HUB_PASSWORD` in `jomaa-home-hub/.env` or a supplied private file.
Add Device issues credentials through `POST /api/devices/enroll`. Each Pico has its own device bearer
token. Reuse a matching installed ID and credential for the same hub; replacement through
`POST /api/devices/DEVICE_ID/credential` requires `--rotate` and retains device history.

Provisioning puts the actual Wi-Fi password and device token in private `device_config.json` on the host
and on the Pico. The administrator password is never installed on the board.
Use a trusted root from an OS-verified certificate chain or verified CA source. Certificates returned
by an unverified peer are not a trust source. Keep passwords and tokens out of source, logs, and USB
diagnostic output.

Run `scripts/test_pico.py` to require three new database reports from one boot. It never opens USB and
leaves the running reporter alone. Existing online status and duplicate/out-of-order logs are insufficient.
The health UI is `/devices`. Device registration and accepted reports must be verified against the
configured hub's persisted records, including after a restart when checking startup persistence.

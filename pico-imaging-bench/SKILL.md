---
name: pico-imaging-bench
description: Image, provision, inspect, and troubleshoot a USB-connected Pico for the Jomaa hub's Wi-Fi health reporting, including the dev server's ESP8285 radio.
---

# Pico imaging and health

Use the scripts in this directory for imaging and verification. Read [README.md](README.md) for command
arguments and the complete imaging procedure. The implementation shares provisioning with
`../jomaa-home-hub/scripts/init_pico.py` and firmware with `../jomaa-home-hub/devices/pico-health/`.
Use `jomaa-daniel/jomaa-everything` as the upstream repository.

## One-shot enrollment and heartbeats

Use `python3 pico-imaging-bench/scripts/setup_pico.py --execute` on the USB host for complete setup
from BOOTSEL through hub registration and verified heartbeats. This needs Python 3.13+ and internet
access. It downloads verified tools and the pinned UF2, obtains Wi-Fi from a configured Pico or prompts,
and reads the administrator password from the hub's private `.env` or a supplied private file.

Enrollment uses the existing Add Device `/api/devices/enroll` endpoint. The device ID defaults to
the installed ID or `pico-UNIQUE_ID`; matching installed credentials are reused. Credential replacement requires `--rotate`.
The root CA is extracted from an OS-verified TLS chain. The installed reporter retains certificate
and hostname verification. Success requires three new persisted heartbeats from one boot.

Use `--configure-port` to install startup reporting on a selected MicroPython Pico while retaining its
filesystem, existing ID, and credential. Use `--target-port` to reimage a connected Pico via BOOTSEL.
Private run files include prepared configuration, a startup backup, image metadata, and the health result.
Linux mounting can prompt for administrator authentication for the selected volume; serial operations
use the current login's existing permissions.

## Standalone firmware and Wi-Fi

For base firmware and Wi-Fi setup, use `scripts/setup_wifi.py` on the USB host. It is a standalone
Python 3 script that downloads verified USB tools and the pinned MicroPython UF2. It requires serial
read/write access and a writable BOOTSEL mount. Linux uses `udisksctl` for user mounting; host policy
can require administrator access for mounting. macOS uses `diskutil`. It does not change host permissions.

Connect exactly one RP2040 Pico in BOOTSEL and run `python3 pico-imaging-bench/scripts/setup_wifi.py`
on Linux. To reimage a connected MicroPython Pico, add `--target-port` with its explicit serial path.
This reboots the selected target into BOOTSEL and checks its returning identity before filesystem erasure.
Use `--configure-port` with an explicit serial path to finish setup using installed MicroPython. This
checks target identity, erases its filesystem, installs Wi-Fi startup, and verifies the connection after restart.
The default radio transport is `esp8285`; select `--wifi-transport native` for a working native Pico W radio.

One additional configured Pico can supply Wi-Fi settings. Reading those settings interrupts its
program, and the script restarts it afterward. With no source Pico, the script prompts for the network
name and password. It installs `wifi_config.json` and `main.py` on the target and requires a Wi-Fi IP
after restart. Use `image_and_test.py` for hub enrollment and persisted health-report verification.

## Known dev-server hardware

- SSH: `jerry@192.168.1.239`; use the existing SSH access and keepalive configuration.
- The `jerry` SSH alias reaches a user SSH daemon through Cloudflare. For a fresh login with current
  account groups, use the system SSH daemon through that tunnel:
  `ssh -o HostKeyAlias=192.168.1.239 -J jerry jerry@127.0.0.1`. Check `id -nG` for `dialout`.
- Stable USB path: `/dev/serial/by-id/usb-MicroPython_Board_in_FS_mode_5303284720e42a9c-if00`;
  normally resolves to `/dev/ttyACM0`. Unique ID: `5303284720e42a9c`.
- The usable radio is an **external ESP8285**, UART0, TX GP0 / RX GP1, 115200 baud.
- The MicroPython build reports “Raspberry Pi Pico W with RP2040”, v1.29.0. That label identifies the
  firmware build. Its native `network.WLAN` scan fails with `EPERM`; the ESP8285 answers `AT` and joins
  Wi-Fi. Determine the actual transport by probing it.
- ESP AT version 1.6.2.0, SDK 2.2.1, build September 2019. Its TCP passthrough and SNTP commands work.
- An empty radio scan is fixed by resetting the radio. The board's address is usually `192.168.1.240`;
  DHCP can change it. Identify this board by its USB ID and hub ID.

## USB operation

Inspect the attached device and select its explicit port. `mpremote` can automatically soft-reset before
operations; use `connect PORT resume exec ...` or `resume fs cp ...` when inspecting or copying without
that reset. Entering raw REPL still interrupts the running program. Capture USB output and emit only an
explicit result marker; existing startup output may contain private configuration.

Installation writes the health reporter to `main.py`, replacing whatever startup file was there.

`mpremote soft-reset` leaves the device in raw REPL and does **not** run startup. Use `mpremote reset`
after installation. For temporary reporting, use `SerialTransport.enter_raw_repl(soft_reset=False)` and
`exec_raw_no_follow("import jomaa_health; jomaa_health.run()")`, then close the transport without sending
Ctrl-C. Confirm subsequent reports through the hub; an acknowledgment alone does not establish persistence.

Python on this server has neither pip nor `ensurepip`. `scripts/setup_tools.py --venv DIR` creates an
isolated environment from verified universal wheels; the server's is
`/home/jerry/.local/share/jomaa-pico-tools/bin/python`. Run USB commands on the host connected to USB.

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
- `AT+CWLAPOPT=1,31` enabled complete scan output during troubleshooting.
- To recover from interrupted TCP passthrough, leave at least 1.1 seconds of silence before and after
  sending `+++`. Return to `AT+CIPMODE=0` and close the old connection before issuing ordinary commands.

## Verified TLS and health

The ESP radio carries TCP bytes in transparent mode (`CIPMUX=0`, `CIPMODE=1`, `CIPSTART="TCP"`, `CIPSEND`).
The Pico's `ssl.SSLContext` wraps the UART stream, sets `CERT_REQUIRED`, loads the DER root CA, and uses
the hub hostname for SNI and certificate verification. Keep certificate validation enabled.

The transport uses a 16 KiB UART receive buffer and a 30-second request deadline. UART reads must wait for
data; treating the first empty read as EOF caused an invalid HTTP-status error despite a successful TLS
handshake. Handle short writes. Escape passthrough and close TCP after a report or failed handshake.

Set the Pico's UTC clock before TLS validation. The ESP supports `AT+CIPSNTPCFG=1,0,"pool.ntp.org"` and
`AT+CIPSNTPTIME?`; the driver parses that date into `machine.RTC`. Native Pico W networking uses `ntptime`.
Generate boot IDs with `binascii.hexlify(os.urandom(16)).decode()` for MicroPython compatibility.

The default hub is `https://hub.jomaa.org`. Report to `POST /api/devices/DEVICE_ID/health` with the individual
device bearer token. First accepted report registers the pending device and saves a health log. Reports
include boot ID, increasing sequence, uptime, firmware, free heap, IP, status, and optional RSSI. Reuse the
same report on retries until acknowledged. Management and history use the administrator session.

Use a descriptive User-Agent. Default Python urllib requests received Cloudflare 403, while
`jomaa-home-hub/init-pico`, `jomaa-pico-health/1.0.0`, and the bench's User-Agent worked. Distinguish edge
rejection from TLS failure and hub authentication failure.

## Credentials and validation

Host administrator password: `HUB_PASSWORD` in `/home/jerry/jomaa-everything/jomaa-home-hub/.env`.
`JOMAA_DEPLOY_SECRET` authenticates deployment webhooks and is a different credential. Existing GitHub
secret values cannot be retrieved. Do not put either password in source, CLI history, logs, or skill text.

Provisioning puts the actual Wi-Fi password and device token in private `device_config.json` on the host
and on the Pico. The administrator password is never installed on the board.
Use a trusted root from an OS-verified certificate chain or verified CA source, rather than trusting an
unverified peer certificate. The live dev board successfully reported with certificate validation and
rejected a TLS context without a trusted CA.

Run `scripts/test_pico.py` to require three new database reports from one boot. It never opens USB and
leaves the running reporter alone. Existing online status and duplicate/out-of-order logs are insufficient.
The health UI is `/devices`; check whether Cloudflare serves the deployed hub or an active Mac/SSH preview
before moving credentials or the health database. The preview depends on that Mac and tunnel remaining up.

Imaging changes firmware and formats the filesystem. The complete imaging command requires explicit
execution, UF2 digest, BOOTSEL volume, and returning serial port. An optional known unique ID guards the
filesystem wipe; it cannot identify the BOOTSEL volume before firmware is flashed. Preserve files first
when the task requires them, and do not treat a request to write scripts as permission to erase hardware.
Recent MicroPython uses `vfs` for filesystem management. The RP2 boot code formats and mounts LittleFS
with `progsize=256`; keep that flash programming alignment when clearing the filesystem.

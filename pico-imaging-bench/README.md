# Pico imaging bench

Image a selected Pico from MicroPython firmware through working Wi-Fi and verified HTTPS health reports.
The scripts reuse the hub's provisioning code and require three **new persisted reports from one boot** to pass.

The connected dev-server board uses an **ESP8285 on UART0, GP0/GP1, 115200 baud**. Select
`--wifi-transport esp8285` for it. Select `native` for a board with a working Pico W / Pico 2 W radio.
The firmware must include `ssl.SSLContext`, `CERT_REQUIRED`, and CA loading; a plain Pico firmware build
without those capabilities cannot run this reporter. The tested board currently uses MicroPython 1.29.0
with a Pico W build label. See [the Pico skill](SKILL.md) for hardware findings and recovery procedures.

## Tools

Run on the machine physically connected to USB, normally `jerry@192.168.1.239`:

```sh
python3 pico-imaging-bench/scripts/setup_tools.py --venv pico-imaging-bench/data/tools
```

Use `pico-imaging-bench/data/tools/bin/python` for the following commands. The bootstrap installs pinned
universal wheels with HTTPS and SHA-256 verification into a private virtual environment. It works without
system pip or `ensurepip` and leaves system Python untouched.

## Firmware and credentials

Obtain the intended MicroPython UF2 from its [official download page](https://micropython.org/download/)
or a trusted build. Supply its trusted SHA-256 digest; the bench checks UF2 block layout and MCU family too.
Do not infer physical radio hardware from a firmware build label.

Prepare private files containing only the Wi-Fi password and hub administrator password, with mode 600.
The live hub's `HUB_PASSWORD` is in `/home/jerry/jomaa-everything/jomaa-home-hub/.env`; the bench accepts
the password itself, rather than `.env` syntax. Existing GitHub secret values cannot be read back through
the GitHub API. A trusted root CA must come from a trusted OS store or verified CA distribution.

The administrator password stays on the host. Provisioning installs only the Wi-Fi settings, individual
device token, and root certificate on the Pico. Run outputs use directories with mode 700 and files with
mode 600; `data/`, firmware files, and certificates are ignored by Git.

## Image from scratch

Hold BOOTSEL while connecting the selected board. Mount its `RPI-RP2` volume on the host. The complete
command is below; replace the firmware, digest, mount, SSID, and private-file paths with the intended values:

```sh
pico-imaging-bench/data/tools/bin/python pico-imaging-bench/scripts/image_and_test.py \
  --uf2 /private/path/micropython.uf2 \
  --sha256 TRUSTED_FIRMWARE_SHA256 \
  --bootsel-volume /media/jerry/RPI-RP2 \
  --chip rp2040 \
  --port /dev/serial/by-id/usb-MicroPython_Board_in_FS_mode_5303284720e42a9c-if00 \
  --expected-uid 5303284720e42a9c \
  --wifi-transport esp8285 \
  --hub-url https://hub.jomaa.org \
  --id pico-5303284720e42a9c \
  --name "Dev server Pico" \
  --ssid "YOUR_WIFI_SSID" \
  --wifi-password-file /private/path/wifi-password.txt \
  --hub-password-file /private/path/hub-password.txt \
  --ca-cert /private/path/trusted-root.pem \
  --rotate \
  --run-dir pico-imaging-bench/data/runs/dev-pico-001
```

This validates the plan. Add **`--execute`** to perform it. **Execution erases every existing file on the
Pico filesystem**, installs the verified UF2, provisions the startup reporter, restarts it, and tests the
configured hub. Back up files before entering BOOTSEL when they need to be retained. USB device and mount
selection are explicit; the script never guesses which attached board to image.

Use `--rotate` for the already-enrolled dev Pico to replace its credential while retaining history. Omit it
for a new ID. Alternatively, pass a private UI credential JSON with `--credential-file`; administrator
access is still needed to verify persisted reports. Choose a new run directory for each run.
Execution applies the requested name and report interval to the hub, including when replacing an existing
credential. The default 15-second interval keeps three-report verification within the bench timeout;
change the ongoing interval afterward through `/devices` if desired.

The run directory contains `prepared/`, `image.json` with board identity and firmware digest, and
`report.json` with the observed health result. A run passes only after new reports with a Wi-Fi IP and
free-heap measurement appear in the hub database. Old online status, duplicate reports, and repeated
reboots do not satisfy the test. `--timeout` controls the bounded report wait.

On macOS, the BOOTSEL path is usually `/Volumes/RPI-RP2` and the serial path is `/dev/cu.usbmodem…`.
For Pico 2 / RP2350 ARM firmware, select `--chip rp2350` and the matching BOOTSEL volume and UF2.

## Separate operations

```sh
# Inspect one board; raw REPL interrupts its currently running program.
pico-imaging-bench/data/tools/bin/python pico-imaging-bench/scripts/inspect_pico.py \
  --port /dev/serial/by-id/YOUR_PICO --probe-esp8285

# Validate a flash by itself; add --execute to write it.
python3 pico-imaging-bench/scripts/flash_pico.py \
  --uf2 /private/path/micropython.uf2 --sha256 TRUSTED_FIRMWARE_SHA256 \
  --bootsel-volume /media/jerry/RPI-RP2

# Verify the existing reporter without opening USB or interrupting it.
pico-imaging-bench/data/tools/bin/python pico-imaging-bench/scripts/test_pico.py \
  --prepared pico-imaging-bench/data/runs/dev-pico-001/prepared \
  --hub-password-file /private/path/hub-password.txt \
  --report pico-imaging-bench/data/runs/dev-pico-001/recheck.json
```

## Verification

```sh
python3 -m unittest discover -s pico-imaging-bench/tests -v
```

Repository tests use synthetic UF2 data and a simulated BOOTSEL volume, test rejection before writing,
check the identity guard before filesystem erasure, and exercise persisted-report verification. CI never
flashes USB hardware. Complete filesystem erasure and reimaging remain explicit operator actions.

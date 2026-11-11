# Pico imaging bench

Image a selected Pico from MicroPython firmware through working Wi-Fi and verified HTTPS health reports.
The scripts reuse the hub's provisioning code and require three **new persisted reports from one boot** to pass.

The connected dev-server board uses an **ESP8285 on UART0, GP0/GP1, 115200 baud**. Select
`--wifi-transport esp8285` for it. Select `native` for a board with a working Pico W / Pico 2 W radio.
The firmware must include `ssl.SSLContext`, `CERT_REQUIRED`, and CA loading; a plain Pico firmware build
without those capabilities cannot run this reporter. The one-shot scripts pin MicroPython 1.29.0
with a Pico W build label. See [the Pico skill](SKILL.md) for hardware and protocol constraints.

## One-shot setup

Connect one RP2040 Pico in BOOTSEL mode and run on its USB host:

```sh
python3 pico-imaging-bench/scripts/setup_pico.py --execute
```

This requires Python 3.13+ and internet access. The script downloads verified USB tools and firmware,
obtains Wi-Fi settings, flashes MicroPython, creates a credential through the hub's existing Add Device
enrollment API, installs startup health reporting, and requires **three new persisted heartbeats from
one boot** before reporting success. Flashing erases the target filesystem. Without `--execute`, it
prints the plan and performs no USB or enrollment operations.

Wi-Fi settings come from the selected Pico or one additional configured Pico; otherwise the script
prompts for the network and password. It reads the hub administrator password from
`jomaa-home-hub/.env` by default, or prompts if that file is absent. `--hub-password-file` accepts a
private env file or password file. The administrator password stays on the host. The trusted root CA
comes from a TLS chain verified by the host OS; `--ca-cert` accepts an explicitly supplied trusted root.

The device ID defaults to the installed ID or `pico-UNIQUE_ID`. The name defaults to the enrolled name or `Pico UNIQUE_ID`;
`--id` and `--name` override those values. The default report interval is 15 seconds. Existing target
credentials are reused when the device ID matches. `--rotate` explicitly replaces an existing
credential while retaining its device history.

For a Pico with MicroPython installed, run:

```sh
python3 pico-imaging-bench/scripts/setup_pico.py --execute \
  --configure-port /dev/serial/by-id/usb-MicroPython_Board_in_FS_mode_530328472857581c-if00
```

This installs the health reporter and verifies heartbeats while retaining the filesystem. It replaces
`main.py` and the health configuration/modules, saving the target's prior startup in the private run
directory. Use `--target-port` to reimage a connected MicroPython Pico through BOOTSEL.

Runs are stored in `data/runs/` with private prepared firmware, `image.json`, a startup backup when
available, and `report.json`. `--run-dir` selects a new output directory. Serial read/write permissions
must be active in the current login. Linux mounting uses `udisksctl`; if mounting requires administrator
authentication, the script prompts through `sudo` for that mount operation in an interactive terminal.

## Tools

Run on the machine physically connected to USB:

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
The hub's `HUB_PASSWORD` is in `jomaa-home-hub/.env`. The explicit imaging commands accept a file
containing the password itself; `setup_pico.py` also accepts the env file. A trusted root CA must come
from a trusted OS store or verified CA distribution.

The administrator password stays on the host. Provisioning installs only the Wi-Fi settings, individual
device token, and root certificate on the Pico. Run outputs use directories with mode 700 and files with
mode 600; `data/`, firmware files, and certificates are ignored by Git.

## Base firmware and Wi-Fi

`scripts/setup_wifi.py` is a standalone setup for an RP2040 Pico. Connect one Pico in BOOTSEL mode and
run on the Linux USB host:

```sh
python3 pico-imaging-bench/scripts/setup_wifi.py
```

The script supports Linux and macOS and needs Python 3 and internet access. It downloads and verifies
its USB tools and the official MicroPython firmware, mounts the BOOTSEL volume if necessary, flashes
the firmware, finds the returning serial device, **erases the Pico filesystem**, and installs Wi-Fi
startup. It requires a successful connection with an IP address after restarting. The current login
must have read/write serial access and write access to the mounted BOOTSEL volume. On Linux, the script
uses `udisksctl` to mount as the current user; if host policy denies mounting, it requests administrator
authentication for the selected mount in an interactive terminal. On macOS it uses
`diskutil`. The script checks device access and does not change host permissions.

To reimage a Pico already running MicroPython, select its serial port. The script puts that board into
BOOTSEL, flashes it, and checks its identity before erasing its filesystem. Disconnect any other
BOOTSEL boards before using this option:

```sh
python3 pico-imaging-bench/scripts/setup_wifi.py \
  --target-port /dev/serial/by-id/usb-MicroPython_Board_in_FS_mode_530328472857581c-if00
```

To finish Wi-Fi setup on a Pico with MicroPython installed, including an interrupted setup after a
successful flash, use `--configure-port`. This retains the installed firmware, **erases the target
filesystem**, installs Wi-Fi startup, and verifies the connection after restart:

```sh
python3 pico-imaging-bench/scripts/setup_wifi.py \
  --configure-port /dev/serial/by-id/usb-MicroPython_Board_in_FS_mode_530328472857581c-if00
```

If one configured Pico is connected, the script copies its Wi-Fi settings, interrupts its running
program, and restarts it. Otherwise it prompts for the network name and password. The password is stored
on the new Pico in `wifi_config.json`. Connect only one BOOTSEL Pico and at most one existing
MicroPython Pico in addition to the selected target. The script stops if more than one new serial device appears.

The default Wi-Fi transport is an ESP8285 on UART0, GP0/GP1. For a working native Pico W radio, run:

```sh
python3 pico-imaging-bench/scripts/setup_wifi.py --wifi-transport native
```

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

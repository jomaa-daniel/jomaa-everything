# jomaa-images

The Devices page shows USB Picos attached to the Linux hub server. Selecting a board opens the imaging panel with the functions in `config.json`. Health check requires Wi-Fi; I²C raw logging requires both. Temperature reading uses the Pico's internal sensor and emits Celsius over USB. I²C logging performs active reads on the configured buses.

`Flash image` confirms the target and filesystem erasure, then starts a server-owned run. The panel shows progress and each selected function's observed evidence. Closing the panel does not cancel imaging. Run summaries are private and retained according to `retentionHours`; interrupted runs fail on hub restart. Prepared files remain in the private run directory.

The host needs Python, internet access for verified USB tools and firmware, readable/writable serial devices, and permission to mount the selected BOOTSEL volume with `udisksctl`. Imaging is noninteractive and does not run sudo. Health images need the hub service's `HUB_PASSWORD` environment and a trusted root CA through `trustedCaFile` or OS-verified chain extraction. The administrator password is never installed on the Pico. Wi-Fi credentials arrive over stdin and exist only in private prepared/device configuration.

Only the selected board is opened. A runtime board's returning unique ID is checked before formatting; a BOOTSEL board without a known runtime ID is identified by its USB bootloader identity before writing and checked after firmware returns. Multiple BOOTSEL targets are refused. Flashing validates the trusted UF2 digest, block layout, chip family and BOOTSEL volume, then formats LittleFS with the required flash alignment.

## Commands

The operator applies USB access on the hub server with the root setup command:

```
python3 jomaa-images/setup_server.py
sudo python3 jomaa-images/setup_server.py --execute
```

The first command shows the policies. Execution grants the configured group access to matching Pico serial/block devices and permits noninteractive mounting only for the configured BOOTSEL USB identity and filesystem label. It reloads udev and updates matching attached device permissions. This root step is run by the user; ordinary deployment and imaging do not run sudo.

Run from the repository root:

```
python3 jomaa-images/images.py catalog
python3 jomaa-images/images.py discover
python3 jomaa-images/images.py prepare --output NEW_PRIVATE_DIRECTORY
python3 jomaa-images/images.py flash --target TARGET_ID
```

Preparation and flashing read one JSON request from stdin, such as `{"features":["temperature"]}`. Wi-Fi images add `wifi` with `ssid`, `password` and `transport` (`esp8285` or `native`); pass credentials through private input, never command-line arguments. `--config FILE` chooses host settings. Preparation opens no USB devices. Flashing performs erasure; it emits structured stage, check and final-result events. Discovery and catalog emit one JSON object.

## Verification

The installed startup emits its unique install ID, runtime UID, boot ID and selected features. The host reads these without entering raw REPL. Health passes after the configured count of new persisted reports from this boot, Wi-Fi after an observed valid IP, temperature after a finite Celsius sample, and I²C after a new persisted capture without capture errors. Empty captures are described as having no responding devices. Overall success requires all selected checks and installed startup execution after reset.

```
python3 -m unittest discover -s jomaa-images/tests -v
```

Tests use synthetic USB inventories, streams and hub records. They do not flash physical hardware. The images deployment module preserves private state, and the hub declares the component and bench as deployment inputs. Settings are described in [config.md](config.md).

# jomaa-images

The Devices page's **Imaging** tab shows USB Picos attached to the Linux hub server. Selecting a runtime board reads its installed image and preselects its functions. Saved Wi-Fi settings are selected automatically; clear **Use saved Wi-Fi settings** to enter a different network or radio. The saved password stays on the host and Pico. Reading installed settings briefly interrupts the selected board and restarts it afterward. BOOTSEL boards use the default functions in `config.json` because their files cannot be read until MicroPython runs.

Health check requires Wi-Fi; I²C raw logging and PWM fan control require both. Temperature reading uses the Pico's internal sensor and emits Celsius over USB. I²C logging performs active reads on the configured buses.

`Flash image` confirms the target and filesystem erasure, then starts a server-owned run. The panel shows progress and each selected function's observed evidence. Closing the panel does not cancel imaging. Run summaries are private and retained according to `retentionHours`; interrupted runs fail on hub restart. Prepared files remain in the private run directory.

The host needs Python, internet access for verified USB tools and firmware, readable/writable serial devices, and permission to mount the selected BOOTSEL volume with `udisksctl`. Imaging is noninteractive and does not run sudo. Health images need the hub service's `HUB_PASSWORD` environment and a trusted root CA through `trustedCaFile` or OS-verified chain extraction. The administrator password is never installed on the Pico. Wi-Fi credentials arrive over stdin and exist only in private prepared/device configuration.

Only the selected board is opened. A runtime board's returning unique ID is checked before formatting; a BOOTSEL board without a known runtime ID is identified by its USB bootloader identity before writing and checked after firmware returns. Multiple BOOTSEL targets are refused. Flashing validates the trusted UF2 digest, block layout, chip family and BOOTSEL volume, then formats LittleFS with the required flash alignment.

## Commands

The operator applies USB access on jerry from the current release with the root setup command. Push first, so the current release has the script:

```
ssh jerry python3 .local/share/jomaa-deploy/current/jomaa-images/setup_server.py
ssh -t jerry sudo python3 .local/share/jomaa-deploy/current/jomaa-images/setup_server.py --execute
```

The first command shows the policies. Execution grants the configured group access to matching Pico serial/block devices and permits noninteractive mounting only for the configured BOOTSEL USB identity and filesystem label. It reloads udev and updates matching attached device permissions. This root step is run by the user; ordinary deployment and imaging do not run sudo.

Run from the repository root:

```
python3 jomaa-images/images.py catalog
python3 jomaa-images/images.py discover
python3 jomaa-images/images.py state --target TARGET_ID
python3 jomaa-images/images.py prepare --output NEW_PRIVATE_DIRECTORY
python3 jomaa-images/images.py flash --target TARGET_ID
```

Preparation and flashing read one JSON request from stdin, such as `{"features":["temperature"],"wifi":null}`. Wi-Fi images set `wifi` to an object with `ssid`, `password` and `transport` (`esp8285` or `native`); pass credentials through private input, never command-line arguments. Flashing accepts a null `password` to reuse the selected runtime Pico's saved password, with a matching network and transport; an empty string explicitly selects an open network. Saved settings are read and validated before firmware writing or filesystem erasure. `--config FILE` chooses host settings. Preparation opens no USB devices and requires explicit credentials. Flashing performs erasure; it emits structured stage, check and final-result events. Discovery, catalog and state emit one JSON object; state excludes passwords and device tokens.

## Fan control

Select **PWM fan control** to install a hardware PWM output controlled through the Pi hub's API. Wi-Fi and health are selected as prerequisites. The installed settings come from `fan` in [config.json](config.json), documented in [config.md](config.md). The output starts at `fan.startupPercent` before Wi-Fi or TLS setup and holds its last applied duty during network failures. Hardware PWM continues during uploads and retries. Reboot applies the startup duty, then retrieves the persisted hub setting.

The electrical profile is for a separately powered four-wire fan with a PWM control input. Connect `fan.gpio` to a suitable transistor or open-drain driver and share ground with the fan supply. `fan.inverted` describes that driver's polarity. The Pico GPIO must not power the fan or receive its supply voltage. Confirm the fan's PWM frequency, stop behavior and driver wiring before flashing. The tachometer wire is not sampled by this feature.

The API uses the Matter Fan Control cluster's attribute names and enum values. It supports Off, Low, Medium and High modes, with `fan.lowPercent` and `fan.mediumPercent` defining their ranges. The transport is the existing authenticated HTTPS device channel. This image does not advertise or commission as a Matter endpoint.

| Method | API | Body / response |
| --- | --- | --- |
| GET | `/api/devices/{id}/fan` | Returns `fan`, including `fanMode`, `fanModeSequence`, `percentSetting`, `percentCurrent`, `revision`, `appliedRevision`, `pending`, `available` and peripheral readback in `report`. |
| PUT | `/api/devices/{id}/fan` | Write exactly one attribute: `{"percentSetting":50}` or `{"fanMode":0}`. Returns 202 with the requested state; poll GET until `pending` is false. |
| POST | `/api/devices/{id}/fan/report` | Device-only report and command exchange using the individual device bearer token over verified HTTPS. |

GET and PUT require an owner session or the Devices scope. Fan modes follow Matter: Off is 0, Low is 1, Medium is 2, High is 3. A percent setting of 0 requests off and 100 requests maximum output. Null `percentSetting` leaves the setting unchanged. Unsupported attributes and modes are rejected. Repeating the same setting retains its revision. A new setting remains pending until a report acknowledges its revision. The reporter exchanges fan state at `fan.pollMilliseconds`; network operations can delay delivery.

`percentCurrent` reports the PWM peripheral's logical duty, not measured RPM or airflow. It becomes null when reports are older than `fan.staleMilliseconds` or health is offline. `report` retains the last observation and its identity. A fan that keeps spinning at zero PWM cannot be physically turned off through its PWM input alone. Firmware readback does not establish an electrical waveform or fan rotation.

## Verification

The installed startup emits its unique install ID, runtime UID, boot ID and selected features. The host reads these without entering raw REPL. Health passes after the configured count of new persisted reports from this boot, Wi-Fi after an observed valid IP, temperature after a finite Celsius sample, and I²C after a new persisted capture without capture errors. Fan control requires PWM peripheral readback from this installation that matches a fresh hub report acknowledging the requested revision. Empty captures are described as having no responding devices. Overall success requires all selected checks and installed startup execution after reset.

```
python3 -m unittest discover -s jomaa-images/tests -v
```

Tests use synthetic USB inventories, streams and hub records. They do not flash physical hardware. The images deployment module preserves private state, and the hub declares the component and bench as deployment inputs. Settings are described in [config.md](config.md).

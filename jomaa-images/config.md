# Imaging settings

`config.json` configures the USB imaging component and the hub's imaging adapter. Its documentation check covers every setting.

| Setting | Meaning |
| --- | --- |
| `command` | Interpreter and component entrypoint, run from the release root without a shell. |
| `benchScripts` | Existing Pico tool directory relative to the release root. |
| `hubDeploy` | Existing hub deployment declaration; its first route supplies the HTTPS hostname. |
| `runDirectory` | Private prepared image directories relative to the release root. |
| `runStateFile` | Private persisted run summaries relative to the release root. |
| `lockFile` | Private host lock shared by command-line and browser imaging runs. |
| `trustedCaFile` | Trusted root CA file, PEM or DER; null selects the OS-verified hub chain and requires Python with `get_verified_chain`. |
| `commandTimeoutSeconds` | Discovery, catalog and host command deadline. |
| `flashTimeoutSeconds` | Whole imaging subprocess deadline. |
| `verificationSeconds` | Deadline for observations from the installed startup. |
| `usbTimeoutSeconds` | Deadline for a USB console operation. |
| `returnTimeoutSeconds` | Deadline for a board changing USB mode. |
| `pollMilliseconds` | Browser status polling, USB observation reads, and persisted report checks. |
| `retentionHours` | Lifetime of terminal run summaries. |
| `maxOutputBytes` | Maximum command output and incomplete USB observation buffer size. |
| `maxRequestBytes` | Maximum encoded image request accepted by the hub and command. |
| `healthReports` | Required new persisted heartbeats from the installed boot. |
| `healthIntervalSeconds` | Reporter interval selected during imaging verification. |
| `defaultWifiTransport` | Initially selected physical radio transport in the imaging panel. |
| `setup` | One-time root-owned USB access policies applied only by the operator. |
| `setup.group` | Existing group granted Pico serial access and BOOTSEL mount permission. |
| `setup.udevRulesFile` | Absolute destination for the root-owned Pico device rules. |
| `setup.polkitRulesFile` | Absolute destination for the root-owned BOOTSEL mount policy. |
| `setup.udevadm` | Absolute udev command used for rule reload, device identity lookup and targeted change events. |
| `discovery` | Linux USB discovery settings. |
| `discovery.ttyDirectory` | Kernel tty device inventory. |
| `discovery.blockDirectory` | Kernel block device inventory. |
| `discovery.deviceDirectory` | Host device nodes. |
| `discovery.serialDirectory` | Stable serial device links. |
| `discovery.vendorId` | USB vendor to include. |
| `discovery.runtimeProductId` | MicroPython runtime USB product. |
| `discovery.bootselProductId` | RP2040 BOOTSEL USB product. |
| `discovery.bootselLabel` | BOOTSEL filesystem label required for discovery and mount authorization. |
| `discovery.blockCommand` | Command returning block paths, labels and mountpoints as lsblk JSON. |
| `discovery.mountCommand` | Noninteractive mount command, followed by the selected block device path. |
| `telemetry` | Installed USB observations and internal temperature sensor calibration. |
| `telemetry.sampleMilliseconds` | Minimum interval between USB observations and temperature samples, and the Wi-Fi-only connection check interval. |
| `telemetry.idleMilliseconds` | Main loop delay for an image without health reporting. |
| `telemetry.baud` | Host USB serial observation baud rate. |
| `telemetry.temperatureAdc` | ADC channel of the internal temperature sensor. |
| `telemetry.referenceVolts` | ADC supply voltage used to convert the unsigned sample. |
| `telemetry.referenceCelsius` | Calibration reference temperature. |
| `telemetry.referenceSensorVolts` | Sensor output voltage at the reference temperature. |
| `telemetry.voltsPerCelsius` | Sensor voltage change per Celsius degree. |
| `fan` | Hardware PWM output and Matter Fan Control attribute mapping. |
| `fan.gpio` | Pico GPIO connected to the fan's PWM driver input; must not overlap the selected radio or I²C pins. |
| `fan.frequencyHz` | Requested hardware PWM frequency. The runtime reports the frequency read back from the PWM peripheral. |
| `fan.inverted` | Invert GPIO duty for an inverting transistor or open-drain driver, so logical fan duty remains proportional to the requested percent. |
| `fan.startupPercent` | PWM percent applied at boot until an authenticated hub command arrives. |
| `fan.lowPercent` | Low mode duty and upper boundary of the Low percent range. |
| `fan.mediumPercent` | Medium mode duty and upper boundary of the Medium percent range; exceeds `fan.lowPercent` and is below maximum duty. |
| `fan.pollMilliseconds` | Minimum interval between fan state exchanges on the reporter's shared verified HTTPS connection. Network operations and retries can extend the interval. |
| `fan.staleMilliseconds` | Age after which reported PWM duty is unavailable in the API; must exceed `fan.pollMilliseconds`. |
| `features` | Ordered supported image options. |
| `features[].id` | Function ID used in requests and image manifests. |
| `features[].label` | Checkbox label. |
| `features[].description` | Function description shown beside the checkbox. |
| `features[].requires` | Prerequisite function IDs. |
| `features[].default` | Initial checkbox state. |

Firmware source and trusted digest are read from the existing bench tool's firmware settings. I²C pins, sampling and transport limits are read from the existing Pico stream settings; the receiver's byte limit is read from the hub settings. A runtime image uses the selected physical radio; a Pico W firmware label does not identify an external radio.

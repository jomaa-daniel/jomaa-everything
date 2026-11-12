# Wi-Fi device health

This feature runs inside the merged TypeScript Matter hub. It uses the hub's existing administrator login,
HTTP server, and logger. The health inventory is separate from the light configuration and Matter fabric,
so health reporting works while the Matter controller is starting or when the hub runs with `--no-matter`.

## What is included

- MicroPython health firmware for **Pico W / Pico 2 W**, or an RP2040 board with an **ESP8285** on UART0 (GP0/GP1, 115200 baud).
- A provisioning script that prepares firmware, Wi-Fi settings, and a dedicated credential. USB installation is an explicit option.
- Automatic registration on the first authenticated report, persistent inventory, and SQLite health history.
- A minimal management page at **`/devices`**: search, status filter, enrollment, details, history, rename, report interval, credential replacement, and access revocation.

## Run the hub

Use Node 22.13 or newer. SQLite is included in Node; no database service or extra database dependency is required.
From `jomaa-home-hub`:

```sh
npm ci
npm run build
node --env-file=.env dist/main.js --config config.json
```

The build copies the management page into `dist/web`. Include that directory when packaging the compiled hub.
Open `https://jomaa.org/devices` and sign in with the hub password or an account with the `devices` scope.
Add device scans the home network for Matter devices advertising for pairing or
sharing. Scans continue while the discovery window is open. Pair and register on
a discovered device opens the setup-code form. Successful network pairing stores
the node in the Matter fabric and lists it in the inventory with its connection
status and device details. Create device credential opens the Pico enrollment form.
Matter names can be edited in device details. The hub stores these names and
contact timestamps in its Matter data. Last seen comes from successful Matter
communication; uptime is the device's General Diagnostics report. Available
nodes are checked every 30 seconds. Unsupported uptime displays Unavailable.
Inventory rows include Type, Capabilities and Group. Matter rows describe
reported device types and functions and list their configured rooms, including
nested groups. Health reporter rows identify their reporting role.
Matter lights and plugs can be assigned to an existing group or No group from
their details. Saving updates the configured targets and room fan-out.
The hub's root URL redirects to `/devices`, including on the Cloudflare hostname.

The native hub stores health history in `data/health.sqlite`, shared between
releases through the deployment state directory.

For a local development instance that cannot contact any lights, save this layout outside the live configuration:

```json
{ "listen": "127.0.0.1:8085", "devices": [], "rooms": [] }
```

Run `node --env-file=.env dist/main.js --no-matter --config /path/to/dev-config.json` and open
`http://127.0.0.1:8085/devices`. Local development supports inventory management; device health reports still require HTTPS.

| Environment variable    | Default              | Purpose                                                                    |
| ----------------------- | -------------------- | -------------------------------------------------------------------------- |
| `HEALTH_DB_PATH`        | `data/health.sqlite` | Local SQLite file. Use a persistent disk or container volume.              |
| `HEALTH_RETENTION_DAYS` | `30`                 | Health history retention, 1–3650 days. Cleanup runs at startup and hourly. |
| `HUB_TLS_CERT`          | unset                | Full certificate chain PEM for direct HTTPS.                               |
| `HUB_TLS_KEY`           | unset                | Private key PEM for direct HTTPS. Set both TLS paths together.             |

The existing local Cloudflare tunnel can provide HTTPS at `https://hub.jomaa.org`. It forwards to the hub's HTTP listener.
The hub trusts `X-Forwarded-Proto: https` only on loopback connections, matching the existing tunnel configuration.
Keep the HTTP listener protected from untrusted processes on the hub machine. For direct LAN access, configure
the TLS certificate/key instead; forwarding headers from another LAN machine do not authorize plaintext reports.

The Pico must trust the certificate's **root CA** and verify the hub hostname. Obtain a root certificate from a trusted
OS certificate store, your CA's verified distribution, or your own LAN CA. The provisioning script accepts one PEM
or DER root certificate and converts it to DER for MicroPython. Do not use an unverified certificate downloaded
from the target as a new trust root. When the issuing root changes, provision the new CA on the device.

## Prepare a Pico without USB access

The board must already run a recent MicroPython build with `ssl.SSLContext`, `ssl.CERT_REQUIRED`, and
`load_verify_locations`. The default native transport also needs `network.WLAN`. The ESP8285 transport needs
`machine.UART`, `io.IOBase`, and AT firmware supporting TCP passthrough and SNTP. The firmware deliberately
fails if verified TLS is unavailable. This script does not install MicroPython or flash a UF2 image.

```sh
python3 scripts/init_pico.py \
  --hub-url https://hub.jomaa.org \
  --id pico-office \
  --name "Office Pico" \
  --ssid "Your Wi-Fi SSID" \
  --ca-cert /path/to/trusted-root-ca.pem \
  --output data/provisioning/pico-office
```

The script prompts for the Wi-Fi and hub passwords. It enrolls a pending device and creates:

- `main.py`: the startup health reporter.
- `device_config.json`: hub hostname, individual device credential, Wi-Fi settings, and report interval.
- `health_ca.der`: the trusted root certificate.

For a board using the external ESP8285 radio, add **`--wifi-transport esp8285`**. Preparation also includes
`esp8285.py`. The radio joins Wi-Fi and carries ordinary TCP bytes; the Pico runs TLS with the same required
root CA and hostname verification as the native transport. The radio's older built-in SSL implementation
is not used. ESP8285 SNTP sets the Pico's clock before certificate verification. UART TCP reads have a
30-second request deadline and TCP passthrough is closed after each report.

The directory uses mode 700 and files use mode 600. The output directory must be new. Generated files under
`data/` are ignored by Git. The script does not print passwords or tokens. This default command **never opens USB**.

For noninteractive use, `--wifi-password-file` and `--hub-password-file` read private files containing only
the corresponding password, not `.env` syntax. Secret files must have mode 600 or stricter.

If you created the device in the UI, download the credential there, make the file private (`chmod 600`),
and pass `--credential-file /path/to/pico-office-credential.json` to skip enrollment. The JSON contains `id` and `token`.
For an already enrolled device, `--rotate` issues a replacement credential using the administrator login.
Rotation invalidates the old token while preserving inventory and history. Choose a new output directory each time.

## Install over USB when deliberately selected

Install `mpremote` on the machine physically connected to the selected board:

```sh
python3 -m pip install mpremote
```

Add **both** `--install` and `--port /dev/serial/by-id/YOUR-PICO` to the preparation command. The script never
auto-selects a port. It checks networking/TLS capabilities, copies the prepared files (including `esp8285.py`
when selected) over whatever is on the board, and restarts MicroPython.
Installation writes to and restarts the selected device; preparation alone does neither.

If installation fails partway through, the prepared files remain available; copy them manually with `mpremote`. If files were already prepared using a newly issued token,
use the UI credential file for another preparation rather than enrolling the same ID again.

No USB device is changed during the repository tests. The server board (`5303284720e42a9c`) labels itself
Pico W, but its native Wi-Fi scan fails with `EPERM`; its usable radio is the external ESP8285.

## Reports and status

The firmware connects to Wi-Fi, sets its clock with NTP for certificate validity checks, verifies TLS with the
configured root CA and hostname, then sends a report every 60 seconds by default. The hub response supplies the
next interval, so changes in the UI take effect on the next successful report. Failures retry with a 5–60 second
backoff, reuse the same report until acknowledged, and reconnect Wi-Fi when necessary.

Each report includes a random boot ID, increasing sequence number, firmware version, uptime, free heap,
IP address, optional RSSI, and `healthy` or `degraded` state. Low free heap produces a degraded report and message.
Serial output records acknowledgments and failures without including credentials. Hub history stores each
accepted report and its **server receipt time**. Duplicate or out-of-order reports from the same boot do not
append history or update the last-seen timestamp. New reports must be at least five seconds apart.

| Inventory status | Meaning                                                                           |
| ---------------- | --------------------------------------------------------------------------------- |
| Pending          | A credential has been issued; no health report has registered the device yet.     |
| Online           | A recent healthy report was received.                                             |
| Degraded         | A recent report indicates a health problem.                                       |
| Offline          | No report for more than three configured intervals, with a minimum of 90 seconds. |
| Revoked          | The hub refuses reports using this device's credential. History is preserved.     |

Inventory and the most recent report survive hub restarts. Historical logs expire according to retention.
Credentials are randomly generated per device and stored only as SHA-256 hashes. The SQLite file is mode 600.
Device credentials grant access to that device's report endpoint only, never to administrator or Matter operations.
The token and Wi-Fi password necessarily exist on the board; possession of its filesystem exposes them.

## API

Management routes require the existing hub session (bearer token or `hub_auth` cookie). Credential issuance
requires HTTPS or loopback access; cookie mutations reject cross-origin requests.

| Method | Path                           | Purpose                                                                                                  |
| ------ | ------------------------------ | -------------------------------------------------------------------------------------------------------- |
| GET    | `/api/devices`                 | List Pico inventory, paired Matter nodes, controller readiness and derived status.                       |
| POST   | `/api/devices/enroll`          | Issue a credential; body: `id`, `name`, optional `intervalSeconds`. Returns the token once.              |
| GET    | `/api/devices/{id}`            | Device details.                                                                                          |
| PATCH  | `/api/devices/{id}`            | Update `name` and/or `intervalSeconds` (15–3600).                                                        |
| GET    | `/api/devices/{id}/logs`       | History, newest first; `limit` 1–200 and optional `before` cursor. Response includes `nextCursor`.       |
| POST   | `/api/devices/{id}/credential` | Replace the credential and enable reporting again. Returns the new token once.                           |
| POST   | `/api/devices/{id}/revoke`     | Revoke reporting access and retain history.                                                              |
| POST   | `/api/devices/{id}/health`     | Verified HTTPS plus that device's bearer credential. Register on first report and append health history. |

A health report is a JSON object such as:

```json
{
  "bootId": "0123456789abcdef0123456789abcdef",
  "sequence": 0,
  "firmware": "jomaa-pico-health/1.0.0",
  "uptimeSeconds": 120,
  "freeHeapBytes": 128000,
  "rssi": -51,
  "ip": "192.168.1.110",
  "status": "healthy"
}
```

`message` is optional, up to 240 printable characters. Unknown fields and invalid values are rejected.
Health requests have a 4 KiB body limit. First registration returns 201; subsequent acknowledgments return 200,
including `duplicate` and `nextIntervalSeconds`. An unrecognized or revoked credential returns 401, plaintext
returns 426, and rate limiting returns 429. Devices should keep credentials out of URL query strings and logs.

## Verification

```sh
npm test
python3 -m unittest discover -s scripts -p test_init_pico.py -v
npx eslint src/health src/api.ts src/main.ts
```

Tests cover actual HTTPS certificate trust, separation of administrator/device credentials, first registration,
invalid reports, idempotent retries, revocation, persistence, file permissions, offline status, retention, pagination,
private preparation without USB/network access when using a supplied credential, and the firmware HTTP parser.
For browser verification, use an isolated local hub with test devices instead of connecting to physical lights or the Pico.

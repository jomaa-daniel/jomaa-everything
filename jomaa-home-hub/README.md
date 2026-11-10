# jomaa-home-hub

One hub for every light in the house, Matter or Govee. Send a command to a room
and it goes to every device in that room at once. A sync pass then checks each
device and fixes any that didn't change.

```
phone / web / hubctl.py
        │  HTTP (one API for every brand)
        ▼
   hub (TypeScript, one process)
   ├─ rooms, fan-out, sync
   ├─ Matter controller ──── Matter ───▶ Matter devices
   └─ Govee client ───────── HTTPS ───▶ Govee cloud ──▶ Govee lights
```

The hub runs the controller library from the
[Open Home Foundation Matter server](https://github.com/matter-js/matterjs-server)
(the one Home Assistant uses) inside its own process. The hub and the
controller call each other directly: commands go straight to the controller,
and the controller's live copy of each device's attributes is what the hub
reads for state. There is no separate Matter server or WebSocket.

## Run it on Linux without Docker

The native setup installs the hub's dependencies at the versions
`package-lock.json` pins, builds it, then creates user-level systemd services.
It needs Linux x86-64 or arm64, Python 3.12+, Node.js 22.13+, npm, systemd and
an internet connection. A Thread border router is also needed for Thread
devices.

```bash
python3 scripts/setup_native.py
python3 scripts/hubctl.py status
```

The first run creates an empty `config.json` and a private `.env` with a
generated `HUB_PASSWORD`. Register lights with `scripts/onboard_lights.py` and, if
using Govee, set `GOVEE_API_KEY` in `.env`. Existing files and Matter pairing
data are preserved. `config.example.json` shows the format; its Matter node is
an example, not a paired device.

The setup enables user lingering so services start at boot without a login.
Systemd runs `scripts/setup_native.py --boot` to check the installation, then
`scripts/boot_native.py` to launch each service. Boot never downloads software
or creates Cloudflare resources. To inspect or restart the services:

```bash
systemctl --user status jomaa-hub jomaa-cloudflared
systemctl --user restart jomaa-hub
journalctl --user -u jomaa-hub -f
```

The tunnel service exists only if configured below. After changing `.env` or
`config.json`, restart the hub. Restarting the hub restarts its Matter
controller too; devices reconnect within seconds. Backup `data/native/matter-data` to preserve
the Matter fabric; losing it means re-pairing devices. Bluetooth pairing uses
adapter 0 over D-Bus; set `MATTER_BLUETOOTH_ADAPTER` in `.env` for another
adapter. The Bluetooth service and adapter must be enabled on the host. Set
`MATTER_LOG_LEVEL` (`debug`, `info`, `notice`, `warn`, `error`; default
`notice`) for more or less Matter detail in the journal.

## Run it with Docker

Needs a machine on your home network that stays on (a Pi, NAS or mini PC) with
Docker and Python 3. Thread devices also need a Thread border router on the
network (an Apple TV, HomePod mini or Nest hub). One container runs the hub
and its Matter controller; Matter data stays in `data/matter`.

```bash
cp config.example.json config.json   # list your devices and rooms
cp .env.example .env                 # set HUB_PASSWORD and GOVEE_API_KEY
python3 scripts/hubctl.py up         # starts the hub, waits until it and Matter are ready
python3 scripts/hubctl.py status
```

`hubctl.py dev` builds and runs the hub from source without Docker, for
working on the hub. It keeps Matter data in `data/matter`.

## Reach it from anywhere with native services

For a domain on Cloudflare, run:

```bash
python3 scripts/setup_native.py --tunnel hub.yourdomain.com
```

The setup downloads a verified `cloudflared` binary if necessary, prompts for
Cloudflare browser authorization, creates a locally managed tunnel and DNS
record, and enables a user service. Use `--tunnel-name NAME` to choose a name
or reuse an existing locally managed tunnel whose credentials are on this
machine. Existing `data/native/tunnel.yml` settings are not overwritten. Keep
`~/.cloudflared` private and back it up with the Matter data.

The tunnel serves the hub over HTTPS at the chosen hostname. Find the hub
password in the private `.env` file. The hub remains on loopback. Cloudflare account API tokens are not required
for this native tunnel. The existing `cloudflare.py deploy` and GitHub workflow
manage a different kind of tunnel and must not be used to manage this one.

## Deploy native hub changes from GitHub

`.github/workflows/hub-deploy-native.yml` verifies hub changes pushed or merged
to `main` on GitHub-hosted runners, then sends a signed HTTPS request to
`https://hub.jomaa.org/deploy`. Cloudflare routes that path to a local
deployment receiver; no inbound router port or self-hosted GitHub runner is
needed. The receiver checks the signature, timestamp, repository, commit, and
GitHub verification job before fetching the exact revision. The installer
defaults to `jomaa-daniel/jomaa-everything` and accepts `--repo OWNER/REPOSITORY`.

After committing the deployment scripts and running the native tunnel setup,
install the receiver once from the hub checkout:

```bash
python3 scripts/deploy_native.py install --repo jomaa-daniel/jomaa-everything
gh secret set HUB_DEPLOY_SECRET --repo jomaa-daniel/jomaa-everything < ~/.local/share/jomaa-home-deploy/webhook-secret
systemctl --user status jomaa-deploy.service
journalctl --user -u jomaa-deploy.service -n 50 --no-pager
```

Each verified revision is built in a separate release directory under
`~/.local/share/jomaa-home-deploy`, with its own `npm ci` and build; the three
newest releases are kept. Deployment switches the hub service to the new
release and waits for both hub health and the Matter controller. On a failed
restart or health check it restores the prior release. It preserves the
working checkout, `.env`, `config.json`, Matter data, and Cloudflare tunnel;
the tunnel is not restarted for a hub deployment, but the Matter controller
restarts with the hub. A newer
revision is never replaced by an older successful workflow run. The secret
file is private and must match the GitHub Actions secret. Changes take effect
after the GitHub verification job succeeds and its deployment request returns.
Unsigned requests to `/deploy` are rejected; the normal hub routes still
go to the hub service. The receiver listens only on this machine's loopback.

Only successful `push` runs for `main`, including merges, deploy; a manually
dispatched run only verifies. A failed verification, unreachable GitHub,
non-fast-forward history, or a Matter controller that doesn't start prevents or rolls back
deployment and is reported in the deployment service journal. Rerun a failed
push workflow after correcting the issue. To use a different public hostname,
set the `HUB_DEPLOY_URL` GitHub Actions variable to its `/deploy` URL.

## Home page

`https://jomaa.org/home` links to lights, device health, hub status, the Pico imaging guide,
and the project documentation. The hub serves the page at `/home` and its CSS under
`/home/`; edit `web/home.html` to add another page. It needs no administrator session.

The locally managed Cloudflare tunnel also routes hostname `jomaa.org`, paths `/`,
`/home`, `/lights` (including assets), and the panel's API requests to the hub on port 8080. Its proxied DNS record
points to the same tunnel as `hub.jomaa.org`. The apex `/` redirects to `/home`;
the hub subdomain's `/` continues to open device health.

## Web light controller

`https://jomaa.org/lights` controls rooms and individual devices. Sign in with
the hub password; the page shares the administrator session with device health.
Power, brightness, white temperature, and color use the same API as the phone
apps. Controls appear according to each target's capabilities. Brightness,
temperature, and color changes turn the selected lights on. The page reads
device states after each command and shows individual failures. Use Refresh to
read current states and update the list of configured targets.

The bottom row selects Living Room and Bedroom independently. Select either
room or both; the existing power, color, brightness, and temperature controls
apply to the selected rooms. Changing the selection reads states without
changing lights. With neither room selected, the controls are disabled. The
top picker selects an individual device or another room.

The panel source lives in `../jomaa-static-pages/device-panel/`. The hub build
includes its HTML, JavaScript, and styles; native releases and Docker builds
package the panel from the same repository revision as the API.

On the hub machine, `python3 scripts/publish_panel.py` configures the `jomaa.org`
tunnel route for the home page, light panel, sign-in, and target API. It validates
the routing with cloudflared and restarts the tunnel when the route changes.

## Reach it from anywhere with Docker

A Cloudflare Tunnel serves the hub at `https://hub.yourdomain.com` without
opening ports on your router. `cloudflared` runs next to the hub and connects
out to Cloudflare, and Cloudflare provides the HTTPS certificate. Only the hub
is exposed.

1. Your domain must be on Cloudflare.
2. Create an API token with **Account > Cloudflare Tunnel > Edit**,
   **Zone > DNS > Edit** and **Zone > Zone > Read**.
3. On the hub machine, add these to `.env`, next to `GOVEE_API_KEY`, and use a
   `HUB_PASSWORD` of at least 16 characters:

```
CLOUDFLARE_HOSTNAME=hub.yourdomain.com
CLOUDFLARE_API_TOKEN=...
```

4. Run:

```bash
python3 scripts/hubctl.py up
```

That creates the tunnel, its route and the DNS record if they don't exist,
starts `cloudflared`, and checks that the public URL answers. In the phone
apps, sign in with `https://hub.yourdomain.com`; that address works at home
and away.

`scripts/cloudflare.py status` shows tunnel health. `scripts/cloudflare.py
destroy` removes the tunnel and the DNS record. The `hub-deploy` GitHub
workflow runs the tests and then `cloudflare.py deploy` on every push to
`main`, using the `CLOUDFLARE_HOSTNAME`, `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` repository secrets. It skips the deploy until `CLOUDFLARE_HOSTNAME` is set.

Sign-in is rate limited: 5 wrong passwords per address every 15 minutes, and
50 across all addresses.

## Register lights

Run `scripts/onboard_lights.py` on the hub machine, from the `jomaa-home-hub`
directory. It uses the local `.env`, validates entries with the hub's config
parser, adds the light to `config.json`, and restarts `jomaa-hub.service`.
It checks that the light and room appear in the API and reads the light's
state. Registration never sends power, brightness, or color commands.

```bash
python3 scripts/onboard_lights.py
```

Choose Govee or Matter, select a discovered light, and select an existing room,
create a room, or choose no room. The script uses the discovered display
name and generates a unique target ID. Select Save and activate to register it,
or cancel. Already registered lights and unsupported devices are excluded from
the light selector.

Discovery refreshes private metadata files at
`data/light-inventory/govee.json` and `data/light-inventory/matter.json`.
These contain Govee models, addresses, names, and capabilities, or Matter node
information and endpoints. Selecting a light uses that discovery response;
addresses, SKUs, and temperature ranges do not need to be entered. Cancelling
retains the inventory without changing the configured lights.

### Govee

Add the device to your Govee account with the Govee app first. Set the account's
`GOVEE_API_KEY` in the hub's private `.env`, then run:

```bash
python3 scripts/onboard_lights.py govee
```

Select the light by its Govee app name. The script reads the SKU, display name,
and white temperature range from Govee. Supported Govee lights expose power,
brightness, RGB color, and adjustable white temperature.
`discover govee` saves and prints the account inventory with registration and
support information.

### Matter

To select an existing node or pair a new device, run:

```bash
python3 scripts/onboard_lights.py matter
```

Select Pair a new Matter device, choose its connection method, and put it in
pairing mode. The script prompts privately for the manual setup code or `MT:`
QR payload and any Wi-Fi password or Thread dataset. After pairing it discovers
the node's display name and light endpoints. Connect with `ssh -t jerry` for
interactive prompts. Devices shared from Apple Home or Google Home use
Already on the network; Wi-Fi and Thread pairing use Bluetooth.

To list or register a node already paired with this hub:

```bash
python3 scripts/onboard_lights.py discover matter
python3 scripts/onboard_lights.py matter --node-id 7 --id desk-lamp \
  --name 'Desk Lamp' --room office
```

The hub's node listing includes `lightEndpoints`, the endpoints exposing an
OnOff attribute. The script selects the endpoint when there is exactly one;
use `--endpoint 2` when a node has multiple lights or plugs. Each endpoint can
have its own target ID. Matter discovery requires the current hub build.

### Registration options

Explicit options support automated registration:

```bash
python3 scripts/onboard_lights.py govee --device 'AA:BB:CC:DD:EE:FF:00:11' \
  --id desk-lamp --room living-room
python3 scripts/onboard_lights.py matter --pair --id desk-lamp \
  --name 'Desk Lamp' --room office --room-name Office --wifi MyNetwork
```

IDs use lowercase letters, digits, and dashes. `--name` overrides the discovered
name. `--room` joins an existing room; a new room also needs `--room-name`.
When the device and ID are explicit, omit room options for an individual light.
Duplicate target IDs and duplicate physical lights are rejected.

`--dry-run` supports the selectors and prints the proposed layout without
pairing, saving discovery metadata or credentials, writing files, or restarting.
With `matter --pair`, the preview shows a
placeholder node and endpoint; these are discovered during pairing.
`--restart docker` recreates only the hub container so it mounts the updated
config. `--restart none` saves the layout for a manual restart. `--hub-dir PATH`
selects another local installation, and `--url URL` selects its API; put these
two options before the subcommand. The installation needs a built `dist/`
directory and Node.js, including when managing a Docker hub.

Config writes are atomic, keep deployment symlinks intact, and refuse concurrent
onboarding or edits. Setup codes and credentials stay out of the layout and
command output. If pairing succeeds but registration fails, the printed node ID
can be used with `--node-id` to finish. A saved registration remains in the
config if restarting or verifying state fails; inspect the service logs and
restart the hub after correcting the problem.

## Matter pairing commands

```bash
python3 scripts/hubctl.py wifi MyNetwork            # once, for Wi-Fi devices
python3 scripts/hubctl.py thread <hex dataset>      # once, for Thread devices
python3 scripts/hubctl.py commission MT:Y.K9042C00KA0648G00
```

`hubctl.py commission` pairs without registering a target and prints the node
ID. Register it with `onboard_lights.py matter --node-id <id>`.

Brand-new Wi-Fi and Thread devices pair over Bluetooth, which the native setup
turns on; with Docker, turn it on in `docker-compose.yml`. Without Bluetooth,
use `--network-only` for devices already on your network, for example one
shared from Apple Home or Google Home.

## API

Every request except `/healthz` and `/api/login` needs
`Authorization: Bearer <token>` or the login cookie.

| Method | Path                         | Body                                                                      | Does                                                                  |
| ------ | ---------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| POST   | `/api/login`                 | `{"password"}`                                                            | returns `{"token"}` and sets a cookie                                 |
| GET    | `/api/targets`               |                                                                           | every device and room, with what each can do                          |
| GET    | `/api/targets/{id}/state`    |                                                                           | room summary plus each device's state                                 |
| POST   | `/api/targets/{id}/command`  | `{"on","brightness","colorTemperaturePct","color","clientId","revision"}` | 200 when every device took it, 502 with `failed` per device otherwise |
| POST   | `/api/targets/{id}/sync`     | `{"on","brightness","colorTemperaturePct","clientId","revision"}`         | fixes devices that drifted, returns `synchronized`                    |
| GET    | `/api/matter/nodes`          |                                                                           | paired Matter devices                                                 |
| POST   | `/api/matter/commission`     | `{"code","networkOnly"}`                                                  | pair a device                                                         |
| POST   | `/api/matter/wifi`           | `{"ssid","password"}`                                                     | Wi-Fi credentials for pairing                                         |
| POST   | `/api/matter/thread`         | `{"dataset"}`                                                             | Thread dataset for pairing                                            |
| DELETE | `/api/matter/nodes/{nodeId}` |                                                                           | unpair                                                                |

`/healthz` answers `{"ok", "matterConnected"}`; `matterConnected` is true once
the Matter controller has started and loaded the paired devices. While it
isn't, the `/api/matter` routes answer 503.

All command fields are optional. `brightness` is 1-100. `colorTemperaturePct`
runs from the device's warmest white (0) to its coolest (100). `color` is
`"#rrggbb"`. A client sends a rising `revision` with each command, so a slow
sync can't undo a newer command.

## Test

```bash
python3 scripts/verify.py
```

Installs the pinned dependencies, then runs Prettier, the TypeScript compiler
(strict), ESLint (typescript-eslint's strict type-checked rules), the Node
tests, `npm audit` and the Python tests. The Node tests include a run of the
real Matter controller on a fresh fabric; the Python tests build the real hub
and drive it against a fake Govee API. `npm test` runs just the Node tests.

`node dist/main.js --no-matter` runs the hub without the Matter controller,
for Govee-only homes and tests.

## Wi-Fi device health

The hub includes a device inventory, SQLite health history, and a management page at `/devices`.
Pico W, Pico 2 W, and RP2040 boards with an ESP8285 UART radio report over verified HTTPS using individual credentials.
Their first authenticated report registers them; missed reports mark them offline.
See [Health monitoring](docs/health-monitoring.md) for setup, USB provisioning, API details, and tests.
For imaging and checking a board from scratch, use [Pico imaging bench](../pico-imaging-bench/README.md).

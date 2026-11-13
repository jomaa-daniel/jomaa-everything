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

## Deployment

[`../jomaa-deploy/`](../jomaa-deploy/README.md) installs and deploys the hub,
static sites, Cloudflare tunnel, routes, and DNS. The hub's own `deploy.json`
declares its service and verification checks. Verified pushes to `main` deploy
an exact repository revision through the signed receiver on jerry.

The hub's `.env`, `config.json`, and `data/` stay in the local checkout and
are linked into each release. The installer creates a private `.env` with a
generated password and an empty layout when these files are absent. Set
`GOVEE_API_KEY` in `.env` when using Govee. The public hub requires a password
of at least 12 characters. `config.example.json` shows the layout format.

```bash
python3 ../jomaa-deploy/deploy.py plan
python3 scripts/hubctl.py status
systemctl --user status jomaa-hub jomaa-cloudflared
journalctl --user -u jomaa-hub -f
```

After changing `.env` or `config.json`, restart `jomaa-hub.service`.
Its Matter controller restarts too; devices reconnect within seconds.
Back up `data/native/matter-data` to preserve the Matter fabric and
`~/.cloudflared` for tunnel credentials.

Bluetooth pairing uses adapter 0 over D-Bus; set `MATTER_BLUETOOTH_ADAPTER`
in `.env` for another adapter. Enable the Bluetooth service and adapter on
the host. Thread devices also need a Thread border router on the network.
Set `MATTER_LOG_LEVEL` (`debug`, `info`, `notice`, `warn`, `error`; default
`notice`) for Matter detail in the journal.

## Local development

From `jomaa-home-hub/`, create the local config and secrets, then run:

```bash
cp config.example.json config.json
cp .env.example .env
python3 scripts/hubctl.py dev
```

Edit the layout and password before starting. `hubctl.py dev` installs pinned
dependencies, builds the hub, and runs it until Ctrl-C. Development Matter
state lives in `data/matter`.

## Home page

`https://jomaa.org/home` links to lights, device health, device organization, accounts, secrets, hub status, the Pico imaging guide,
and the project documentation. The hub serves the page at `/home` and its CSS under
`/home/`; edit `web/home.html` to add another page. It needs no session.

The locally managed Cloudflare tunnel also routes hostname `jomaa.org`, paths `/`,
`/home`, `/devices`, `/manage`, `/lights`, `/invite`, `/join`, `/permissions`, `/secrets` (including assets), and the pages' API requests to the hub on port 8080. Its proxied DNS record
points to the same tunnel as `hub.jomaa.org`. The apex `/` redirects to `/home`;
the hub subdomain's `/` continues to open device health.

## Device organization

`https://jomaa.org/manage` manages custom device types, groups, and assignments
for configured Govee lights, paired Matter devices, and health reporters. It
needs the owner or an account with the `manage` scope. Types have distinct colors; assigning a
custom type changes the inventory category while hardware types and capabilities
stay device-reported. Deleting a type clears its assignments.

Groups are the configured rooms. Assigning lights updates their room membership
and the hub's light controls without restarting the controller. Reporting-only
devices have group membership for organization. Deleting a group removes its
memberships. Types and reporting-only memberships persist in
`data/organization.sqlite`; light memberships persist in `config.json`.

The device inventory uses column filter dropdowns for type, capabilities,
group, and status.

## Web light controller

`https://jomaa.org/lights` controls rooms, one at a time. It does not control
individual devices. It needs the owner or an account with the `lights`
scope. Power, brightness, white
temperature, and color use the same API as the phone apps. Controls appear
according to the selected room's capabilities. Brightness, temperature, and
color changes turn the room on. The page reads device states after each
command, shows failures by device name, and re-reads states when it becomes
visible and every minute.

The bottom row selects one room. Changing the selection reads its state
without changing lights. A dot per member device shows it on, off, updating,
or not answering.

The panel source lives in `../jomaa-static-pages/device-panel/`. The hub build
includes its HTML, JavaScript, and styles; releases
package the panel from the same repository revision as the API.

[`deploy.json`](deploy.json) declares the hub's deployment module, including
the `jomaa.org` path route for the home
page, light panel, account pages, sign-in, and target API. The deployment workflow validates
this routing with cloudflared and applies it automatically.

The deployment tunnel serves the hub over HTTPS. Sign-in is rate limited: 5
wrong passwords per address every 15 minutes, and 50 across all addresses.

## Accounts

The owner signs in with the hub password from the private `.env`, leaving the
username blank. The owner can open every page and is the only one who can
invite people and change permissions. The phone apps and scripts sign in as the
owner.

`https://jomaa.org/invite` creates share links of the form
`https://jomaa.org/join#<token>`. Each link works once and expires after
`accounts.inviteLifetimeDays`; the page shows a link only when it is created
and lists unused invites for revoking. The token stays in the URL fragment, so it never reaches the
tunnel or the hub's logs.

Opening a link shows a form for a username (3 to 32 lowercase letters, digits,
dots, dashes, or underscores) and a password within
`accounts.passwordLength`. Creating
the account leaves the browser's current session unchanged. A new account can't
open any page.

`https://jomaa.org/permissions` lists accounts with a checkbox per scope; each
change saves immediately:

| Scope     | Grants                                                             |
| --------- | ------------------------------------------------------------------ |
| `lights`  | `/lights` and the target API                                       |
| `devices` | `/devices`, health reports, device credentials, and Matter pairing |
| `manage`  | `/manage`: types, groups, and assignments                          |

Changes apply to signed-in accounts on their next request. Deleting an account
signs it out everywhere. Accounts sign in on `/lights`, `/devices`, and
`/manage` with their username and password; a page they lack the scope for
says so and offers sign-in again. Signing in ends the session it replaces.
Accounts, password hashes (scrypt), scopes, unused invites, and sessions persist
in `accounts.databaseFile` beside the health database. Sessions last
`accounts.sessionLifetimeDays`, each account keeps its newest
`accounts.sessionsPerAccount`, and only token hashes are stored. These
settings are in [`settings.json`](settings.json), described in
[`settings.md`](settings.md). Owner and account sign-in failures
are rate limited separately; sign-in and sign-out refuse cross-site requests.

## Secrets

`https://jomaa.org/secrets` views and edits the environment files listed in
`secrets.envFiles`, resolved from the release the hub runs in, where each is a
link to the real file in jerry's checkout. Only the owner can open it; there is
no scope for it. Each file's keys are listed in file order with masked values.
Reveal, Save and Redeploy ask for the hub password again; wrong passwords count
toward the owner sign-in rate limit.

Edits stay on the page until saved. Keys are capital letters, digits and
underscores, starting with a letter; values are one line. `HUB_PASSWORD` keeps
at least `hubPasswordMinLength` characters from
[`../jomaa-deploy/config.json`](../jomaa-deploy/config.json) and can't be
deleted. Saving keeps comments, blank lines and key order, appends new keys,
and replaces the link's target atomically with the same file mode.

Saved changes apply on the next deploy, which restarts the hub when its `.env`
changed and runs the tailnet command every time. After a save, Redeploy now
reruns the latest push run of the `github.workflow` workflow on `main` and
follows it until it finishes, waiting while the hub restarts. Redeploy uses
the GitHub CLI login on jerry: on each request the hub runs `secrets.ghCommand`
with `auth token`, without a shell and within `github.timeoutSeconds`, and
sends the printed token to GitHub. The login's token needs the Actions
repository permission set to read and write on the `repo` repository. When the
command is missing, fails or prints nothing, the Redeploy button is disabled
and the redeploy API answers 409 with the reason. The token is never shown or
logged.

## Browser check

`npm run test:browser` drives the invite, join, permission and Secrets pages in
Chrome against the real API and built pages, with a fake light, temporary env
files, a fake GitHub CLI and a fake GitHub API. It uses the installed
Google Chrome (`channel: "chrome"`); CI runs it as a declared check.

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

Select Pair a new Matter device and put it in
pairing mode. Pairing uses the local IP network by default. The script prompts
privately for the manual setup code or `MT:` QR payload. After pairing it discovers
the node's display name and light endpoints. Connect with `ssh -t jerry` for
interactive prompts. Devices shared from Apple Home or Google Home use
the pairing code from that app's sharing window. Explicit `--wifi` and `--thread`
options use Bluetooth and prompt privately for their credentials.

Scan for Matter devices advertising on the hub's local network:

```bash
python3 scripts/onboard_lights.py discover matter --commissionable
```

Discovery uses mDNS over IP and does not pair devices or use Bluetooth. A device
must already be on the network; enable pairing or sharing in its current app.
Advertisements include the device name when provided, vendor/product IDs,
addresses, discriminator and commissioning mode. Registration still needs the
setup code to authenticate the device.

For repeatable registration without menus, prompt privately for just the setup code:

```bash
python3 scripts/onboard_lights.py matter --pair
```

For automated registration, supply one setup-code line on stdin:

```bash
python3 scripts/onboard_lights.py matter --code-stdin < /path/to/private/setup-code
```

This pairs over the network, discovers the name and light endpoint, registers
an individual target, restarts the hub and verifies its state. Use `--room` to
assign a room and `--id` or `--name` to override the discovered values. Setup
codes accept printed hyphens and stay out of config and output.

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
`--restart none` saves the layout for a manual restart. `--hub-dir PATH`
selects another local installation, and `--url URL` selects its API; put these
two options before the subcommand. The installation needs a built `dist/`
directory and Node.js.

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

Brand-new Wi-Fi and Thread devices pair over Bluetooth. The deployed hub uses
BlueZ over D-Bus. Without Bluetooth,
use `--network-only` for devices already on your network, for example one
shared from Apple Home or Google Home.

## API

Every request except `/healthz`, `/api/login`, `/api/logout`,
`/api/invites/check`, and `/api/join` needs `Authorization: Bearer <token>` or
the login cookie. The owner can use every route. Accounts need the route's
scope (`lights` for targets, `devices` for Matter and `/api/devices`, `manage`
for `/api/manage`) and get 403 without it. Invite, account and Secrets routes are
owner-only.

| Method | Path                          | Body                                                                      | Does                                                                                          |
| ------ | ----------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| POST   | `/api/login`                  | `{"password"}` or `{"username","password"}`                               | owner or account sign-in; returns `{"token"}` and sets a cookie                               |
| POST   | `/api/logout`                 |                                                                           | clears the cookie and ends an account session                                                 |
| GET    | `/api/session`                |                                                                           | `{"owner","username","scopes"}` for the caller                                                |
| POST   | `/api/invites/check`          | `{"token"}`                                                               | the invite's `expiresAt`, 404 when invalid, used, or expired                                  |
| POST   | `/api/join`                   | `{"token","username","password"}`                                         | creates an account with no scopes                                                             |
| GET    | `/api/invites`                |                                                                           | unused invites                                                                                |
| POST   | `/api/invites`                | `{}`                                                                      | creates an invite; returns `{"invite","token"}`                                               |
| DELETE | `/api/invites/{id}`           |                                                                           | revokes an invite                                                                             |
| GET    | `/api/accounts`               |                                                                           | accounts with their scopes, and the scope list                                                |
| PUT    | `/api/accounts/{user}/scopes` | `{"scopes"}`                                                              | replaces an account's scopes                                                                  |
| DELETE | `/api/accounts/{user}`        |                                                                           | deletes an account and its sessions                                                           |
| GET    | `/api/secrets`                |                                                                           | each env file's keys in file order with masked values, and whether redeploy is available      |
| PUT    | `/api/secrets`                | `{"file","changes","password"}`                                           | applies `changes`: `{"key","value"}` sets or adds, `{"key","delete":true}` deletes            |
| POST   | `/api/secrets/reveal`         | `{"file","key","password"}`                                               | returns `{"value"}`                                                                           |
| POST   | `/api/secrets/redeploy`       | `{"password"}`                                                            | reruns the latest push run of the deploy workflow on `main`; returns `{"id","url","attempt"}` |
| GET    | `/api/secrets/redeploy/{id}`  |                                                                           | the run's `attempt`, `status` and `conclusion`                                                |
| GET    | `/api/targets`                |                                                                           | every device and room, with what each can do                                                  |
| GET    | `/api/targets/{id}/state`     |                                                                           | room summary plus each device's state                                                         |
| POST   | `/api/targets/{id}/command`   | `{"on","brightness","colorTemperaturePct","color","clientId","revision"}` | 200 with `failed`: each device that didn't take it, with the reason; empty when all did       |
| POST   | `/api/targets/{id}/sync`      | `{"on","brightness","colorTemperaturePct","clientId","revision"}`         | fixes devices that drifted, returns `synchronized`                                            |
| GET    | `/api/matter/nodes`           |                                                                           | paired Matter devices                                                                         |
| GET    | `/api/matter/discover`        |                                                                           | commissionable devices advertised over local-network mDNS                                     |
| POST   | `/api/matter/register`        | `{"code","instanceName"}`                                                 | Pair the selected network advertisement and persist its Matter node.                          |
| POST   | `/api/matter/commission`      | `{"code","networkOnly"}`                                                  | pair a device                                                                                 |
| POST   | `/api/matter/wifi`            | `{"ssid","password"}`                                                     | Wi-Fi credentials for pairing                                                                 |
| POST   | `/api/matter/thread`          | `{"dataset"}`                                                             | Thread dataset for pairing                                                                    |
| DELETE | `/api/matter/nodes/{nodeId}`  |                                                                           | unpair                                                                                        |

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

The hub includes a device inventory, SQLite health history, and a management page at `https://jomaa.org/devices`.
Add device opens a network discovery window for Matter devices advertising for
pairing or sharing. It scans while open, lists device names, addresses and
pairing availability, and stops when closed. Scan again retries discovery.
Pair and register on a discovered device asks for its setup code and pairs over
the network. The controller stores paired nodes in its Matter fabric; they
appear in the device inventory with connection status and device details.
Matter details include a name editor, last-seen time and reported uptime.
Names are stored in the hub's Matter data and used by configured Matter lights.
Last seen records successful device contact. Diagnostic reads run every 30
seconds; devices that omit uptime show Unavailable.
The inventory includes Type, Capabilities and Group columns. Type shows the
assigned category when present, otherwise the reported type. Matter details
show reported and assigned types separately. Functional capabilities come from
reported descriptors and attributes. Groups show room membership, including
organization membership for reporting-only devices.
Matter light details include a Group selector. Save group moves configured
endpoints to the selected room or No group and persists the room membership.
Create device credential in that window opens Pico health enrollment.
Pico W, Pico 2 W, and RP2040 boards with an ESP8285 UART radio report over verified HTTPS using individual credentials.
Their first authenticated report registers them; missed reports mark them offline.
See [Health monitoring](docs/health-monitoring.md) for setup, USB provisioning, API details, and tests.
For imaging and checking a board from scratch, use [Pico imaging bench](../pico-imaging-bench/README.md).

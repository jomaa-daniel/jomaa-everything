# jomaa-home-hub

One hub for every light in the house, Matter or Govee. Send a command to a room
and it goes to every device in that room at once. A sync pass then checks each
device and fixes any that didn't change. Same idea as
[device-panel](https://github.com/jomaa-daniel/device-panel), now running at home
and speaking Matter.

```
phone / web / hubctl.py
        │  HTTP (one API for every brand)
        ▼
   hub (Go) ── rooms, fan-out, sync
     │                    │
     │ WebSocket          │ HTTPS
     ▼                    ▼
 Matter server        Govee cloud
 (Docker)                 │
     │ Matter              ▼
     ▼                 Govee lights
 Matter devices
```

The hub doesn't speak Matter itself. It uses the
[Open Home Foundation Matter server](https://github.com/matter-js/matterjs-server)
(the one Home Assistant uses) for pairing and device sessions, and talks to it
over a local WebSocket.

## Run it on Linux without Docker

The native setup installs the Matter server and builds the hub, then creates
user-level systemd services. It needs Linux x86-64 or arm64, Python 3.12+,
Node.js 22.13+, npm, systemd and an internet connection. If Go is missing, the
setup downloads a verified Go release. A Thread border router is also needed
for Thread devices.

```bash
python3 scripts/setup_native.py
python3 scripts/hubctl.py status
```

The first run creates an empty `config.json` and a private `.env` with a
generated `HUB_PASSWORD`. Add your devices and rooms to `config.json` and, if
using Govee, set `GOVEE_API_KEY` in `.env`. Existing files and Matter pairing
data are preserved. `config.example.json` shows the format; its Matter node is
an example, not a paired device.

The setup enables user lingering so services start at boot without a login.
Systemd runs `scripts/setup_native.py --boot` to check the installation, then
`scripts/boot_native.py` to launch each service. Boot never downloads software
or creates Cloudflare resources. To inspect or restart the services:

```bash
systemctl --user status jomaa-matter jomaa-hub jomaa-cloudflared
systemctl --user restart jomaa-hub
journalctl --user -u jomaa-matter -u jomaa-hub -f
```

The tunnel service exists only if configured below. After changing `.env` or
`config.json`, restart the hub. Backup `data/native/matter-data` to preserve
the Matter fabric; losing it means re-pairing devices. Bluetooth pairing uses
adapter 0 over D-Bus; set `MATTER_BLUETOOTH_ADAPTER` in `.env` for another
adapter. The Bluetooth service and adapter must be enabled on the host.

## Run it with Docker

Needs a machine on your home network that stays on (a Pi, NAS or mini PC) with
Docker and Python 3. Thread devices also need a Thread border router on the
network (an Apple TV, HomePod mini or Nest hub).

```bash
cp config.example.json config.json   # list your devices and rooms
cp .env.example .env                 # set HUB_PASSWORD and GOVEE_API_KEY
python3 scripts/hubctl.py up         # starts both services, waits until healthy
python3 scripts/hubctl.py status
```

`hubctl.py dev` runs the Matter server in Docker and the hub from source, for
working on the hub.

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
password in the private `.env` file. The hub remains on loopback and the
Matter server is not exposed. Cloudflare account API tokens are not required
for this native tunnel. The existing `cloudflare.py deploy` and GitHub workflow
manage a different kind of tunnel and must not be used to manage this one.

## Deploy native hub changes from GitHub

`.github/workflows/hub-deploy-native.yml` verifies hub changes pushed or merged
to `main` on GitHub-hosted runners, then sends a signed HTTPS request to
`https://hub.jomaa.org/__deployment`. Cloudflare routes that path to a local
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
`~/.local/share/jomaa-home-deploy`. Deployment switches the hub service to the
new release and waits for both hub health and the Matter connection. On a
failed restart or health check it restores the prior release. It preserves the
working checkout, `.env`, `config.json`, Matter data, and Cloudflare tunnel;
the Matter server and tunnel are not restarted for a hub deployment. A newer
revision is never replaced by an older successful workflow run. The secret
file is private and must match the GitHub Actions secret. Changes take effect
after the GitHub verification job succeeds and its deployment request returns.
Unsigned requests to `/__deployment` are rejected; the normal hub routes still
go to the hub service. The receiver listens only on this machine's loopback.

Only successful `push` runs for `main`, including merges, deploy; a manually
dispatched run only verifies. A failed verification, unreachable GitHub,
non-fast-forward history, or an unhealthy Matter server prevents or rolls back
deployment and is reported in the deployment service journal. Rerun a failed
push workflow after correcting the issue. To use a different public hostname,
set the `HUB_DEPLOY_URL` GitHub Actions variable to its `/__deployment` URL.

## Reach it from anywhere with Docker

A Cloudflare Tunnel serves the hub at `https://hub.yourdomain.com` without
opening ports on your router. `cloudflared` runs next to the hub and connects
out to Cloudflare, and Cloudflare provides the HTTPS certificate. Only the hub
is exposed, never the Matter server.

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
`CLOUDFLARE_ACCOUNT_ID` repository secrets, the same way device-panel deploys
its Worker. It skips the deploy until `CLOUDFLARE_HOSTNAME` is set.

Sign-in is rate limited: 5 wrong passwords per address every 15 minutes, and
50 across all addresses.

## Add a Matter device

```bash
python3 scripts/hubctl.py wifi MyNetwork            # once, for Wi-Fi devices
python3 scripts/hubctl.py thread <hex dataset>      # once, for Thread devices
python3 scripts/hubctl.py commission MT:Y.K9042C00KA0648G00
```

It prints the node id. Add the device to `config.json` with
`"driver": "matter", "nodeId": <id>`, put it in a room, and restart.

Brand-new Wi-Fi and Thread devices pair over Bluetooth; turn that on in
`docker-compose.yml`. Without Bluetooth, use `--network-only` for devices already
on your network, for example one shared from Apple Home or Google Home.

## API

Every request except `/healthz` and `/api/login` needs
`Authorization: Bearer <token>` or the login cookie.

| Method | Path | Body | Does |
|---|---|---|---|
| POST | `/api/login` | `{"password"}` | returns `{"token"}` and sets a cookie |
| GET | `/api/targets` | | every device and room, with what each can do |
| GET | `/api/targets/{id}/state` | | room summary plus each device's state |
| POST | `/api/targets/{id}/command` | `{"on","brightness","colorTemperaturePct","color","clientId","revision"}` | 200 when every device took it, 502 with `failed` per device otherwise |
| POST | `/api/targets/{id}/sync` | `{"on","brightness","colorTemperaturePct","clientId","revision"}` | fixes devices that drifted, returns `synchronized` |
| GET | `/api/matter/nodes` | | paired Matter devices |
| POST | `/api/matter/commission` | `{"code","networkOnly"}` | pair a device |
| POST | `/api/matter/wifi` | `{"ssid","password"}` | Wi-Fi credentials for pairing |
| POST | `/api/matter/thread` | `{"dataset"}` | Thread dataset for pairing |
| DELETE | `/api/matter/nodes/{nodeId}` | | unpair |

All command fields are optional. `brightness` is 1-100. `colorTemperaturePct`
runs from the device's warmest white (0) to its coolest (100). `color` is
`"#rrggbb"`. A client sends a rising `revision` with each command, so a slow
sync can't undo a newer command.

## Test

```bash
python3 scripts/verify.py
```

Runs lint, builds and every test. The Python tests build the real hub and
drive it against a fake Govee API.

---
name: operate-home-hub
description: Inspect and control the Jomaa home hub through its public HTTPS API, including Govee rooms and Matter devices. Use for requests to check device state, change lights, or commission Matter devices via hub.jomaa.org.
---

# Operate the home hub

Use `https://hub.jomaa.org` as the hub API origin, including from outside the home. Cloudflare Tunnel routes this to the hub, which runs the Matter controller in its own process and talks to the Govee cloud. A room command fans out to all of its member lights.

The helper `scripts/hub_api.py` uses HTTPS, exchanges the hub password for a bearer token, and prints only the requested response. Set `JOMAA_HUB_PASSWORD` in the agent's environment or pass `--password-file` pointing to a private file containing `HUB_PASSWORD=...`. On the hub machine that file is `/home/jerry/jomaa-everything/jomaa-home-hub/.env`; clients on other machines need their own secure credential provision. If interactive, the helper can prompt for a password. Never put passwords, API keys, or session tokens into committed files, terminal history, output, or chat. Override the origin with `JOMAA_HUB_URL` or `--url` only when deliberately targeting another hub.

From this skill directory, read the current setup rather than assuming a fixed room or device list:

```bash
python3 scripts/hub_api.py GET /healthz
python3 scripts/hub_api.py GET /api/targets --password-file /path/to/private-env
python3 scripts/hub_api.py GET /api/targets/living-room/state --password-file /path/to/private-env
python3 scripts/hub_api.py GET /api/matter/nodes --password-file /path/to/private-env
```

`healthz` reports hub availability and `matterConnected`. Target-state responses contain individual `devices`, a summary `state` when available, and possibly a `failed` map even on HTTP 200. Inspect failures before claiming every light responded. `matterConnected` means the hub's Matter controller is running; it may have no paired nodes; Govee lights are separate from Matter nodes.

For a requested action, select the target ID from `/api/targets`, then send only the requested fields. This example turns on one target; replace the ID and values with the user's actual request:

```bash
printf '%s' '{"on":true}' | python3 scripts/hub_api.py POST /api/targets/TARGET_ID/command --json-stdin --password-file /path/to/private-env
```

Supported fields: `on` boolean, `brightness` 1–100, `colorTemperaturePct` 0–100 (warm to cool), `color` as `#rrggbb`. Commands return HTTP 502 with per-device `failed` entries when any member fails; report partial failures. For multi-step control/reconciliation, use a stable `clientId` and increasing integer `revision`, and consult `jomaa-home-hub/README.md` for the sync endpoint. Avoid unsolicited commands or test changes to physical lights.

To pair a requested device, POST `{"code":"...","networkOnly":false}` to `/api/matter/commission`; network-only is for a device already on the network. The helper allows 360 seconds for commissioning. Wi-Fi and Thread commissioning credentials go to `/api/matter/wifi` and `/api/matter/thread`; pass sensitive JSON via stdin, not command arguments or logs. Deleting `/api/matter/nodes/{nodeId}` unpairs a device. Use those operations only when requested.

If access fails, distinguish DNS/TLS/tunnel failures from authentication errors and from `matterConnected: false`. Do not repeatedly guess passwords: login is rate limited. On the hub machine inspect `systemctl --user status jomaa-hub jomaa-cloudflared`. This installation uses a locally managed tunnel; do not run the repo's remote-managed `cloudflare.py deploy` or change DNS while merely operating the API.

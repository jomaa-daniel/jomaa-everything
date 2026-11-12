# jomaa-health

Public health page for everything jerry serves through jomaa.org, at
https://health.jomaa.org. It runs as a Cloudflare Worker, so it keeps working
and reports failures when jerry, the hub, or the tunnel is down.

```
browser ──▶ Cloudflare Worker (health.jomaa.org) ── https ──▶ jomaa.org, hub.jomaa.org,
                                                              ssh.jomaa.org, sarah.jomaa.org
                                                              ──▶ tunnel ──▶ jerry
```

Every check goes through the public hostnames, the same path a browser,
phone app, Pico, or SSH client takes.

| Group | Checks |
| --- | --- |
| `hub.jomaa.org` | `/healthz` reports ok with the Matter controller connected; `/` redirects to `/devices`; `/deploy` rejects an unsigned deployment. |
| `jomaa.org` | Every probe path of the route in [`../jomaa-deploy/deploy.json`](../jomaa-deploy/deploy.json) reaches the hub: pages answer 200, `/` redirects, API paths answer the hub's sign-in refusal. Anything else, such as the tunnel's 404, fails. |
| `ssh.jomaa.org` | A WebSocket through the tunnel's SSH route receives jerry's `SSH-2.0-` greeting. |
| Static sites | Each site in `staticSites` serves its HTML index. A test keeps the list equal to the hostname directories in `jomaa-static-pages/`. |
| Hub API | Signs in at `jomaa.org/api/login`, lists targets, reads the state of every room and of each device outside a room, reads device management, health reporters, Matter nodes, runs a Matter discovery scan, then signs out. |

Each check is **working**, **degraded**, or **failing**. Degraded means the
server works but a device it manages is not answering: some lights in a room,
an offline health reporter, or an unavailable Matter node. A room where no
device answers is failing. Requests time out after 10 seconds; the Matter scan
after 25.

The page lists each check with its result and latency. `/checks.json` returns
the same report as JSON. Both answer 503 when any check fails, for use by
uptime monitors. Reports are reused for 60 seconds, because each room read
asks Govee's cloud API for every light in it.

The Worker signs in with the hub's administrator password, stored as the
Worker secret `HUB_PASSWORD`. The page shows counts and statuses, never
device names, tokens, or the password. It only reads; it sends no light
commands and changes no settings.

## Deploy

Deployment runs on jerry. It needs a Cloudflare API token that can deploy
Workers: create one from the **Edit Cloudflare Workers** template, limited to
the Jomaa account and the `jomaa.org` zone. Save it once:

```bash
mkdir -p ~/.config/jomaa-health
install -m 600 /dev/stdin ~/.config/jomaa-health/cloudflare-token   # paste the token, then Ctrl-D
```

Then, from this directory on jerry:

```bash
npm ci
npm run deploy
```

`scripts/deploy.mjs` runs `wrangler deploy`, which attaches the custom domain
`health.jomaa.org` and creates its DNS record, then stores `HUB_PASSWORD` from
`../jomaa-home-hub/.env` as the Worker secret. `CLOUDFLARE_API_TOKEN` in the
environment takes precedence over the token file. Redeploy after changing
routes, static sites, the hub password, or this folder.

## Check locally

```bash
npm ci
npm run check
```

`check` type-checks the Worker and runs the tests against a simulated
jomaa.org. `npm run dev` serves the Worker locally with `wrangler dev`.

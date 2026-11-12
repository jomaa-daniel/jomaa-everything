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
| Static sites | Each site in `staticSites` in `config.json` serves its HTML index. A test keeps the list equal to the hostname directories in `jomaa-static-pages/`. |
| Hub API | Signs in at `jomaa.org/api/login`, lists targets, reads the state of every room and of each device outside a room, reads device management, health reporters, Matter nodes, runs a Matter discovery scan, then signs out. |

Each check is **working**, **degraded**, or **failing**. Degraded means the
server works but a device it manages is not answering: some lights in a room,
an offline health reporter, or an unavailable Matter node. A room where no
device answers is failing. Requests and the Matter scan have their own
deadlines.

The page lists each check with its result and latency. `/checks.json` returns
the same report as JSON. Both answer 503 when any check fails, for use by
uptime monitors. Reports are reused for `reportTtlSeconds`, because each room read
asks Govee's cloud API for every light in it.

The Worker signs in with the hub's administrator password, stored as the
Worker secret `HUB_PASSWORD`. The page shows counts and statuses, never
device names, tokens, or the password. It only reads; it sends no light
commands and changes no settings.

## Deploy

Every deployment of the repository deploys the Worker. Pushing to `main`
activates a release on jerry, and jomaa-deploy's provision steps in
[`../jomaa-deploy/deploy.json`](../jomaa-deploy/deploy.json) run `npm ci` and
`scripts/deploy.mjs` in it, after the services are healthy and the tunnel
serves the release. The Worker checks the release that deployed it. A failed
Worker deployment fails the activation and rolls jerry back to the previous
release.

`scripts/deploy.mjs` runs `wrangler deploy` with `HUB_PASSWORD` from the file
named by `deploy.hubEnvFile` as a secrets file, so the code and the secret go
out as one Worker version. Deployment attaches the custom domain
`health.jomaa.org` and creates its DNS record.

Wrangler on jerry uses the Cloudflare login stored in `~/.config/.wrangler`,
once per machine. Jerry has no browser, so forward wrangler's OAuth callback
port from a laptop and open the printed URL there:

```bash
ssh -L 8976:localhost:8976 jerry
cd ~/jomaa-everything/jomaa-health && npm ci && npx wrangler login --browser=false
```

A Cloudflare API token that can deploy Workers works instead: set
`CLOUDFLARE_API_TOKEN`, or save it with mode 600 in the file named by
`deploy.tokenFile`. Either takes precedence over the login.

`npm run deploy` in this directory deploys the Worker by hand, for example
after changing the hub password without a new release.

## Configuration

[`config.md`](config.md) describes every setting in `config.json` and
`wrangler.jsonc`, and the values read from `../jomaa-deploy/deploy.json`.

## Check locally

```bash
npm ci
npm run check
```

`check` type-checks the Worker and runs the tests against a simulated
jomaa.org. `npm run dev` serves the Worker locally with `wrangler dev`.

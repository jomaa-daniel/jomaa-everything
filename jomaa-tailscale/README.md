# jomaa-tailscale

jerry on Tailscale: a subnet router for the home LAN and an exit node. No
router ports are opened. Settings are in [`config.json`](config.json),
documented in [`config.md`](config.md).

```
laptop/phone ── tailnet ──▶ jerry (tag) ──▶ home LAN (lan)   admins only
                                        └──▶ internet         admins and family
```

| Who | Reaches |
|-----|---------|
| Tailnet admins | Everything: the LAN, jerry, and the exit node |
| `group:family` | The internet through jerry's exit node, nothing else |

| File | Responsibility |
|------|----------------|
| `config.json` | LAN, router, tag, hostname, paths, API, and timeouts. |
| `policy.json` | Tailnet policy with `{lan}`, `{tag}` and `{router}` placeholders. |
| `tailnet.py` | `deploy`: checks the root setup, applies node settings, and replaces the tailnet policy when it differs. |
| `setup_server.py` | Root-owned setup on jerry: package, forwarding, UDP GRO, joining with `tag`, operator, auto-updates. |
| `.env` | On jerry only, in deployment state: the API token and family emails. |

## Deployment

Push to `main`. Each activation runs `tailnet.py deploy` from the new release
(the `tailnet` command module declared in [`deploy.json`](deploy.json)) as the
deployment user, after the services are healthy:

1. It fails when the root setup is missing or outdated: the `sysctlFile`, the
   `gro.dispatcher` script, the login with `tag`, the deployment user as
   tailscaled operator, and auto-updates.
2. It runs `tailscale set` when jerry's `hostname` or advertised routes differ.
3. It replaces the tailnet policy when it differs from `policy.json` with
   placeholders and `group:family` filled in.

A failure rolls the release back. The tailnet policy and node settings are not
rolled back. Tailscale updates itself through auto-updates.

The policy's `tests` make Tailscale reject any version where family members
can reach the router or jerry; they are sent only when `group:family` has
members. jerry's route and exit node are approved through `autoApprovers`, and
tagged devices don't expire. jerry forwards IPv4 and IPv6; NetworkManager
handles IPv6 router advertisements, so forwarding keeps jerry's own IPv6
address.

## Credentials

`jomaa-tailscale/.env` lives in the deployment's state checkout on jerry
(`$JOMAA_DEPLOY_SOURCE/jomaa-tailscale/.env`, mode 600) and is linked into each
release. [`.env.example`](.env.example) shows its keys and `config.md` explains
them. `TAILSCALE_API_KEY` is an API access token (admin console → Settings →
Keys → Generate access token), not an auth key. Family emails stay out of this
public repository.

## Root setup

Run on jerry when `setup_server.py` or its settings change, or a deployment
reports that the root setup is outdated. Push first, so the current release
has the new script. It asks for jerry's sudo password:

```bash
ssh -t jerry python3 .local/share/jomaa-deploy/current/jomaa-tailscale/setup_server.py
```

It installs Tailscale from its Ubuntu repository, writes `sysctlFile` and the
`gro.dispatcher` script, turns on UDP GRO forwarding on the default-route
interface, joins with `tag` using a single-use auth key minted from `.env`
when jerry is not already joined with that tag, and runs `tailscale set` with
the node settings, this user as operator, and auto-updates.

## Add someone

Add their email to `TAILSCALE_FAMILY` in jerry's `.env` and run the current
release's `tailnet.py deploy` (see Check). Invite them from the admin console
(Users → Invite users). On their device they turn on Tailscale and pick
**jerry** under Exit node.

## Check

```bash
ssh jerry tailscale status
ssh jerry 'cd .local/share/jomaa-deploy/current/jomaa-tailscale && python3 tailnet.py deploy'
tailscale ping jerry        # from a device on the tailnet, away from home
```

## Remove it

Delete `deploy_module.py` and `deploy.json` from this folder. On jerry: `sudo tailscale logout`,
`sudo apt-get remove tailscale`, and delete the `sysctlFile` and
`gro.dispatcher` files.

## Test

```bash
cd jomaa-tailscale && python3 -m unittest
```

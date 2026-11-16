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

`group:family` is managed from the hub's `/tailscale` page: the owner links
an account to its Tailscale user and gives or removes exit-node access. The
hub saves that in its account database, and a sync makes the policy's family
group exactly the linked accounts with access.

| File | Responsibility |
|------|----------------|
| `config.json` | LAN, router, tag, hostname, paths, API, locks, and timeouts. |
| `policy.json` | Tailnet policy template with `{lan}`, `{tag}` and `{router}` placeholders. |
| `access.sql` | Tables in the hub's account database: account links with their access, and the last sync's result. |
| `access.py` | The sync: fills the template with the logins of the accounts with access, writes the policy when it differs, reads it back, and records the result. |
| `tailnet.py` | `deploy` (root setup check, node settings, sync), `sync` and `observe` for the hub, and the Tailscale API client. |
| `fake_tailnet.py` | Test fixture: a fake provider for the Python and hub tests. |
| `setup_server.py` | Root-owned setup on jerry: package, forwarding, UDP GRO, joining with `tag`, operator, auto-updates. |
| `.env` | On jerry only, in deployment state: the API token. |

## Deployment

Push to `main`. Each activation runs `tailnet.py deploy` from the new release
(the `tailnet` command module declared in [`deploy.json`](deploy.json)) as the
deployment user, after the services are healthy:

1. It fails when the root setup is missing or outdated: the `sysctlFile`, the
   `gro.dispatcher` script, the login with `tag`, the deployment user as
   tailscaled operator, and auto-updates.
2. It runs `tailscale set` when jerry's `hostname` or advertised routes differ.
3. It fails when `.env` has any key besides `TAILSCALE_API_KEY`.
4. It syncs the policy (see below), using the hub's account database
   (`accounts.databaseFile` beside the hub's `HEALTH_DB_PATH`).

A failed sync fails the command, and the activation reports it; the policy
is left as it was. The policy and node settings are not rolled back.
Tailscale updates itself through auto-updates.

### Sync

A sync reads Tailscale's users, takes the current login of every linked
account with access (looked up by the user's stable ID, so a renamed login is
followed), fills `policy.json` with those logins as `group:family`, writes
the policy when it differs, reads it back, and records what it found. A
linked account whose Tailscale user no longer exists is left out and named in
the result. The hub syncs after every change, every
`tailscale.syncIntervalSeconds`, and when it starts; every deployment syncs
too. Because each sync writes the whole family group from what is saved, a
failed or interrupted sync is fixed by the next one. Syncs hold
`policyLockFile` in the deployment directory, so two never overlap.

Before the owner turns on managed access at `/tailscale`, syncs write
nothing. The page lists the people Tailscale's policy gives access to who
would lose it. Edits to `group:family` in the admin console are replaced by
the next sync.

The policy's `tests` make Tailscale reject any version where family members
can reach the router or jerry; they are sent only when `group:family` has
members. jerry's route and exit node are approved through `autoApprovers`, and
tagged devices don't expire. jerry forwards IPv4 and IPv6; NetworkManager
handles IPv6 router advertisements, so forwarding keeps jerry's own IPv6
address.

## Credentials

`jomaa-tailscale/.env` lives in the deployment's state checkout on jerry
(`$JOMAA_DEPLOY_SOURCE/jomaa-tailscale/.env`, mode 600) and is linked into each
release. [`.env.example`](.env.example) shows its key and `config.md` explains
it. `TAILSCALE_API_KEY` is an API access token (admin console → Settings →
Keys → Generate access token), not an auth key. Only `tailnet.py` reads it; the
hub runs `tailnet.py` and never receives the token, and errors are printed with
anything shaped like a key redacted. Family login names stay out of this
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

1. Invite them to the tailnet from the admin console (Users → Invite users).
2. They install Tailscale and sign in with their own account.
3. Create a hub account for them with an invite link (`/invite`), then on
   `/tailscale` link that account to their Tailscale user and give exit-node
   access. The page shows when the policy confirms it.
4. On their device they pick **jerry** under Exit node.

## Check

```bash
ssh jerry tailscale status
ssh jerry 'cd .local/share/jomaa-deploy/current/jomaa-tailscale && python3 tailnet.py observe'
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

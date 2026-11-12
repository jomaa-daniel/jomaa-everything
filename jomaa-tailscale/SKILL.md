---
name: jomaa-tailscale
description: Operate, change, deploy, and troubleshoot jerry's Tailscale setup — the home LAN subnet router and exit node, the tailnet policy, family exit-node access, the API token, and jerry's root-owned Tailscale configuration. Use for Tailscale, tailnet, VPN into the home network, exit nodes, subnet routes, adding people, or a deployment failing in `tailnet.py deploy`.
---

# jerry on Tailscale

Read [README.md](README.md) for the access model, files, and commands, and
[config.md](config.md) for every setting. This skill covers what an agent needs on top: how
changes ship, where things live, how to look at the live tailnet, and the traps.

## Live facts

Read them from the tailnet rather than from memory:

```bash
ssh jerry 'tailscale status --json' | python3 -c 'import json,sys; s=json.load(sys.stdin)["Self"]; print(s["DNSName"], s["Tags"], s["TailscaleIPs"])'
ssh jerry 'tailscale debug prefs'          # hostname, advertised routes, operator, auto-update
```

The tailnet has one admin, the user. jerry is the only device that is always on. jerry runs Ubuntu
with NetworkManager and netplan; `accept_ra=0` on its interfaces, so IPv6 forwarding is safe. ufw
is active, and Tailscale's own `ts-input`/`ts-forward` chains admit tailnet traffic without ufw
rules.

## How changes ship

Commit to `main` and push (see `AGENTS.md`). Activation runs `tailnet.py deploy` from the new release
as the deployment user, after the services are healthy. It compares and changes only what differs:

| Change | Ships by |
| --- | --- |
| `policy.json`, or `lan`, `tag`, `router` used in it | Push. Deploy replaces the tailnet policy when it differs. |
| `hostname` or `lan` as jerry's advertised route | Push. Deploy runs `tailscale set` as the tailscaled operator. |
| Family members | Edit `TAILSCALE_FAMILY` in jerry's `.env`, then run `tailnet.py deploy` from the current release (a push deploys only new commits). |
| `tag`, `sysctlFile`, anything under `gro` or `apt`, operator, auto-update | Push, then the user runs `setup_server.py` on jerry; it needs sudo. |

A deployment fails, and the release rolls back, when the root setup is outdated, the API token is
invalid, or Tailscale rejects the policy (including its `tests`). Policy and node settings are not
rolled back. A change to the root setup fails every deployment until the user reruns
`setup_server.py`, so give the user the command right after such a push.

## Where things live on jerry

| Path | Contents |
| --- | --- |
| `~/.local/share/jomaa-deploy/current/jomaa-tailscale/` | Deployed code; run scripts from here. |
| `$JOMAA_DEPLOY_SOURCE/jomaa-tailscale/.env` | The token and family emails, mode 600, linked into each release. Find the source with `XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user cat jomaa-deploy`. |
| `sysctlFile`, `gro.dispatcher` | Root-owned files written by `setup_server.py`. |

`.env` is the only place the token is stored. The repository is public: never commit the token or
family emails, and never print the token. Check it by its `tskey-api-` prefix only.

## Credentials

- `TAILSCALE_API_KEY` must be an **API access token** (`tskey-api-…`, Settings → Keys → Generate
  access token). A `tskey-auth-…` auth key only joins devices; the API answers 401 to it.
- Access tokens expire. When deployments fail with `Tailscale API … 401`, ask the user for a new
  token and replace the line in jerry's `.env`.
- `setup_server.py` mints jerry's single-use auth key through the API when jerry needs to (re)join;
  nobody handles auth keys by hand.

## Diagnose

```bash
ssh jerry 'XDG_RUNTIME_DIR=/run/user/$(id -u) journalctl --user -u jomaa-deploy -n 50 --no-pager'
ssh jerry 'cd .local/share/jomaa-deploy/current/jomaa-tailscale && python3 tailnet.py deploy'
```

For API reads, run Python in the deployed directory on jerry, fed over stdin, so the token never
leaves jerry:

```bash
ssh jerry 'cd .local/share/jomaa-deploy/current/jomaa-tailscale && python3 -' <<'EOF'
import tailnet
for d in tailnet.api().request("GET", "/devices")["devices"]:
    print(d["name"], d.get("tags"), d["addresses"])
EOF
```

## Traps

- **No sudo for agents.** sudo on jerry asks for a password. Give the user the exact
  `ssh -t jerry …` command and verify afterwards.
- **`ssh jerry` goes through Cloudflare** (`jomaa-ssh`), not Tailscale, so Tailscale changes don't
  drop the session. On laptops the `jerry` SSH alias shadows the MagicDNS name; use jerry's full
  `DNSName` or Tailscale IP to reach it over the tailnet.
- **Changing tags needs re-authentication.** `tailscale set` can't change tags. `setup_server.py`
  re-joins with `--force-reauth` and a fresh key when jerry lacks `tag`, keeping the same node and
  IP.
- **Policy tests need members.** The `tests` block is sent only when `group:family` is nonempty.
- **Quoting over SSH.** The Mac runs zsh; jerry's `~/.bashrc` is bash and isn't read by
  non-interactive SSH. Pass Python to jerry over stdin with a quoted heredoc rather than nesting
  quotes inside `ssh jerry '…'`.
- **Pushing from the Mac.** Outbound SSH to GitHub is blocked there. Push over HTTPS with the `gh`
  login, outside the sandbox:
  `git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push https://github.com/jomaa-daniel/jomaa-everything.git main`.
  Then confirm the `deploy` job with `gh run list -R jomaa-daniel/jomaa-everything --workflow deploy.yml --limit 1`.

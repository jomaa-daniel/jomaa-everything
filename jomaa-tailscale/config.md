# jomaa-tailscale configuration

Settings live in two committed files and one file on jerry. A test fails when
a setting in any of them is missing from this document.

## config.json

Read by `setup_server.py` and `tailnet.py`.

| Key | Type | Meaning |
| --- | --- | --- |
| `lan` | CIDR | Home LAN that jerry advertises as a subnet route. Fills `{lan}` in `policy.json`. |
| `router` | address | Home router on the LAN. Fills `{router}` in `policy.json`, where the tests deny family access to it. |
| `tag` | tag | Tag jerry joins with. Owns the auto-approved route and exit node. Fills `{tag}` in `policy.json`. |
| `hostname` | name | jerry's Tailscale hostname and MagicDNS name. Also the description of minted auth keys. |
| `api` | URL | Tailscale API base for this tailnet (`-` is the token's own tailnet). |
| `apiTimeoutSeconds` | seconds | Deadline for each Tailscale API request. |
| `authKeyExpirySeconds` | seconds | Lifetime of the single-use auth key `setup_server.py` mints to join jerry. |
| `userAgent` | string | `User-Agent` header of Tailscale API requests. |
| `queryTimeoutSeconds` | seconds | Deadline for quick commands: `tailscale status`, `tailscale debug prefs`, `tailscale set`, `ip route`, and root file writes. |
| `commandTimeoutSeconds` | seconds | Deadline for setup commands such as package installation. |
| `routeProbeAddress` | address | Internet address whose route names jerry's default-route interface, the interface that gets UDP GRO forwarding at setup. |
| `apt` | object | Tailscale's Ubuntu package repository. |
| `apt.repository` | URL | Repository base; the release codename selects the suite and signing key. |
| `apt.keyring` | path | Where the repository's signing key is stored. |
| `apt.sourceList` | path | APT source file for the repository. |
| `sysctlFile` | path | Root-owned file that keeps IPv4 and IPv6 forwarding on. |
| `gro` | object | UDP GRO forwarding for traffic jerry forwards. |
| `gro.dispatcher` | path | NetworkManager dispatcher script that turns it on when an interface comes up. |
| `gro.ethtool` | path | `ethtool` executable used by setup and the dispatcher script. |
| `gro.skipInterfaces` | shell patterns | Interfaces the dispatcher script leaves alone: loopback, Tailscale, containers and bridges. |

## policy.json

The tailnet policy, sent by `tailnet.py deploy` after filling placeholders and
`group:family`. Tailscale's policy syntax applies.

| Key | Meaning |
| --- | --- |
| `groups` | `group:family`, always empty here; deployment fills it from `TAILSCALE_FAMILY`. |
| `tagOwners` | Admins own `{tag}`, so jerry can join with it. |
| `autoApprovers` | `{lan}` and the exit node advertised by `{tag}` are approved without the admin console. |
| `grants` | Admins reach everything; `group:family` reaches only `autogroup:internet`, the internet through an exit node. |
| `tests` | Connections Tailscale must deny for `group:family`; it rejects a policy that allows them. Sent only when `group:family` has members. |

| Placeholder | Filled from |
| --- | --- |
| `{lan}` | `lan` |
| `{tag}` | `tag` |
| `{router}` | `router` |

## .env

Secrets and private values on jerry, in the deployment's state checkout,
mode 600. Not committed; `.env.example` shows the shape.

| Key | Meaning |
| --- | --- |
| `TAILSCALE_API_KEY` | Tailscale API access token (`tskey-api-`). Used to read and replace the policy and to mint jerry's auth key. Expires; replace it when the API answers 401. |
| `TAILSCALE_FAMILY` | Comma-separated emails of people who may use jerry as an exit node and reach nothing else. |

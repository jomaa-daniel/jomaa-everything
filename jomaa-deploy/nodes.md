# Node catalog

`nodes.json` is the shared catalog for hub authorization, request routing,
Cloudflare ingress and deployment selection. `nodes.example.json` is a node
entry template; add a configured entry to `nodes.json.nodes` to use it.

| Setting | Meaning |
| --- | --- |
| `defaultNode` | ID of the enabled gateway; local development uses it when no installation identity exists. |
| `identityFile` | File inside `deployDirectory` containing the installation's node ID. Installation writes it; changing an installed identity requires a separate installation. |
| `routing` | Routing policy for each capability. `account` uses one node assigned in account management and rejects request-level node overrides; `request` permits choosing a granted node per request. The owner uses `defaultNode` for account-routed capabilities. |
| `routing.lights` | Determines how lighting requests select their installation. |
| `routing.devices` | Determines how device-health requests select their installation. |
| `routing.cameras` | Determines how camera viewing selects its installation. |
| `routing.manage` | Determines how organization requests select their installation. |
| `transport` | Bounds applied to inter-node requests. |
| `transport.requestTimeoutSeconds` | Total deadline for forwarding a request, including reading its response. |
| `transport.maxRequestBytes` | Maximum buffered request body. |
| `transport.maxResponseBytes` | Maximum bytes forwarded in one response, including event streams. |
| `transport.delegationLifetimeSeconds` | Lifetime of a signed, single-use request authorization. |
| `transport.secretMinLength` | Minimum length of each private inter-node key. |
| `transport.replayLimit` | Maximum live request IDs retained by a node; new requests are refused when full. |
| `nodes` | Installation entries; IDs and hostnames must be unique. |
| `nodes[].id` | Stable identifier used in profile grants and installation commands. |
| `nodes[].name` | Display name shown in account and node selection controls. |
| `nodes[].enabled` | Whether profiles can use the node and Actions sends it deployments. Disabled nodes refuse hub requests. |
| `nodes[].mode` | `gateway` owns accounts and routes requests; `node` accepts delegated capabilities and its explicit public routes. |
| `nodes[].hostname` | Cloudflare tunnel hostname. Null on the gateway reads `webhook.hostname` from `config.json`. Nodes require a distinct hostname. |
| `nodes[].tunnelName` | Name of this installation's locally managed tunnel. Null on the gateway reads `tunnel.name` from `config.json`. |
| `nodes[].secretEnv` | Environment variable containing this node's inter-node key, provisioned in the gateway and this node's private hub `.env`. Null for the gateway. |
| `nodes[].deploySecret` | GitHub Actions secret name containing this installation's receiver HMAC key. Each installation uses a different key. |
| `nodes[].scopes` | Capability allowlist. Profile grants are intersected with it; the owner is also subject to it for node operations. |
| `nodes[].publicRoutes` | Exact method/path pairs that a node accepts without delegation. These are narrow infrastructure exceptions, separate from user capabilities. |
| `nodes[].modules` | Deployment module name allowlist. Null selects all modules on the gateway; a node requires an explicit list. |
| `nodes[].moduleOverrides` | Per-module declaration field replacements, validated by the module's existing schema and included in its fingerprint. |
| `nodes[].moduleOverrides.hub` | Hub declaration overrides in the example. Any selected module can have overrides. |
| `nodes[].moduleOverrides.hub.routes` | Example route replacement for the selected hub service. |
| `nodes[].moduleOverrides.hub.routes[].hostname` | `{node.hostname}` reads the selected catalog entry; no hostname is copied into a module declaration. |

The keys of `moduleOverrides` are module names and their fields follow
[`config.md`](config.md). Strings in overrides may reference `{node.hostname}`
or `{node.id}`. Overrides replace an entire declaration field.

Profiles contain `grants`: a list of `{node, scopes}` entries. Each entry
grants capabilities on one enabled node. Invitations carry these grants so
the recipient can control the selected home immediately after registration.
Accounts without grants cannot control a node. Changing or deleting a grant
affects the next request. The `routing` policy determines each capability's
selection source. Account-routed capabilities have one assigned node and reject
request-level overrides. The account manager presents a single node choice for
these capabilities; removing it removes access. Request-routed capabilities
accept a granted `node` query parameter and otherwise select the first granted
node. Clients can list their nodes and routing policies at `/api/nodes`.

Cloudflare DNS selects a tunnel by hostname. The gateway authenticates the
profile, authorizes the selected capability and sends a signed request through
the destination's tunnel. Signatures bind issuer, destination, scope, method,
URL, content type, body hash, expiry and a single-use request ID. Cookies,
account bearer tokens and browser headers do not travel to the node. Nodes
authorize using route metadata and their own allowlists before any page,
device report or handler runs. Owner routes stay on the gateway.

Each installation has its own state, tunnel, receiver and receiver secret.
The deployment receiver accepts only signed verified main-branch releases;
it runs independently of hub user traffic. Module selection bounds services,
static sites and commands on a node. The example selects only the hub, so it
does not install the gateway's SSH, static sites, Worker or tailnet commands.

To install an entry on its own Linux machine, provision its hub `.env` and
local device layout, then run `python3 jomaa-deploy/deploy.py install --node ID`
from the committed checkout. Store that machine's receiver key in the
Actions secret named by `deploySecret`. Install its `secretEnv` key on that
machine and the gateway. Pushes to main send the verified revision to every
enabled catalog entry. The gateway's configured receiver URL override remains
available through the repository variable `JOMAA_DEPLOY_URL`.

# jomaa-deploy

Deployment for the Jomaa repository on jerry. Every top-level folder with a
`deploy_module.py` is a module: a service, a command, an external origin or a
set of checks. Pushing to `main` verifies each module on its own, and the
receiver on jerry deploys the modules whose checks passed and that changed.
A failing module keeps its previous version and does not hold back the
others. The Python tools use the standard library.

| File | Responsibility |
| --- | --- |
| `config.json` | Global settings, documented in [`config.md`](config.md). |
| `deploy.json`, `deploy_module.py` | This folder's own module: its checks gate every deployment. |
| `modules/base.py` | The `Module` contract, declaration validation, fingerprints, and the activation context. |
| `modules/service.py` | `Service` and `StaticSite`. |
| `modules/command.py` | `Command`, `External` and `Checks`. |
| `modules/ingress.py` | Tunnel ingress, DNS and the route inventory from the live declarations. |
| `engine.py` | Module discovery, the activation phases, records and removal. |
| `deploy.py` | Signed receiver, releases, the handoff to a release's own activation, installation, and pruning. |
| `routing.py` | Tunnel configuration rendering and validation, and per-hostname DNS reconciliation. |
| `cloudflare_api.py` | Cloudflare API client. |
| `native.py` | Persistent hub state and local tunnel provisioning for the installer. |
| `boot.py` | Native launcher of the hub and the tunnel. |
| `settings.py` | Reads `config.json`. |
| `notify.py` | GitHub Actions signed deployment request and reconnect retries. |
| `verify.py` | Runs module checks locally and in GitHub Actions. |

## Modules

A module extends one of the classes in `modules/`. Defining the class in a
top-level `deploy_module.py` registers it; the folder's `deploy.json` declares
it. Every key is described in [`config.md`](config.md).

| Class | Deploys |
| --- | --- |
| `Service` | Runs its build commands, writes a systemd user unit, restarts it and waits for its HTTP health check. A failure restores the previous release, unit and process; without a recorded version, it restores the unit file it replaced, or stops and removes the new unit. Its routes reach its loopback origin. |
| `StaticSite` | One hostname folder of a static server, created by the server's `children()`. It is served from the site map. |
| `Command` | Runs its build commands and command on every activation, from the new release. Commands compare desired and actual state themselves; a failure is not rolled back. |
| `External` | Nothing; publishes routes to an origin provisioned outside deployment, such as SSH. |
| `Checks` | Nothing; its checks run in GitHub Actions and locally. |

The current modules:

| Folder | Module | Class |
| --- | --- | --- |
| `jomaa-deploy` | `deploy` | `Checks`, run by the workflow's `verify` job |
| `jomaa-home-hub` | `hub` | `Service` |
| `jomaa-static-pages` | `static` and one `StaticSite` per hostname folder | `Service` |
| `jomaa-ssh` | `ssh` | `External` |
| `jomaa-tailscale` | `tailnet` | `Command` |
| `jomaa-health` | `health` | `Command` |
| `pico-imaging-bench` | `pico-imaging-bench` | `Checks` |

### Add a module

Create the folder with a `deploy_module.py`:

```python
from modules import Service


class App(Service):
    pass
```

and a `deploy.json`:

```json
{
  "name": "app",
  "inputs": [],
  "checks": [["{python}", "-m", "unittest", "discover", "-s", ".", "-q"]],
  "state": [],
  "stateInputs": [],
  "unit": "jomaa-app",
  "origin": "http://127.0.0.1:9000",
  "command": ["{python}", "{release}/jomaa-app/server.py"],
  "build": [],
  "health": {"path": "/healthz", "json": {"ok": true}},
  "routes": [{"hostname": "app.jomaa.org"}]
}
```

Push it to `main`. The workflow adds a `check (app)` job, and the next
activation builds the module, starts `jomaa-app`, adds its tunnel route and
creates its DNS record. Install any runtime tools the module needs on jerry
and in the workflow's check job. Create its `state` paths in the checkout on
jerry first; state paths are untracked and cannot overlap.

A class may override the `Module` methods: `routes()`, `children()`,
`fingerprint(ctx)`, `build`, `snapshot`, `activate`, `verify`,
`rollback(snapshot)` and `remove(record)`. `snapshot` returns, as JSON, what
`activate` will replace, and `rollback` receives it. The static server's `deploy_module.py` overrides
`children()` to return a `StaticSite` for each hostname folder.

Removing a module's folder, or renaming the module, removes it at the next
activation: a service's unit is disabled and deleted, a site leaves the site
map, and its routes and DNS records go.

### Add a static site

Create a folder named with the site's full hostname in `jomaa-static-pages/`:

```text
jomaa-static-pages/new.jomaa.org/index.html
jomaa-static-pages/new.jomaa.org/gallery/index.html
```

Each hostname folder is its own module, named with the hostname. Activation
points the site map at the folder in the new release, the static server
re-reads the map, and the site must answer `/` with HTTP 200 for its Host
header. A site that fails keeps its previous folder, or stays out of the map
when it is new. Hostname folders need an `index.html` inside them and cannot
be symlinks. Folders without a dot, such as `device-panel/`, are not sites.
Sarah's site lives in `jomaa-static-pages/sarah.jomaa.org/`.

### Routes

Routes reach the module's origin. A path route uses an anchored cloudflared
regular expression and declares sample request paths that tunnel validation
checks:

```json
{"hostname": "app.jomaa.org", "path": "^/api(/.*)?$", "probes": ["/api", "/api/status"]}
```

The tunnel's rules are the receiver's `/deploy` path first, then every live
route in module name order with static sites last, then a 404 rule. A
whole-host route moves after the last path route for the same hostname, so
path routes take precedence. The first module to claim a hostname and path
keeps it; a later claim is reported as a conflict and left out. The origin
receives the original request path. DNS is shared by all paths on a hostname.

## Automatic deployment

`.github/workflows/deploy.yml` runs on every push and pull request:

- `modules` lists the modules with checks, from
  `python3 jomaa-deploy/deploy.py modules --json`.
- `verify` runs this folder's checks.
- `check (<module>)` runs each listed module's checks, one job per module,
  without cancelling the others when one fails.
- `deploy`, on pushes to `main`, runs when `verify` succeeded, whatever the
  module checks concluded, and sends a signed request to the receiver.

The receiver verifies the HMAC signature, request age, repository, revision,
workflow path, push event, branch, and the successful `verify` job. It accepts
only revisions on `main` that descend from the deployed revision; an older
revision is ignored. It extracts the revision into `releases/<sha>` and hands
activation to that release's own code: it runs
`deploy.py activate --sha SHA --run-id N --attempt N --result FILE` from the
new release while holding `deploy.lock`, with its output in the receiver's
journal. The activation writes its result to the file, and the receiver
answers the request with the result and the revision. The receiver restarts
after answering when the `current` pointer moved, which it does at the end of
every activation whose new receiver passes its self-check, so the next
request runs the new receiver.

Pull requests and manual workflow runs check without deploying.

### Activation

The activation reads the jobs of its workflow run attempt from GitHub. A
module with checks is eligible only when its `check (<module>)` job
succeeded; a failed, skipped, cancelled or missing job makes it ineligible,
and it keeps its deployed version.

Each module's fingerprint is a hash of the git objects of its folder's
top-level entries and of its `inputs` at the revision, the path and content of
every source file in the release that defines one of the module's classes
(its `deploy_module.py` and the `modules/*.py` it inherits from), an
HMAC-SHA256 of each of its `stateInputs` files in the checkout, together with
its declaration. Entries that the module's children own are left out: a static
site's folder counts for that site alone, so a site change does not restart
the static server. The HMAC key is the private file `stateInputKeyFile` in the
deployment directory, and records hold only the final fingerprint. A module is built and activated only when its fingerprint
differs from its record or its last attempt failed; an unchanged module is
not built or restarted. Commands run on every activation.

The result of each run attempt is stored in
`results/<sha>-<run id>-<attempt>.json`. A repeated request for the same
attempt, such as `notify.py` sending again after its request timed out while
the activation ran, reports the stored result without activating again. A new
attempt of the workflow, such as rerunning the `deploy` job, activates again
and retries the failed modules.

The phases run in this order, each module on its own with the time budget
`moduleTimeoutSeconds`:

1. checks-only modules and external origins
2. services
3. static sites
4. ingress: the tunnel and DNS
5. commands

A module that fails to import, or whose `deploy.json` is invalid, fails
without being removed: it keeps its deployed version and routes. Ingress is
built from the live declarations: the new one of each module deployed now,
and the recorded one of every other module. The tunnel configuration is
validated with cloudflared, and `tunnel.yml` is rewritten and the tunnel unit
restarted only when the configuration or unit changed. A tunnel restart
interrupts SSH sessions and in-flight HTTPS requests, including the
deployment request; the sender retries until the receiver answers. DNS is
reconciled per hostname: records carry the `Managed by jomaa-deploy`
comment, existing CNAMEs to this tunnel are adopted, a conflicting record is
reported and left alone, and only records with that comment pointing to this
tunnel are deleted. Hostnames under management are listed in `ingress.json`.

Before the commands run, the live services and routes are written to the
file a command declares as `inventory`. The health Worker bundles that file.

At the end the new release's `deploy.py self-check` runs, within
`selfCheckTimeoutSeconds`. It loads the receiver's code, settings and request
handler without binding its port, reading the webhook secret or contacting the
network. When it passes, the `current` pointer moves to the new release and
the result reports `"engine": "deployed"`. When it fails, `current` stays on
the running receiver, the result reports `"engine": "failed"` and the status
is `partial`; the modules keep what this activation deployed. Releases beyond
`releasesKept` are pruned unless a pointer still uses them.

### Result

```json
{"status": "partial", "modules": {"hub": "deployed", "static": "unchanged", "ssh": "ineligible"},
 "ingress": {"tunnel": "unchanged", "conflicts": [], "dns": {"hub.jomaa.org": "unchanged"}},
 "engine": "deployed"}
```

| Module status | Meaning |
| --- | --- |
| `deployed` | Built, activated and healthy; a command ran successfully. |
| `unchanged` | Same fingerprint as the deployed version; nothing was done. |
| `failed` | It failed and its previous version is live again, or it failed to load. |
| `failed-unrestored` | It failed and its previous version did not pass its health check after the rollback. |
| `ineligible` | Its check job did not succeed. |
| `removed` | Its folder or name is gone and its effects were undone. |

DNS hosts report `created`, `updated`, `unchanged`, `deleted`, `unmanaged`
(an unwanted record that deployment does not own), `conflict` or `failed`.
The status is `deployed` when every module is deployed, unchanged or
removed, ingress has no failure and the engine is `deployed`, and `partial`
otherwise. `notify.py`
succeeds for `deployed` and an ignored older revision, and for `partial`
prints each module's status and fails the workflow. Rerunning the `deploy`
job retries the failed modules.

### Records

```text
~/.local/share/jomaa-deploy/
  current -> releases/<sha>          the receiver's release
  releases/<sha>/                    one per revision
  modules/<name>/current -> releases/<sha>
  modules/<name>/previous -> releases/<sha>
  modules/<name>/record.json         revision, fingerprint, live declaration, failed, pending
  results/<sha>-<run id>-<attempt>.json  result of each run attempt
  sites.json                         static site map
  ingress.json                       hostnames under DNS management
```

Result files are deleted with their release.

Before a module activates, its record keeps its revision, fingerprint and
declaration and sets `pending` to the new revision and the module's snapshot:
a service's previous pointer target and unit file text, a static site's
previous site map entry. A finished deployment, successful or rolled back,
writes the record with `pending` set to `null`. When an activation finds a
pending record, the previous one stopped mid-module: it rolls the module back
with the snapshot, using the recorded declaration or, without one, the new
release's module, then marks the record failed so the module deploys again. A
module whose rollback fails reports `failed-unrestored`. A record that is not
in this format is discarded with a journal line, and its module deploys as if
it had no record.

A service's unit runs from its module pointer, so it keeps its release when
other modules deploy. `previous` is the release the module replaced. Local
application data is shared between releases through `state` links and is not
rolled back.

## Install on jerry

Requirements: Linux x86_64 or arm64, Python 3.12+, Git, Node.js 22.13+, npm,
systemd, and an internet connection. The installer provisions persistent hub
state, downloads a checksum-verified cloudflared binary, and creates a locally
managed Cloudflare tunnel. It enables user lingering for services to start
at boot without a login. Provision keys-only SSH with
`python3 jomaa-ssh/setup_server.py` for the `ssh` module's origin.

Copy `jomaa-home-hub/.env.example` to `jomaa-home-hub/.env` and set a
`HUB_PASSWORD` of at least `hubPasswordMinLength` characters and
`CLOUDFLARE_API_TOKEN`. Set `GOVEE_API_KEY` when using Govee. For automatic
DNS changes the token needs **Zone > Zone > Read** and **Zone > DNS > Edit**
for every domain of a route. The API token stays on jerry. Tunnel credentials
stay in `~/.cloudflared`; the cloudflared binary and tunnel configuration stay
in the hub's `data/native/`. `webhook.hostname` in `config.json` must match
the receiver URL used by Actions.

From a clean checkout containing the committed deployment code:

```bash
export XDG_RUNTIME_DIR=/run/user/$(id -u)
python3 jomaa-deploy/deploy.py install --repo jomaa-daniel/jomaa-everything
gh secret set JOMAA_DEPLOY_SECRET --repo jomaa-daniel/jomaa-everything < ~/.local/share/jomaa-deploy/webhook-secret
```

Tunnel provisioning prompts for Cloudflare browser authorization when
`~/.cloudflared/cert.pem` is absent. `--tunnel-name NAME` selects or creates
a locally managed tunnel; its credentials must be on jerry. An existing
`data/native/tunnel.yml` keeps its tunnel identity, and activation renders all
public ingress from the modules. Back up `~/.cloudflared` and the hub data.

The installer uses the checkout as the source of persistent state, activates
its committed revision with every module eligible, and enables the receiver
user service. Rerunning it at the deployed revision activates nothing. The
private secret file must match the GitHub repository secret. Set the
`JOMAA_DEPLOY_URL` repository variable when using a receiver URL other than
the one `webhook.hostname` names.

```bash
systemctl --user status jomaa-deploy jomaa-hub jomaa-static-pages jomaa-cloudflared
journalctl --user -u jomaa-deploy -f
```

Commands run as the deployment user and cannot use sudo. Root-owned setup
stays in a project's own setup script, and its command fails when that setup
is missing or outdated.

## Check locally

```bash
python3 jomaa-deploy/deploy.py modules
python3 jomaa-deploy/deploy.py plan
python3 jomaa-deploy/deploy.py self-check
python3 jomaa-deploy/verify.py
python3 jomaa-deploy/verify.py hub
python3 -m unittest discover -s jomaa-deploy -v
```

`modules` lists every module, its class, folder and check job. `plan`
validates the declarations and prints the modules, the tunnel rules and the
state paths without contacting Cloudflare or changing services.
`self-check` loads the receiver as activation does before moving `current`.
`verify.py`
runs every module's checks, or the named modules'. Tests use temporary
repositories, a simulated Cloudflare and recorded service commands.

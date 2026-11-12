# jomaa-deploy

Deployment for the Jomaa repository on jerry. `deploy.json` is the source of
truth for infrastructure services, fixed routes, local state, and verification
commands. Static sites are discovered from hostname directories under
`jomaa-static-pages/`. The Python tools use the standard library.

| File | Responsibility |
| --- | --- |
| `deploy.json` | Service, route, state, provision, and check declarations. |
| `manifest.py` | Static site discovery, declaration validation, and ingress generation. |
| `native.py` | Persistent state and local tunnel provisioning. |
| `boot.py` | Native service launcher. |
| `deploy.py` | Signed receiver, release construction, service activation, rollback, and pruning. |
| `routing.py` | Native tunnel configuration and managed DNS reconciliation. |
| `cloudflare_api.py` | Cloudflare API client. |
| `notify.py` | GitHub Actions signed deployment request and reconnect retries. |
| `verify.py` | Run every check declared in the manifest. |

## Automatic deployment

`.github/workflows/deploy.yml` verifies every push and pull request. A
successful push to `main` sends a signed request to `https://hub.jomaa.org/deploy`.
The receiver verifies the HMAC signature, request age, repository, revision,
workflow path, push event, branch, and successful GitHub verification job. It
accepts only revisions on `main` that descend from the deployed revision.
Pull requests and manual workflow runs verify without deploying.

The receiver extracts the requested revision without reading its
`deploy.json` and hands activation to that release's own code: it runs
`deploy.py activate --sha SHA --run-id N --attempt N --result FILE` from the
new release while holding `deploy.lock`, with its output in the receiver's
journal. The activation writes `{"status": ...}` to the result file, and the
receiver answers the request with that result and the revision. A revision
older than the deployed one is ignored without a handoff; the deployed
revision itself is handed off and reports `already-deployed`. When the
`current` pointer moved, the receiver restarts after answering and runs the
new release's receiver.

Each release contains the complete tracked repository at the requested
revision. Paths in `state` are untracked files or directories in the local
checkout, linked into releases. Services run from one atomic `current`
pointer under `~/.local/share/jomaa-deploy`; each managed service is built and
restarted during deployment. The three newest releases and the current
release are retained.

Activation validates the full ingress with cloudflared, reconciles DNS,
starts the services, checks their health and every static site, replaces
tunnel ingress, and runs the declared provision commands. The deployment receiver's path is always first and unmatched
requests reach a 404 rule. Tunnel restarts occur when ingress or its service unit changes; they
interrupt SSH sessions and in-flight HTTPS requests. The sender retries
temporary connection failures and recognizes an already deployed revision.

A failed activation restores the previous release pointer, service files,
tunnel configuration, and DNS mutations. Restoration errors appear in the
deployment journal. Local application data is shared between releases and
is not rolled back.

## Install on jerry

Requirements: Linux x86_64 or arm64, Python 3.12+, Git, Node.js 22.13+, npm,
systemd, and an internet connection. The installer provisions persistent hub
state, downloads a checksum-verified cloudflared binary, and creates a locally
managed Cloudflare tunnel. It enables user lingering for services to start
at boot without a login.
Provision keys-only SSH with `python3 jomaa-ssh/setup_server.py` if using the
manifest's external SSH origin.

Copy `jomaa-home-hub/.env.example` to `jomaa-home-hub/.env` and set a
`HUB_PASSWORD` of at least 12 characters and `CLOUDFLARE_API_TOKEN`. Set
`GOVEE_API_KEY` when using Govee. For automatic DNS changes
the token needs **Zone > Zone > Read** and **Zone > DNS > Edit** for every
domain declared in the manifest. The API token stays on jerry. Tunnel
credentials stay in `~/.cloudflared`; the cloudflared binary and tunnel
configuration stay in the hub's `data/native/`.
The manifest's `webhook` hostname must match the receiver URL used by Actions.

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
public ingress from the manifest. Back up `~/.cloudflared` and the hub data.

The installer uses the checkout as the source of persistent state, activates
its committed revision, and enables the receiver user service. Rerunning it
at the deployed revision keeps the release's build. The private secret file
must match the GitHub repository secret. Set the `JOMAA_DEPLOY_URL` repository
variable when using a receiver URL other than `https://hub.jomaa.org/deploy`.

```bash
systemctl --user status jomaa-deploy jomaa-hub jomaa-static-pages jomaa-cloudflared
journalctl --user -u jomaa-deploy -f
```

## Change the manifest format

Activation validates the current release's `deploy.json` with the new code.
A change to the manifest's required keys therefore can't deploy
through the receiver. On jerry, bring the current release's
`jomaa-deploy/deploy.json` to the new format, check out the new revision in
the state checkout (`JOMAA_DEPLOY_SOURCE` in the `jomaa-deploy` unit), and run
the installer there as a detached user unit, so a tunnel restart can't end it:

```bash
export XDG_RUNTIME_DIR=/run/user/$(id -u)
systemd-run --user --unit=jomaa-deploy-install --collect \
  --setenv=JOMAA_DEPLOY_SOURCE="$SRC" -p WorkingDirectory="$SRC" \
  /usr/bin/python3 jomaa-deploy/deploy.py install --repo jomaa-daniel/jomaa-everything
journalctl --user -u jomaa-deploy-install -f
```

Then rerun the failed workflow's `deploy` job; the receiver reports the
revision as already deployed.

## Add a static site or subdomain

Create a directory named with the site's full hostname:

```text
jomaa-static-pages/new.jomaa.org/index.html
jomaa-static-pages/new.jomaa.org/gallery/index.html
```

Push it to `main`. Discovery generates the hostname, static server mapping,
tunnel rule, and DNS record from the folder name. The example also serves
`https://new.jomaa.org/gallery/`. Each release discovers its own tracked folders,
so adding, renaming, or removing a site automatically reconciles its public
routes and DNS. Sarah's site lives in `jomaa-static-pages/sarah.jomaa.org/`.

Hostname directories need an `index.html` and cannot be symlinks. Support
folders such as `device-panel/` are excluded. Discovered sites cannot take
over a hostname assigned to a whole-host infrastructure service or the
receiver. Explicit path routes are evaluated before a discovered site's
whole-host route.

## Add a path route

Routes reference a service by name. Path routes use an anchored cloudflared
regular expression and declare sample request paths for routing validation:

```json
{
  "hostname": "app.jomaa.org",
  "path": "^/api(/.*)?$",
  "service": "app",
  "probes": ["/api", "/api/status"]
}
```

Rules are evaluated in declaration order. Put path rules before a whole-host
rule for the same hostname. The origin receives the original request path;
it must serve that path. Patterns must work with cloudflared's Go regular
expressions. DNS is shared by all paths on a hostname.

## Add a service

An external service declares only its loopback origin:

```json
"app": {"origin": "http://127.0.0.1:9000"}
```

It must be provisioned and running independently. Managed services also declare
a unique `jomaa-*` systemd unit name, repository directory, argument array,
optional build commands, and HTTP health check:

```json
"app": {
  "origin": "http://127.0.0.1:9000",
  "unit": "jomaa-app",
  "directory": "jomaa-app",
  "command": ["{python}", "{release}/jomaa-app/server.py"],
  "build": [],
  "health": {"url": "http://127.0.0.1:9000/healthz", "json": {"ok": true}}
}
```

Commands run directly with their declared working directory. `{python}`,
`{release}`, and `{home}` expand to the Python executable, release root, and
server user's home. `health.host` supplies a Host header; `health.json`
requires matching response fields. Origins use HTTP, HTTPS, SSH, or TCP on
loopback. Service units run as the deployment user. Install any required
runtime tools on jerry and in the workflow's verification environment.

Add the service's verification commands to `checks`:

```json
{"directory": "jomaa-app", "command": ["{python}", "-m", "unittest", "discover"]}
```

Add persistent files or directories to `state` and create them in the local
checkout before deployment. State paths cannot overlap or contain tracked
files. Deployments manage the declared service unit files and the tunnel unit
directly. The hub and tunnel launch through `jomaa-deploy/boot.py` from the
current release.

## Add a provision step

Provision commands configure things outside the release, such as the tailnet,
on every activation. They run in declaration order from the activated release,
as the deployment user, after services are healthy and ingress is in place:

```json
"provision": [
  {"directory": "jomaa-tailscale", "command": ["{python}", "{release}/jomaa-tailscale/tailnet.py", "deploy"]}
]
```

`{release}` expands to the `current` pointer. A failing command rolls the
release, units, tunnel, and DNS back; changes the command already made outside
the release are not rolled back, so commands compare desired and actual state
and change only what differs. They cannot use sudo. Root-owned setup stays in
a project's own setup script, and its provision command fails when that setup
is missing or outdated.

## Remove or change a route

Rename or remove a static site directory, or edit an infrastructure route,
and push to `main`. Discovery and declarations generate the desired ingress. DNS records carry the `Managed by jomaa-deploy` comment; removal deletes
only records with that comment pointing to this tunnel. Existing CNAMEs
pointing to this tunnel are adopted. Conflicting records fail deployment
without being overwritten. Managed services removed from the manifest are
disabled and their unit files removed. External services remain independently
provisioned.

## Check locally

```bash
python3 jomaa-deploy/deploy.py plan
python3 jomaa-deploy/verify.py
python3 -m unittest discover -s jomaa-deploy -v
```

`plan` validates declarations and prints services, ingress, and state paths
without contacting Cloudflare or changing services. Tests use temporary
repositories and simulated Cloudflare resources and service restarts.

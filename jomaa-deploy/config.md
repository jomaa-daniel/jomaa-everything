# jomaa-deploy configuration

Deployment reads two kinds of committed settings: the global settings in
`config.json`, and each module's declaration in its own folder's
`deploy.json`. A test fails when a key of `config.json` or of any
component's `deploy.json` is missing from this document.

Secrets are not configuration. The Cloudflare API token is
`CLOUDFLARE_API_TOKEN` in the environment file named by `cloudflare.env`,
the webhook secret is `webhook-secret` in the deployment directory, and the
GitHub Actions secret `JOMAA_DEPLOY_SECRET` holds the same value. The key of
state input digests is the file named by `stateInputKeyFile` in the
deployment directory.

## config.json

| Key | Type | Meaning |
| --- | --- | --- |
| `repo` | `OWNER/REPOSITORY` | Repository deployed from `main`, unless `--repo` or `JOMAA_DEPLOY_REPO` names another. |
| `userAgent` | string | `User-Agent` of requests to GitHub, Cloudflare's downloads, the deployment receiver and health checks. |
| `webhook` | object | The deployment receiver. |
| `webhook.hostname` | hostname | Public hostname of the receiver. Its `/deploy` path is the first tunnel rule, and `notify.py` sends requests there unless the `JOMAA_DEPLOY_URL` repository variable names another URL. |
| `webhook.port` | port | Loopback port the receiver listens on. |
| `receiverUnit` | unit name | systemd user unit of the receiver. Services cannot use it. |
| `deployDirectory` | path | Releases, module records, the webhook secret, the state input key and the site map, unless `JOMAA_DEPLOY_HOME` names another directory. `~/` is the home directory. |
| `unitDirectory` | path | Directory of the systemd user units that deployment writes. |
| `siteMap` | file name | Site map in the deployment directory: each static site's hostname and the release directory the static server serves for it. |
| `releasesKept` | count | Newest releases kept besides the current release and every module's current and previous release. |
| `commandTimeoutSeconds` | seconds | Deadline of each build, check, systemctl and module command. |
| `gitTimeoutSeconds` | seconds | Deadline of each git command: fetch comparisons, archives and fingerprint lookups. |
| `moduleTimeoutSeconds` | seconds | Time budget of one module's build, activation and health check, and separately of its rollback. Commands and health waits stop when it runs out. |
| `healthWaitSeconds` | seconds | How long a restarted service may take to pass its health check. |
| `healthRequestTimeoutSeconds` | seconds | Deadline of each health check request. |
| `selfCheckTimeoutSeconds` | seconds | Deadline of the new release's `deploy.py self-check`, run before the `current` pointer moves to it. |
| `stateInputKeyFile` | file name | Private key file in the deployment directory that keys the HMAC-SHA256 digests of each module's `stateInputs`. Activation creates it with mode 0600 when it is missing and refuses it when group or others can read it. |
| `stateInputKeyBytes` | bytes | Length of a new state input key, and the least length an existing one must have. |
| `hubPasswordMinLength` | characters | Minimum length of the hub's `HUB_PASSWORD`, checked by the installer. |
| `tunnel` | object | The locally managed Cloudflare tunnel. |
| `tunnel.name` | string | Tunnel created or selected by the installer, unless `--tunnel-name` names another. |
| `tunnel.unit` | unit name | systemd user unit that runs cloudflared. Services cannot use it. |
| `tunnel.directory` | path | Checkout folder holding the cloudflared binary and `tunnel.yml`, inside the hub's linked `data` state. `jomaa-deploy/boot.py` reads it to start the tunnel and to find the hub's Matter storage. |
| `tunnel.cloudflaredVersion` | version | cloudflared release the installer downloads. |
| `tunnel.cloudflaredRepository` | `OWNER/REPOSITORY` | GitHub repository of the cloudflared releases. |
| `tunnel.downloadTimeoutSeconds` | seconds | Deadline of the cloudflared download. |
| `tunnel.validateTimeoutSeconds` | seconds | Deadline of each cloudflared ingress validation command. |
| `cloudflare` | object | Cloudflare API access for DNS. |
| `cloudflare.api` | URL | Cloudflare API base URL. |
| `cloudflare.env` | path | Checkout environment file holding `CLOUDFLARE_API_TOKEN`. |
| `cloudflare.timeoutSeconds` | seconds | Deadline of each Cloudflare API request. |
| `github` | object | GitHub access. |
| `github.api` | URL | GitHub API base URL, for workflow runs, their jobs and cloudflared releases. |
| `github.remote` | URL | Base URL the receiver fetches `main` from, followed by `/OWNER/REPOSITORY.git`. |
| `github.timeoutSeconds` | seconds | Deadline of each GitHub API request. |
| `github.jobsPerPage` | count | Page size when reading a workflow run's jobs. |
| `notify` | object | Retries of `notify.py` in GitHub Actions. |
| `notify.deadlineSeconds` | seconds | How long `notify.py` keeps retrying the receiver. |
| `notify.requestTimeoutSeconds` | seconds | Deadline of each request to the receiver. |
| `notify.retryDelaySeconds` | seconds | Pause between attempts. |
| `notify.retryStatuses` | HTTP statuses | Answers that are retried: a deployment already running and Cloudflare's unreachable-origin errors. |

## deploy.json

Every top-level folder with a `deploy_module.py` has a `deploy.json` that
declares its module. Each key below is required by the module kinds that list
it, and a declaration may not contain other keys.

| Key | Kinds | Meaning |
| --- | --- | --- |
| `name` | all | Module name: lowercase letters, digits, dots and hyphens. Names the record in `modules/<name>/` and the `check (<name>)` workflow job. |
| `inputs` | all | Repository paths outside the folder that the module depends on. A change to them or to the folder redeploys the module. |
| `checks` | all | Commands that verify the module, run from its folder by `verify.py` and in its workflow job. Modules with checks deploy only when that job succeeded. |
| `state` | all | Untracked paths of the checkout, inside the module's folder, linked into every release. Each must exist on jerry before deployment. |
| `stateInputs` | all | Untracked files of the checkout, as repository paths, whose content is part of the fingerprint: a change to one, or its creation or deletion, redeploys the module. Only a keyed digest of each enters the fingerprint, never the content. Leave out files the module writes while it runs. |
| `unit` | Service | systemd user unit name, `jomaa-` followed by lowercase letters, digits and hyphens. |
| `origin` | Service, External | Loopback URL with a port that the module's routes reach: HTTP, HTTPS, SSH or TCP. |
| `command` | Service, Command | The service's process, or the command run on every activation. |
| `build` | Service, Command | Commands run from the module's folder in the new release before activation. |
| `health` | Service | HTTP health check of the restarted service. |
| `health.path` | Service | Path requested from the origin; the answer must be HTTP 200. |
| `health.json` | Service | JSON fields the answer must contain, with their values. |
| `routes` | Service, External | Public routes to the origin. |
| `routes[].hostname` | Service, External | Public hostname. Deployment creates its DNS record. |
| `routes[].path` | Service, External | Anchored cloudflared regular expression; without it the route takes the whole hostname. |
| `routes[].probes` | Service, External | Request paths that must reach the origin when the tunnel configuration is validated; required with `path`, `["/"]` otherwise. |
| `inventory` | Command | File in the module's folder that receives the live services and routes as JSON before the command runs, or `null`. |

Commands are argument arrays run without a shell. `{python}`, `{release}`
and `{home}` expand to the Python executable, the release root and the
deployment user's home. A service's `{release}` is its module pointer,
`modules/<name>/current`, so its unit survives later releases.

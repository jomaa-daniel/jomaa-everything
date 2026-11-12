# jomaa-health configuration

The health page reads its settings from two committed files. A test fails when
a setting in either file is missing from this document.

Values that `../jomaa-deploy/deploy.json` already declares are read from there
and are not repeated here:

| From `deploy.json` | Used for |
| --- | --- |
| `routes[].hostname`, `routes[].service` | Every public hostname checked, and its kind of check. |
| `routes[].probes` | Paths requested through a path route; each must reach the hub. |
| `services.<name>.health.url`, `services.<name>.health.json` | Health path requested through a service's whole-host route, and the JSON fields its answer must contain. |
| `webhook` | Hostname whose deployment receiver must reject unsigned requests. |
| Hub path route and hub whole-host route | Sign-in and API reads go through the path route; Matter nodes through the whole-host route. |

Secrets are not configuration. The hub password is the Worker secret
`HUB_PASSWORD`, uploaded by `scripts/deploy.mjs` from the file named by
`deploy.hubEnvFile`.

## config.json

Settings of the checks and the deploy script.

| Key | Type | Meaning |
| --- | --- | --- |
| `staticSites` | hostnames | Sites served by `jomaa-static-pages`; each must serve an HTML index. A test keeps it equal to the hostname directories in `../jomaa-static-pages/`. |
| `requestTimeoutSeconds` | seconds | Deadline for each check's request. |
| `discoveryTimeoutSeconds` | seconds | Deadline for the Matter discovery scan, which waits for devices to advertise. |
| `reportTtlSeconds` | seconds | How long a report is reused before page loads run the checks again. Each run reads every Govee light through Govee's cloud API, so lower values use more of its daily quota. |
| `userAgent` | string | `User-Agent` header of every request the Worker makes. |
| `deploy` | object | Files read by `scripts/deploy.mjs` on jerry. |
| `deploy.tokenFile` | path | Cloudflare API token file, mode 600. Used when present and `CLOUDFLARE_API_TOKEN` is unset; otherwise wrangler's own login. `~/` is the home directory. |
| `deploy.hubEnvFile` | path | Hub environment file containing `HUB_PASSWORD`, relative to this directory. Must be mode 600. |

## wrangler.jsonc

Cloudflare deployment settings, read by wrangler.

| Key | Meaning |
| --- | --- |
| `$schema` | Wrangler's JSON schema, for editor validation. |
| `name` | Worker script name in the Cloudflare account. |
| `main` | Worker entry module. |
| `account_id` | Cloudflare account that owns the Worker and the `jomaa.org` zone. |
| `compatibility_date` | Workers runtime behavior date. |
| `workers_dev` | `false`: no `*.workers.dev` address; the Worker answers only on its custom domain. |
| `preview_urls` | `false`: no per-version preview addresses. |
| `routes` | The custom domain `health.jomaa.org`. Deployment creates its DNS record and certificate. |
| `observability` | Cloudflare Workers logs. |
| `observability.enabled` | `true`: request logs and exceptions appear in the Cloudflare dashboard. |

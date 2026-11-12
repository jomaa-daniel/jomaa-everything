# jomaa-everything

Home projects, kept in one repo.

| Folder | What it is |
|--------|------------|
| `jomaa-deploy/` | Repository verification, native releases, service definitions, Cloudflare routes and DNS. |
| `jomaa-home-hub/` | Matter controller hub. Runs on the home network and controls Matter and Govee devices through one interface. |
| `jomaa-home-client/` | Phone apps for the hub: Android (`android/`) and iOS (`ios/`). |
| `jomaa-static-pages/` | Static websites served through the hub's tunnel, such as Sarah's art portfolio at sarah.jomaa.org. |
| `jomaa-health/` | Public health page at health.jomaa.org, a Cloudflare Worker that checks everything reachable through jomaa.org. |
| `jomaa-ssh/` | SSH into jerry from anywhere through the hub's Cloudflare tunnel (`ssh jerry`), keys only. |
| `jomaa-tailscale/` | jerry on Tailscale: home LAN subnet router and exit node. Deployments apply the tailnet policy and node settings. |
| `pico-imaging-bench/` | Flash and verify the Pico health reporter over USB. |

Repo rules for people and agents are in [`AGENTS.md`](AGENTS.md).

## Checks

Run `python3 jomaa-deploy/verify.py` before pushing. It loads every deployment
module and runs its checks: hub dependencies, formatting, types, lint, Node
tests, dependency audit, the health page's types and tests, and Python tests
for deployment, static sites, SSH, Tailscale, and the Pico imaging bench. CI
runs each module's checks in its own job.

## Deployment

Each top-level folder with a `deploy_module.py` is a deployment module, and its
`deploy.json` declares its service, hostnames, path routes, persistent state,
and checks. Static sites are discovered from `jomaa-static-pages/<hostname>/`
directories. Verified pushes to `main` deploy through the signed HTTPS
receiver on jerry, module by module, including commands such as the tailnet
policy. See [`jomaa-deploy/README.md`](jomaa-deploy/README.md) for
installation, adding a site, and adding a module.

Turn on the pre-commit hook once per clone, so commits that break the hub's
format, types or lint are refused:

```bash
git config core.hooksPath .githooks
```

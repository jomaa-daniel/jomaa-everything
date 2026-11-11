# jomaa-everything

Home projects, kept in one repo.

| Folder | What it is |
|--------|------------|
| `jomaa-deploy/` | Repository verification, native releases, service definitions, Cloudflare routes and DNS. |
| `jomaa-home-hub/` | Matter controller hub. Runs on the home network and controls Matter and Govee devices through one interface. |
| `jomaa-home-client/` | Phone apps for the hub: Android (`android/`) and iOS (`ios/`). |
| `jomaa-static-pages/` | Static websites served through the hub's tunnel, such as Sarah's art portfolio at sarah.jomaa.org. |
| `jomaa-ssh/` | SSH into jerry from anywhere through the hub's Cloudflare tunnel (`ssh jerry`), keys only. |
| `pico-imaging-bench/` | Flash and verify the Pico health reporter over USB. |

Repo rules for people and agents are in [`AGENTS.md`](AGENTS.md).

## Checks

Run `python3 jomaa-deploy/verify.py` before pushing. It validates the deployment
manifest and runs its declared checks: hub dependencies, formatting, types,
lint, Node tests, dependency audit, and Python tests for deployment, static
sites, SSH, and the Pico imaging bench. CI runs the same script.

## Deployment

[`jomaa-deploy/deploy.json`](jomaa-deploy/deploy.json) declares services,
service hostnames, path routes, persistent state, and verification commands.
Static sites are discovered from `jomaa-static-pages/<hostname>/` directories. Verified pushes to `main` deploy through the signed HTTPS receiver
on jerry. See [`jomaa-deploy/README.md`](jomaa-deploy/README.md) for installation,
adding a site, and adding a service.

Turn on the pre-commit hook once per clone, so commits that break the hub's
format, types or lint are refused:

```bash
git config core.hooksPath .githooks
```

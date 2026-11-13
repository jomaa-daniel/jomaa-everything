# jomaa-deploy e2e

A container suite that breaks the deployment on purpose and checks what it
does. Each scenario file gets its own compose project from `compose.yaml`:

- `jerry`: the image from `Dockerfile`, systemd as PID 1, the lingering
  deployment user without sudo, the real cloudflared, and the bare repository
  that stands in for GitHub.
- `fakes`: `fakes.py`, the GitHub API (workflow runs, paginated jobs, the
  cloudflared release and asset) and the Cloudflare API (zones, DNS records),
  with faults set through `/_control`.
- `actions`: runs the real `notify.py` at the notified revision, resolves the
  webhook hostname to jerry and trusts the test CA.

`cloudflared` is the binary that the installer downloads from the fake
GitHub, checksum included. It runs the real cloudflared for ingress
validation and rules, and for `tunnel run` it is an HTTPS edge proxy that
follows the `tunnel.yml` ingress rules in order. The harness generates the
test CA and edge certificate on jerry for each run.

The fixture repository holds `jomaa-deploy/` and `jomaa-static-pages/` from the
checkout under test, with `jomaa-deploy/config.json` pointed at the fakes,
jerry and the short timeouts of [`config.json`](config.json), and the modules
in `fixture/`:

| Folder | Class | Stands in for |
| --- | --- | --- |
| `fx-alpha`, `fx-beta` | `Service` | `hub` |
| `fx-shell` | `External` | `ssh` |
| `fx-cmd` | `Command` with an inventory | `health`, `tailnet` |
| `fx-checks` | `Checks` | `pico-imaging-bench` |
| `jomaa-home-hub` | `Checks` named `hub-data` | the hub folder that `boot.py` starts the tunnel from; its `data` state holds the tunnel directory |

`fx-alpha`, `fx-beta` and `fx-cmd` run `fixture/app.py`, driven by the
`behavior.json` in their folder: `version`, `build` (`ok`, `fail`, `hang`),
`start` (`ok`, `crash`, `slow`), `health` (`ok`, `bad-json`, `500`, `hang`)
and `rollbackNeeds` (a file in the module folder the process requires at
start). `/healthz` and `/` report `version`. `fx-cmd` appends its version and
revision to `state/runs.log` and copies its inventory to
`state/inventory.json`.

Settings are in [`config.json`](config.json), documented in
[`config.md`](config.md).

## Run

Requires Docker with Compose and Python 3.12+ on the host.

```bash
python3 jomaa-deploy/e2e/harness.py install
```

`harness.py SUITE` runs `scenario_SUITE.py`. Files run in parallel; the tests
of one file share jerry and run in name order. When a test fails, the
journal, user units, the deployment directory tree and archive, processes,
compose logs and the fakes state go to `artifactDirectory/SUITE/TEST`.
`python3 -m unittest discover -s jomaa-deploy` does not run this suite: the
files are named `scenario_*.py` and the folder is not a package.

## Harness

A scenario subclasses `harness.E2ETestCase`. `self.h` is the shared
`Harness`; the fixture main is installed before the first test unless the
class sets `install = False`, and `invariants()` runs after every test.

| API | Does |
| --- | --- |
| `h.repo` | The fixture repository: `set_behavior(folder, **keys)`, `behavior`, `declaration`, `set_declaration`, `update_declaration(folder, **keys)`, `add_module(folder, template=None, **keys)`, `remove_module`, `write`, `read`, `remove`, `exists`, `commit(message)`, `head`, `show(sha, path)`, `state_paths()`. |
| `h.push(force=False, ref="main", commit="HEAD")` | Pushes to jerry's bare repository. |
| `h.fakes` | `set_run`, `set_jobs(run_id, attempt, jobs)`, `set_github_fault(endpoint, fault)`, `set_release(digest, missing_asset)`, `set_dns_fault(host, fault)`, `set_missing_zones`, `seed_records`, `clear_faults`, `reset`, `requests(since)`, `mark()`, `records()`, `control(**change)`. |
| `h.notify(sha, run_id, attempt, jobs=, run=, secret=, env=, prepare=True)` | Sets the fake run and jobs, runs `notify.py` and returns a `NotifyResult`: `code`, `output`, `status`, `modules`, `ingress`, `sha`, `run_id`, `attempt`. `h.start_notify(...)` runs it in the background. |
| `h.signed_request(...)`, `h.post_raw(body, signature, headers)`, `h.edge_request(host, path, ...)` | Requests through the edge from the actions container, tampered ones included. |
| `h.exec_as_jerry`, `h.exec_root`, `h.exec(service, ...)`, `h.systemctl_user`, `h.unit_property`, `h.unit_active`, `h.processes` | Commands on the containers. |
| `h.kill_activation(signal)`, `h.kill_receiver(signal)`, `h.restart_jerry()` | Process and machine faults. |
| `h.read`, `h.read_json`, `h.record`, `h.stored_result`, `h.read_file`, `h.write_file`, `h.remove_file`, `h.exists`, `h.listdir`, `h.resolve`, `h.deploy_path`, `h.source_path`, `h.http`, `h.version(folder)` | Files and origins on jerry. |
| `h.prepare_checkout()`, `h.install(*args)`, `h.ensure_installed()` | The checkout and the installer. |
| `h.settings`, `h.tunnel_id`, `h.dns_target`, `h.last_result`, `h.last_notify` | The fixture's deployment settings, the tunnel, and the latest activation result and notify. |
| `h.invariants()` | The oracle: records and pointers, live services and their committed versions, the site map, real cloudflared validation and rules, managed DNS records against `ingress.json`, `current`, `deploy.lock`, releases, and the printed result against the stored one. |
| `h.converge(jobs=None, force=False)` | Clears the faults, pushes the head, starts the next attempt and requires `deployed` and the oracle. |

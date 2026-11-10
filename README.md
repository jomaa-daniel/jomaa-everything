# jomaa-everything

Home projects, kept in one repo.

| Folder | What it is |
|--------|------------|
| `jomaa-home-hub/` | Matter controller hub. Runs on the home network and controls Matter and Govee devices through one interface. |
| `jomaa-home-client/` | Phone apps for the hub: Android (`android/`) and iOS (`ios/`). |
| `jomaa-static-pages/` | Static websites served through the hub's tunnel, such as Sarah's art portfolio at sarah.jomaa.org. |
| `jomaa-ssh/` | SSH into jerry from anywhere through the hub's Cloudflare tunnel (`ssh jerry`), keys only. |

## Checks

Run `python3 jomaa-home-hub/scripts/verify.py` before pushing. It installs the
hub's pinned npm dependencies, then runs Prettier, the strict TypeScript
compiler, strict typescript-eslint, the Node tests, `npm audit`, and the
Python tests. CI runs the same script.

Turn on the pre-commit hook once per clone, so commits that break the hub's
format, types or lint are refused:

```bash
git config core.hooksPath .githooks
```

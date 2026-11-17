# jomaa-home-hub audit settings

`scripts/verify.py` audits the production dependencies with `npm audit` and
reads `audit.json`. A test fails when a setting in the file is missing from
this document.

| Key                  | Type            | Meaning                                                                                  |
| -------------------- | --------------- | ---------------------------------------------------------------------------------------- |
| `level`              | string          | Lowest advisory severity that fails the audit: `low`, `moderate`, `high` or `critical`.  |
| `acceptedAdvisories` | list of strings | GitHub advisory IDs that don't fail the audit. Each one is listed below with its reason. |

## Accepted advisories

- `GHSA-fc5q-39xc-vjpf`: ReDoS in `picomatch`, which has no patched release.
  It reaches production only through `patch-package`, which Matter's optional
  Bluetooth packages (`@stoprocent/bleno`, `@stoprocent/noble`) run at install
  time with their own fixed patterns. The running hub never calls it.

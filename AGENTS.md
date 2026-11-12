# Repository rules

- Comments describe what the code does now. Don't write comments about design
  choices, alternatives, history, or why something changed.
- Docs describe the current state only. No journaling: no dated entries, change
  logs, "we decided", "previously", "upgrading from", or test diaries.
- Remove work artifacts before committing: review outputs, reports, scratch
  notes, temporary scripts, backups.
- Deploy by committing to `main` and pushing. GitHub Actions verifies the push
  and jerry's receiver activates it: services, routes, DNS, and provision steps
  such as the tailnet. Run `python3 jomaa-deploy/verify.py` first, then confirm
  the workflow's `deploy` job succeeded. Don't copy files to jerry, edit
  releases, or restart services by hand to ship a change. Only steps that need
  root on jerry, such as `jomaa-tailscale/setup_server.py`, run by hand; the
  user runs them because sudo asks for a password.
- Clean up when the work is done: delete temporary files, review artifacts,
  journals and notes, and remove temporary worktrees along with their branches,
  local and remote, once merged. Leave nothing behind but the committed change.
- No hardcoded configuration. Hostnames, URLs, ports, account and zone IDs,
  file paths, timeouts, intervals, limits, retry counts, cache lifetimes, and
  lists of sites, devices or hosts go in the component's committed config file,
  such as `jomaa-health/config.json` or `jomaa-deploy/deploy.json`. Code and
  docs read or name the setting; they don't repeat its value. A value already
  declared in a config is read from that file, never copied into another.
  Every config file has an accompanying doc, such as `jomaa-health/config.md`,
  that explains each setting, and a test fails when a setting is undocumented.
  Secrets go in `.env` files or secret stores, never in config. Not
  configuration: API and protocol contracts defined by code in this repo
  (paths, field names, status codes, messages), held in one named constant
  where they are used; page text and styling; and test fixtures.
- No backwards compatibility. The project is in development: change formats,
  APIs and stored data in one go and update every caller. No migrations,
  fallbacks for old shapes, or legacy aliases.

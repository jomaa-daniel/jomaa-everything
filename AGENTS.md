# Repository rules

- Comments describe what the code does now. Don't write comments about design
  choices, alternatives, history, or why something changed.
- Docs describe the current state only. No journaling: no dated entries, change
  logs, "we decided", "previously", "upgrading from", or test diaries.
- Remove work artifacts before committing: review outputs, reports, scratch
  notes, temporary scripts, backups.
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

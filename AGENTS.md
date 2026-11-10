# Repository rules

- Comments describe what the code does now. Don't write comments about design
  choices, alternatives, history, or why something changed.
- Docs describe the current state only. No journaling: no dated entries, change
  logs, "we decided", "previously", "upgrading from", or test diaries.
- Remove work artifacts before committing: review outputs, reports, scratch
  notes, temporary scripts, backups.
- No backwards compatibility. The project is in development: change formats,
  APIs and stored data in one go and update every caller. No migrations,
  fallbacks for old shapes, or legacy aliases.

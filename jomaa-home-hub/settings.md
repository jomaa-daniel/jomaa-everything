# jomaa-home-hub settings

The hub reads `settings.json` from its directory when it starts. A test fails
when a setting in the file is missing from this document. Per-installation
state such as the device layout (`config.json`) and secrets (`.env`) are not
settings.

## accounts

Invited accounts, their sessions, and invite links.

| Key                            | Type         | Meaning                                                                                                                   |
| ------------------------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `accounts`                     | object       | Settings for invited accounts.                                                                                            |
| `accounts.databaseFile`        | string       | SQLite file for accounts, scopes, invites, and sessions, in the same directory as the health database (`HEALTH_DB_PATH`). |
| `accounts.sessionLifetimeDays` | whole number | How long an owner or account sign-in lasts; also the session cookie's lifetime.                                           |
| `accounts.sessionsPerAccount`  | whole number | Sessions an account keeps; signing in beyond this ends its oldest session.                                                |
| `accounts.inviteLifetimeDays`  | whole number | How long an unused invite link works.                                                                                     |
| `accounts.passwordLength`      | object       | Allowed account password length.                                                                                          |
| `accounts.passwordLength.min`  | whole number | Fewest characters in an account password.                                                                                 |
| `accounts.passwordLength.max`  | whole number | Most characters in an account password.                                                                                   |

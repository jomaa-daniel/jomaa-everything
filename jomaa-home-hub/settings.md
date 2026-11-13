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
| `accounts.busyTimeoutMs`       | whole number | How long a write to the account database waits while another process, such as the Tailscale sync, is writing it.          |

## tailscale

Exit-node access for accounts at `/tailscale`. The hub runs
`jomaa-tailscale/tailnet.py` to read the tailnet and to sync its policy; that
script holds the Tailscale API token, and its own settings are in
`jomaa-tailscale/config.json`.

| Key                                  | Type         | Meaning                                                                                                                                                                                                                                  |
| ------------------------------------ | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tailscale`                          | object       | Settings for the Tailscale page and its sync.                                                                                                                                                                                            |
| `tailscale.python`                   | command      | Python interpreter that runs `tailnet.py`.                                                                                                                                                                                               |
| `tailscale.script`                   | path         | `tailnet.py`, relative to this directory. Its folder also holds `access.sql`, the tables the hub creates in the account database.                                                                                                        |
| `tailscale.commandTimeoutSeconds`    | whole number | Deadline for one `tailnet.py sync` or `observe` run. A test fails when it is shorter than the slowest run allowed by `jomaa-tailscale/config.json`: the lock wait plus four API requests, or three API requests plus two local commands. |
| `tailscale.syncIntervalSeconds`      | whole number | Time between syncs. The hub also syncs at startup and after every change.                                                                                                                                                                |
| `tailscale.observationMaxAgeSeconds` | whole number | Age after which observed users, devices and jerry's status are shown as out of date, and opening the page checks again.                                                                                                                  |
| `tailscale.downloadUrl`              | https URL    | Where the setup steps send people to install Tailscale.                                                                                                                                                                                  |
| `tailscale.adminUsersUrl`            | https URL    | The Tailscale admin console's users page, where the owner invites people.                                                                                                                                                                |

## secrets

The owner-only Secrets page at `/secrets`, which edits environment files and
reruns the deployment workflow.

| Key                           | Type         | Meaning                                                                                                                                                                             |
| ----------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `secrets`                     | object       | Settings for the Secrets page.                                                                                                                                                      |
| `secrets.envFiles`            | list         | Environment files the page can read and write, as repository paths resolved from the release root the hub runs in. Any other file is refused.                                       |
| `secrets.ghCommand`           | string       | Absolute path of the GitHub CLI on the server. The hub runs `auth token` with it on each request for the token that reruns the deployment workflow, within `github.timeoutSeconds`. |
| `secrets.deployConfig`        | string       | The deployment's settings file, resolved from the release root. The hub reads `repo`, `github.api`, `github.workflow`, `github.timeoutSeconds` and `hubPasswordMinLength` from it.  |
| `secrets.redeployPollSeconds` | whole number | How often the page asks for the status of a redeploy run.                                                                                                                           |

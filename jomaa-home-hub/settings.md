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

## prefetch

Every hub page prefetches the hub pages it links to, with their scripts and
styles, once the browser is idle. Pages whose links are followed most go first.

| Key                     | Type         | Meaning                                                                                                                    |
| ----------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `prefetch`              | object       | Settings for link prefetching.                                                                                             |
| `prefetch.databaseFile` | string       | SQLite file for how often each page's links are followed, in the same directory as the health database (`HEALTH_DB_PATH`). |
| `prefetch.concurrency`  | whole number | Prefetch requests a page keeps in flight at once.                                                                          |

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

# I²C streaming

`i2c` controls raw capture storage and the live device view. Capture rows share the health database and its retention period.

| Setting                     | Meaning                                                                                                                       |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `i2c.maxDataBytes`          | Maximum decoded raw bytes accepted in one capture.                                                                            |
| `i2c.maxRequestBytes`       | Maximum JSON request size for a capture, including hexadecimal data and metadata.                                             |
| `i2c.historyLimit`          | Default and maximum number of capture records in a history request.                                                           |
| `i2c.liveRows`              | Maximum recent capture records sent when a live view connects, retained by that view, and queued while its connection drains. |
| `i2c.keepaliveSeconds`      | Interval between live connection keepalives and session access checks.                                                        |
| `i2c.reconnectMilliseconds` | Delay before a disconnected live view reconnects.                                                                             |
| `i2c.maxLiveClients`        | Maximum simultaneous live capture viewers on the hub.                                                                         |

## Health view

`health` controls device status and logs in Devices and Details.

| Setting                 | Meaning                                                        |
| ----------------------- | -------------------------------------------------------------- |
| `health.refreshSeconds` | Interval between inventory refreshes while Devices is visible. |
| `health.historyLimit`   | Number of health reports requested per history page.           |

`health.discoveryRefreshSeconds` is the interval between Matter discovery requests while the discovery dialog is open.

`health.goveeStatusCacheSeconds` is how long read-only Govee connection results are shared between inventory refreshes.

`health.goveeStatusConcurrency` limits simultaneous Govee connection requests.

`health.goveeStatusTimeoutSeconds` is the shared deadline for the cloud checks in one inventory refresh. Failed checks show unknown status.

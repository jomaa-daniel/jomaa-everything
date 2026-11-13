# jomaa-deploy e2e configuration

`config.json` holds the settings of the container suite. A test in
`jomaa-deploy/test_config.py` fails when one of its keys is missing from this
document. Values that `jomaa-deploy/config.json` already declares, such as the
cloudflared version and repository, the GitHub download base and the timeouts
of the deployment itself, are read from that file.

| Key | Type | Meaning |
| --- | --- | --- |
| `project` | string | Prefix of each compose project name; the suite and a random suffix follow, so scenario files run in parallel. |
| `artifactDirectory` | path | Repository-relative folder that receives the journals, deployment directory, compose logs and fakes state of each failed test, one subfolder per suite and test. |
| `image` | object | Container images. |
| `image.tag` | image name | Tag of the jerry image that the harness builds from `Dockerfile`. |
| `image.base` | image name | Base image of jerry: jerry's distribution and release. Its `python3` is the Python that deployment runs with. |
| `image.nodeVersion` | version | Node.js version installed on jerry; the installer requires 22.13 or newer. |
| `image.nodeDist` | URL | Base URL of the Node.js release tarballs. |
| `image.python` | image name | Image of the `fakes` and `actions` containers. |
| `jerry` | object | The jerry container. |
| `jerry.user` | user name | Deployment user, lingering and without sudo. |
| `jerry.uid` | number | User id of the deployment user; its runtime directory is `/run/user/<uid>`. |
| `jerry.home` | path | Home directory of the deployment user; `~/` in the deployment settings expands to it. |
| `jerry.checkout` | path | The deployment user's checkout of the fixture repository, the installer's source. |
| `jerry.gitRoot` | path | Folder of the bare repositories that stand in for GitHub, `<gitRoot>/OWNER/REPOSITORY.git`. It becomes the fixture's `github.remote`. |
| `jerry.cloudflared` | path | The real cloudflared binary, outside the checkout. The wrapper runs it for every command except `tunnel run`. |
| `jerry.edgeDirectory` | path | Folder of the edge certificate, its key, the test CA certificate and the edge settings file that the wrapper reads. |
| `edge` | object | The HTTPS edge proxy that the wrapper runs for `tunnel run`. |
| `edge.port` | port | Port the edge listens on. With a port other than 443, `notify.py` gets `JOMAA_DEPLOY_URL`. |
| `edge.originTimeoutSeconds` | seconds | How long the edge waits for an origin before it answers 524, and for a client's TLS handshake. |
| `edge.certificateDays` | days | Validity of the test CA and edge certificate generated for each run. |
| `actions` | object | The container that runs `notify.py` like the workflow's `deploy` job. |
| `actions.caFile` | path | The test CA certificate in the actions container, named by `SSL_CERT_FILE`. |
| `actions.checkouts` | path | Folder of the revisions checked out for `notify.py`, one subfolder per commit. |
| `fakes` | object | The fake GitHub and Cloudflare APIs. |
| `fakes.port` | port | Port of the fakes server; the harness reaches `/_control` through a published loopback port. |
| `fakes.githubHost` | hostname | Network alias of the fake GitHub API; it becomes the fixture's `github.api`. |
| `fakes.cloudflareHost` | hostname | Network alias of the fake Cloudflare API; with `fakes.cloudflarePath` it becomes the fixture's `cloudflare.api`. |
| `fakes.cloudflarePath` | path | Path prefix of the Cloudflare API on the fakes server. |
| `fakes.hangSeconds` | seconds | How long a request with a `hang` fault is held when the fault is not cleared. |
| `fixture` | object | The fixture repository pushed to jerry. |
| `fixture.repo` | `OWNER/REPOSITORY` | Repository name of the fixture: the bare repository on jerry and `GITHUB_REPOSITORY`. |
| `fixture.webhookHostname` | hostname | The fixture's `webhook.hostname`, a network alias of jerry; the edge certificate covers it and its parent domain. |
| `fixture.copy` | folders | Folders copied from the checkout under test into the fixture repository, without `jomaa-deploy/e2e`. |
| `fixture.settings` | object | Values merged into the fixture's copy of `jomaa-deploy/config.json`; each key means what `jomaa-deploy/config.md` describes. |
| `fixture.settings.commandTimeoutSeconds` | seconds | Fixture deadline of each build, systemctl and module command. |
| `fixture.settings.gitTimeoutSeconds` | seconds | Fixture deadline of each git command. |
| `fixture.settings.moduleTimeoutSeconds` | seconds | Fixture time budget of one module. |
| `fixture.settings.healthWaitSeconds` | seconds | Fixture wait for a restarted service's health check; a fixture service with `start: slow` starts after half of it. |
| `fixture.settings.healthRequestTimeoutSeconds` | seconds | Fixture deadline of each health check request. |
| `fixture.settings.tunnel` | object | Fixture tunnel settings. |
| `fixture.settings.tunnel.downloadTimeoutSeconds` | seconds | Fixture deadline of the cloudflared download from the fake GitHub. |
| `fixture.settings.tunnel.validateTimeoutSeconds` | seconds | Fixture deadline of each cloudflared ingress command; the oracle uses it too. |
| `fixture.settings.cloudflare` | object | Fixture Cloudflare settings. |
| `fixture.settings.cloudflare.timeoutSeconds` | seconds | Fixture deadline of each request to the fake Cloudflare API. |
| `fixture.settings.github` | object | Fixture GitHub settings. |
| `fixture.settings.github.timeoutSeconds` | seconds | Fixture deadline of each request to the fake GitHub API. |
| `fixture.settings.github.jobsPerPage` | count | Fixture page size of the jobs listing, small enough that a run's jobs span several pages. |
| `fixture.settings.notify` | object | Fixture retries of `notify.py`. |
| `fixture.settings.notify.deadlineSeconds` | seconds | How long the fixture's `notify.py` retries. |
| `fixture.settings.notify.requestTimeoutSeconds` | seconds | Deadline of each fixture deployment request; longer than `edge.originTimeoutSeconds`, so a slow activation answers 524 and is retried. |
| `fixture.settings.notify.retryDelaySeconds` | seconds | Pause between the fixture's attempts. |
| `timeouts` | object | Deadlines of the harness itself. |
| `timeouts.buildSeconds` | seconds | Deadline of building the jerry image and starting the project. |
| `timeouts.bootSeconds` | seconds | How long jerry's systemd, the user manager, the fakes and a restarted unit may take to come up. |
| `timeouts.execSeconds` | seconds | Default deadline of each command the harness runs. |
| `timeouts.notifyMarginSeconds` | seconds | Time added to the fixture's notify deadline and request timeout before the harness stops waiting for `notify.py`. |
| `timeouts.httpSeconds` | seconds | Deadline of the harness's own HTTP requests: `/_control`, origins and sites. |
| `timeouts.pollSeconds` | seconds | Pause between checks while the harness waits for a condition. |

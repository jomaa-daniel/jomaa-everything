# Camera monitoring

[Frigate](https://github.com/blakeblackshear/frigate) is the MIT-licensed camera
monitoring platform. It detects motion and tracked objects, retains recordings,
and saves snapshots. The Cameras page combines these features with MediaMTX live
video and Video.js playback. Motion activity is independent of object labels.

The monitoring service uses the official container pinned by digest. Its API is
published only on loopback, with no public routes. The hub exposes read-only
history, recording clips, and snapshots behind the Cameras capability. Every
request uses the account's assigned camera node and current grant. The hub does
not expose Frigate's configuration, administrative APIs, restreaming ports, or UI.

The camera list and source credentials come from the existing camera component.
Accounts do not select a home on this page. Grant Cameras on the desired node in
account management. A camera node's module allowlist must include hub, cameras,
and frigate. A lights-only node continues to reject camera traffic.

Before enabling configured cameras, install a compatible OCI runtime on the
camera host and allow the deployment user to run it. The `container.command`
setting selects Docker or Podman. Rootless Docker and Podman avoid granting the
deployment user access to a root daemon. Host package installation and any
accelerator permissions require the user's root setup; repository deployment
does not install host packages. See the upstream
[installation guide](https://docs.frigate.video/frigate/installation/).

Set the camera component's `sourceEnv` variables privately in Secrets and deploy
through the normal signed workflow. Both services connect to the source; the
camera must allow simultaneous readers. Missing sources produce an unconfigured
state and do not launch a container. Disabled monitoring leaves live video available.

The starter detector uses the CPU at the configured detection resolution and
frame rate. CPU detection can be slow on small hosts. Set `engine.detectors`,
`engine.model`, and `container.devices` for a supported accelerator or OpenVINO
CPU backend; the
[detector guide](https://docs.frigate.video/configuration/object_detectors/)
describes native settings. Camera motion masks, zones, and filters are native
overrides under `cameras[].monitoring.config`; they require no hub code changes.

Retention, resource limits, private addresses, and history limits are documented
in [config.md](config.md). Recordings and the database live in the module's
persistent state directory, outside release cleanup. Retention is time based;
choose it for the available storage. The hub returns bounded clips and honors
byte-range requests for seeking. Find older footage by its local start time;
footage outside retention is unavailable.

The deployment service prepares the image when sources are configured, starts
the container, and verifies its API readiness. Deployment rollback restores the
service code and configuration; the stored footage stays in persistent state.
Runtime logs are suppressed because camera failures can include source credentials.

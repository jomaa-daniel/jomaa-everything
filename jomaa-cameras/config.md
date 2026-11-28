# Camera configuration

`config.json` configures the MediaMTX service, local Video.js assets and the
camera inventory. The hub reads this file through `cameraConfigFile` in its
settings. The service reads the hub environment from the deployment's
`cloudflare.env` setting. Camera source credentials never appear in browser
URLs or inventory responses.

| Setting | Meaning |
| --- | --- |
| `downloadTimeoutSeconds` | Deadline for each verified software download. |
| `mediaMtx` | Pinned streaming server distribution. |
| `mediaMtx.repository` | GitHub repository publishing the server. |
| `mediaMtx.version` | Release tag used for downloads. |
| `mediaMtx.binaryFile` | Repository-relative generated executable path. |
| `mediaMtx.runtimeConfigFile` | Generated private runtime configuration path; permissions restrict it to the service user. |
| `mediaMtx.checksums` | SHA-256 archive digest by platform. |
| `mediaMtx.checksums.linux_amd64` | Linux x86-64 archive digest. |
| `mediaMtx.checksums.linux_arm64` | Linux ARM64 archive digest. |
| `mediaMtx.checksums.darwin_arm64` | Apple Silicon archive digest for verification. |
| `player` | Pinned browser player distribution. |
| `player.name` | Upstream player name. |
| `player.version` | Upstream player version. |
| `player.assets` | Locally served browser assets. |
| `player.assets[].url` | Official distribution URL; browsers load the downloaded local copy. |
| `player.assets[].sha256` | Expected asset digest. |
| `player.assets[].file` | Repository-relative generated asset path. |
| `server` | Native MediaMTX configuration, documented upstream. |
| `server.logLevel` | MediaMTX logging threshold. |
| `server.rtsp` | Enables the inbound RTSP server; source pulling is independent. |
| `server.rtmp` | Enables inbound RTMP. |
| `server.srt` | Enables inbound SRT. |
| `server.webrtc` | Enables the WebRTC server. |
| `server.api` | Enables the MediaMTX management API. |
| `server.playback` | Enables recorded-media playback. |
| `server.metrics` | Enables the service's health endpoint; must remain enabled. Its address is read from `deploy.json.origin`. |
| `server.hls` | Enables HLS delivery; must remain enabled. |
| `server.hlsAddress` | Private HLS listener address. Bind it to loopback; the hub proxies authenticated requests. |
| `server.hlsVariant` | HLS muxing format. |
| `server.hlsSegmentCount` | Segments retained for playback. |
| `server.hlsSegmentDuration` | Requested segment duration; actual duration follows camera keyframes. |
| `server.hlsPartDuration` | Requested low-latency part duration. |
| `server.hlsSegmentMaxSize` | Maximum size of a muxed segment. |
| `server.hlsMuxerCloseAfter` | Idle time before an HLS muxer closes. |
| `server.authInternalUsers` | Internal MediaMTX access rules for its private listeners. |
| `server.authInternalUsers[].user` | Internal user selector. |
| `server.authInternalUsers[].permissions` | Native allowed operations. |
| `server.authInternalUsers[].permissions[].action` | Native operation name. |
| `server.pathDefaults` | Defaults applied to configured camera paths. |
| `server.pathDefaults.sourceOnDemand` | Pulls a source only while it has viewers. |
| `server.pathDefaults.sourceOnDemandStartTimeout` | Maximum time to wait for a source to start. |
| `server.pathDefaults.sourceOnDemandCloseAfter` | Delay before disconnecting an unused source. |
| `playback` | Hub and browser playback behavior. |
| `playback.refreshSeconds` | Inventory and permission refresh interval. |
| `playback.requestTimeoutSeconds` | Deadline for each HLS request, including blocking playlist reads. |
| `playback.autoplay` | Starts configured feeds automatically when browser policy permits. |
| `playback.muted` | Initial audio mute state. |
| `cameras` | Camera slots; the page renders the configured list. |
| `cameras[].id` | Unique MediaMTX path and hub API identifier. |
| `cameras[].name` | Display name. |
| `cameras[].sourceEnv` | Private environment key containing the source URL. Missing sources appear as not configured and are not opened. |

Use the environment keys named by `cameras[].sourceEnv` for RTSP camera URLs,
including credentials when required. Sources are passed to MediaMTX as process
environment overrides; the generated configuration contains no source credentials.
Set these through the owner Secrets
page or the secret environment store, then redeploy. Use H.264 video and
browser-compatible audio such as AAC. MediaMTX remuxes streams and does not
transcode incompatible camera codecs.

The browser loads `/api/cameras/{id}/hls/index.m3u8` and its relative media
files through the hub. Every request requires the Cameras capability. The
account's node assignment is controlled by the shared catalog's routing
policy. Lights-only accounts and nodes cannot access camera media.

`cameras[].monitoring` configures monitoring for this camera.
`cameras[].monitoring.enabled` allows Frigate to read the same source.
`cameras[].monitoring.config` contains native Frigate camera overrides, including
motion masks, object filters, zones, detection settings, and FFmpeg input arguments.
FFmpeg inputs are generated from `sourceEnv`; overrides cannot supply inputs.
Document each added native setting here. The monitoring service settings live in
[the Frigate configuration](../jomaa-frigate/config.md).

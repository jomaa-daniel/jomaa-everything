# Cameras

[MediaMTX](https://github.com/bluenviron/mediamtx) pulls camera streams and
serves low-latency HLS. [Video.js](https://videojs.com/) supplies the browser
player, controls and native/MSE HLS support. Both projects use the MIT license.
Their pinned distributions are downloaded from official sources and verified
against the digests in [config.json](config.json).

The hub's Cameras page shows the camera slots together, side by side on wide
screens and stacked on phones. Accounts need the Cameras permission; the
hub authenticates inventory, playlists and segments. Camera credentials and
local source addresses stay in the service's private environment. MediaMTX has no public tunnel routes.

Settings and source setup are documented in [config.md](config.md). Each
installation runs its own service and camera sources. For a separate camera
node, include the hub and cameras modules in its module allowlist and grant
that node's Cameras capability.

The deployment module installs MediaMTX and runs it as a systemd user service.
The hub build installs Video.js locally. A hub environment change affects both
modules' fingerprints, so source changes take effect through the normal signed
deployment workflow.

[Frigate](../jomaa-frigate/README.md) supplies motion and object detection,
retained recordings and snapshots on the same Cameras page. The services share
this component’s camera definitions and private source environment.

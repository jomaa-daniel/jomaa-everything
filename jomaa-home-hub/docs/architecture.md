# Hub architecture

The hub controls Matter devices and Govee lights through one HTTP API. It runs
at home, because Matter only works on the local network.

- **Languages.** The hub is TypeScript. Setup, deployment and control scripts
  are Python.
- **Matter.** The hub runs the Open Home Foundation Matter controller
  (`@matter-server/ws-controller`) in its own process and calls it directly.
  The controller keeps a live copy of each node's attributes, so reading state
  costs nothing.
- **Network.** The hub uses host networking and listens on localhost; only the
  Cloudflare tunnel exposes it.
- **Devices and rooms.** Every device implements one `Device` interface, and so
  do rooms. A room sends each command to all members at once; a failing bulb
  doesn't block the others, and failures are reported per device. Rooms can
  contain rooms.
- **Sync.** Sync checks every bulb and corrects only the fields that drifted.
  Levels are never corrected when the room should be off, so a sync can't
  relight a lamp.
- **Desired state.** The client owns the desired state. The hub tracks only the
  newest revision per client; a newer command from that client makes an older
  sync stand down.
- **Features.** Devices report what they can change. A Matter plug has no
  brightness, so brightness commands skip it and sync doesn't try to fix it.
- **Layout.** Devices and rooms are listed in `config.json`. Pairing a device
  doesn't add it to a room.
- **Login.** One shared password is exchanged for a token derived from it. The
  cookie and the phone apps store the token, not the password.
- **Updates.** Clients poll state; the hub doesn't push.
- **Govee.** The hub uses Govee's cloud API.

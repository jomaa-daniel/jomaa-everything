# jomaa-home-client

Phone apps for jomaa-home-hub. They only talk to the hub, so every device
looks the same to them, whether it's a Matter bulb or a Govee lamp the hub
controls through Govee's cloud.

- `android/`: Kotlin and Jetpack Compose, with a home-screen widget
- `ios/`: SwiftUI, with home-screen widgets, Shortcuts and a Control Center toggle

Both apps:

- sign in with the hub password and stay signed in
- list the hub's rooms and devices, and show only the controls the selected
  one supports (a Matter plug gets a power button and nothing else)
- send each change to the hub, roll it back if a device fails, and re-check a
  few seconds later that every light actually changed
- pair new Matter devices through the hub, using the setup code or the
  `MT:` text from the QR label

## Test

```bash
python3 scripts/verify.py              # Android unit tests, strict lint, builds
python3 scripts/verify.py --emulator   # plus Android emulator tests
```

`scripts/test_hub.py` runs the real hub against a fake Govee cloud, so you
can try the apps without real lights. The iOS UI tests need it running.

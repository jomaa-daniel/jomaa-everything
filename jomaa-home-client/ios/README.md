# iOS app

SwiftUI, iOS 17 and later. The Xcode project is generated from `project.yml`:

```bash
brew install xcodegen
xcodegen generate
open DevicePanel.xcodeproj
```

Pick a Development Team for the app and the widget before running on a
phone. The app group and Keychain group in `project.yml` must also exist in
your Apple Developer account.

The app connects to **https://hub.jomaa.org**. `jomaa.org/home` serves the
landing page; the hub API is on `hub.jomaa.org`. The address comes from
`DEVICE_PANEL_HUB_HOST` in `Configs/Shared.xcconfig`, expanded into
`DevicePanelHubURL` in both the app and widget's Info.plist by `project.yml`.
Changing the host requires a new build. Sessions saved for another origin
are discarded and require a fresh sign-in.

Sign in with the hub password. There is no default password: the deployed
hub reads `HUB_PASSWORD` from Jerry's private
`/home/jerry/jomaa-everything/jomaa-home-hub/.env`. Deployment releases use
that same file. GitHub's `HUB_DEPLOY_SECRET` authenticates deployments and is
separate from the login password. The app stores only the returned session
token in Keychain, never the password.

## What's in it

- Every room and device the hub knows, with power, red and orange, brightness
  presets and white temperature. Controls a device can't use are hidden.
- Changes show at once and roll back if the hub says they failed, naming the
  devices that didn't respond. A few seconds later the app asks the hub to
  check each bulb and fix any that missed the command.
- Pairing Matter devices with a setup code.
- Home-screen widgets, Shortcuts and Siri, and an iOS 18 Control Center
  toggle. They act on the room the app last showed.

## Test

The UI tests run against a local instance of the hub and a fake Govee cloud. Start them in
another terminal first:

```bash
python3 ../scripts/test_hub.py
```

Then, with a simulator:

```bash
xcodebuild test -project DevicePanel.xcodeproj -scheme DevicePanel \
  -destination 'platform=iOS Simulator,name=iPhone 17' CODE_SIGNING_ALLOWED=NO
```

Add `-only-testing:DevicePanelCoreTests` to run just the core tests, which
don't need the hub.

Debug UI-test launches use the fixed origin `http://127.0.0.1:8797` with
`-ui-testing-reset`, in-memory sessions and a loopback-only HTTP client.
Release builds ignore that test argument and use the configured HTTPS hub.

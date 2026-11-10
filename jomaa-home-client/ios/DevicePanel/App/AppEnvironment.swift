import DevicePanelCore
import Foundation

@MainActor
enum AppEnvironment {
    static func makeRoomController() -> RoomController {
        let accessGroup = Bundle.main.object(
            forInfoDictionaryKey: "DevicePanelKeychainAccessGroup"
        ) as? String

        // UI tests run against a hub on this machine; see DevicePanelUITests.
        // Their builds are unsigned, so they have no Keychain group to share
        // with the widget; each test signs in afresh anyway.
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-ui-testing-reset") {
            return RoomController(
                configuredHub: try! ServerConfiguration(urlString: "http://127.0.0.1:8797"),
                api: HTTPDevicePanelAPI(allowedHosts: ["127.0.0.1", "localhost", "::1"]),
                sessionStore: InMemorySessionStore(),
                preferences: SharedPreferences(),
                reconcileDelays: [.milliseconds(50), .milliseconds(100)],
                resetPersistentStateOnStart: true
            )
        }
        #endif

        let configuration: ServerConfiguration
        do {
            configuration = try .bundled()
        } catch {
            preconditionFailure("DevicePanelHubURL must contain a valid hub origin in the app configuration.")
        }

        return RoomController(
            configuredHub: configuration,
            api: HTTPDevicePanelAPI(allowedHosts: [configuration.baseURL.host!]),
            sessionStore: KeychainSessionStore(accessGroup: accessGroup),
            preferences: SharedPreferences()
        )
    }
}

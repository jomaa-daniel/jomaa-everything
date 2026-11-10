import Foundation

/// Sends commands to the last room or device the app showed, for widgets and
/// Shortcuts.
public actor IntentCommandService {
    private let configuration: ServerConfiguration
    private let api: any DevicePanelAPI
    private let sessionStore: any SessionStoring
    private let preferences: SharedPreferences

    public init(
        configuration: ServerConfiguration,
        api: any DevicePanelAPI,
        sessionStore: any SessionStoring,
        preferences: SharedPreferences
    ) {
        self.configuration = configuration
        self.api = api
        self.sessionStore = sessionStore
        self.preferences = preferences
    }

    public func apply(_ changes: RoomChanges) async throws -> CachedTarget {
        let (configuration, session) = try await credentials()
        guard let target = await preferences.selectedTarget() else {
            throw DevicePanelError.noTargetSelected
        }

        let currentState: RoomState
        if let cached = target.state {
            currentState = cached
        } else {
            currentState = try await fetch(target, configuration: configuration, session: session)
        }

        let command = HubCommand(
            changes: changes,
            clientId: await preferences.clientID(),
            revision: await preferences.nextRevision()
        )
        try await api.send(baseURL: configuration.baseURL, token: session.token, targetID: target.id, command: command)

        let updated = target.with(state: try currentState.applying(changes, observedAt: Date()))
        await preferences.saveSelectedTarget(updated)
        return updated
    }

    public func currentState() async throws -> RoomState {
        let (configuration, session) = try await credentials()
        guard let target = await preferences.selectedTarget() else {
            throw DevicePanelError.noTargetSelected
        }
        let state = try await fetch(target, configuration: configuration, session: session)
        await preferences.saveSelectedTarget(target.with(state: state))
        return state
    }

    private func credentials() async throws -> (ServerConfiguration, Session) {
        guard
            try await preferences.serverConfiguration() == configuration,
            let session = try await sessionStore.load()
        else {
            throw DevicePanelError.authenticationRequired
        }
        return (configuration, session)
    }

    private func fetch(_ target: CachedTarget, configuration: ServerConfiguration, session: Session) async throws -> RoomState {
        let response = try await api.state(baseURL: configuration.baseURL, token: session.token, targetID: target.id)
        guard let light = response.state else {
            throw DevicePanelError.devicesFailed(response.failed)
        }
        return RoomState(light: light, colorMode: target.state?.colorMode ?? .unknown)
    }
}

#if canImport(Security)
enum IntentEnvironment {
    static func commandService() throws -> IntentCommandService {
        let accessGroup = Bundle.main.object(
            forInfoDictionaryKey: "DevicePanelKeychainAccessGroup"
        ) as? String
        let configuration = try ServerConfiguration.bundled()
        return IntentCommandService(
            configuration: configuration,
            api: HTTPDevicePanelAPI(allowedHosts: [configuration.baseURL.host!]),
            sessionStore: KeychainSessionStore(accessGroup: accessGroup),
            preferences: SharedPreferences()
        )
    }
}
#endif

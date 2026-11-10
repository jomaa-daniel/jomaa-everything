import Combine
import Foundation

public enum AuthenticationPhase: Equatable, Sendable {
    case checking
    case signingIn
    case signedOut
    case signedIn(serverLabel: String)
}

public enum ConnectionPhase: Equatable, Sendable {
    case idle
    case loading
    case connected
    case applying
    case stale
    case failed(String)

    public var label: String {
        switch self {
        case .idle: "Not connected"
        case .loading: "Loading"
        case .connected: "Connected"
        case .applying: "Applying"
        case .stale: "Last known state"
        case .failed: "Command failed"
        }
    }
}

public struct MatterPairingState: Equatable, Sendable {
    public var nodes: [MatterNode] = []
    public var isLoading = false
    public var isPairing = false
    public var pairedNodeID: UInt64?
    public var error: String?

    public init() {}
}

@MainActor
public final class RoomController: ObservableObject {
    @Published public private(set) var authentication: AuthenticationPhase = .checking
    @Published public private(set) var connection: ConnectionPhase = .idle
    @Published public private(set) var targets: [Target] = []
    @Published public private(set) var selectedTarget: CachedTarget?
    @Published public private(set) var roomState: RoomState?
    @Published public private(set) var isPowerCommandInFlight = false
    @Published public private(set) var lastError: String?
    @Published public private(set) var matter = MatterPairingState()

    private let configuredHub: ServerConfiguration
    private let api: any DevicePanelAPI
    private let sessionStore: any SessionStoring
    private let preferences: SharedPreferences
    private let reconcileDelays: [Duration]
    private let resetPersistentStateOnStart: Bool

    private var configuration: ServerConfiguration?
    private var session: Session?
    private var confirmedState: RoomState?
    private var latestRevision: Int64 = 0
    private var fieldRevisions: [RoomField: Int64] = [:]
    private var loadGeneration = 0
    private var reconcileTask: Task<Void, Never>?
    private var lastFailedChanges: RoomChanges?

    public init(
        configuredHub: ServerConfiguration,
        api: any DevicePanelAPI,
        sessionStore: any SessionStoring,
        preferences: SharedPreferences,
        reconcileDelays: [Duration] = [.seconds(3), .seconds(6), .seconds(10), .seconds(15)],
        resetPersistentStateOnStart: Bool = false
    ) {
        self.configuredHub = configuredHub
        self.api = api
        self.sessionStore = sessionStore
        self.preferences = preferences
        self.reconcileDelays = reconcileDelays
        self.resetPersistentStateOnStart = resetPersistentStateOnStart
    }

    public var serverURLString: String {
        configuredHub.baseURL.absoluteString
    }

    public var canRetryLastCommand: Bool {
        lastFailedChanges != nil
    }

    /// What the selected room or device can change.
    public var features: Features {
        selectedTarget?.features ?? Features()
    }

    public var targetName: String {
        selectedTarget?.name ?? "Device Panel"
    }

    public func start() async {
        if resetPersistentStateOnStart {
            try? await sessionStore.clear()
            await preferences.reset()
        }
        do {
            let savedConfiguration = try await preferences.serverConfiguration()
            // A stored origin only binds a session to its hub; it cannot override configuration.
            guard savedConfiguration == configuredHub else {
                try await sessionStore.clear()
                await preferences.reset()
                clearTarget()
                authentication = .signedOut
                return
            }
            if let cached = await preferences.selectedTarget() {
                selectedTarget = cached
                if let state = cached.state {
                    roomState = state
                    confirmedState = state
                    connection = .stale
                }
            }
            latestRevision = await preferences.currentRevision()
            guard let session = try await sessionStore.load() else {
                authentication = .signedOut
                return
            }
            self.configuration = configuredHub
            self.session = session
            authentication = .signedIn(serverLabel: configuredHub.label)
            await refresh()
        } catch {
            try? await sessionStore.clear()
            await preferences.reset()
            clearTarget()
            authentication = .signedOut
            present(error)
        }
    }

    public func signIn(password: String) async {
        guard authentication != .signingIn else { return }
        authentication = .signingIn
        lastError = nil

        do {
            let configuration = configuredHub
            let session = try await api.signIn(baseURL: configuration.baseURL, password: password)
            try await sessionStore.save(session)
            // Another hub has other devices, so forget the cached one.
            let previous = try? await preferences.serverConfiguration()
            if previous != configuration {
                await preferences.clearSelectedTarget()
                clearTarget()
            }
            await preferences.saveServerConfiguration(configuration)
            self.configuration = configuration
            self.session = session
            authentication = .signedIn(serverLabel: configuration.label)
            await refresh()
        } catch {
            authentication = .signedOut
            present(error)
        }
    }

    public func signOut() async {
        reconcileTask?.cancel()
        if let configuration, let session {
            try? await api.signOut(baseURL: configuration.baseURL, token: session.token)
        }
        try? await sessionStore.clear()
        await preferences.clearSelectedTarget()
        configuration = nil
        session = nil
        targets = []
        clearTarget()
        matter = MatterPairingState()
        lastError = nil
        connection = .idle
        authentication = .signedOut
    }

    /// Reloads the device list and the selected target's state.
    public func refresh() async {
        guard let configuration, let session else { return }
        let refreshRevision = latestRevision
        connection = roomState == nil ? .loading : .applying
        lastError = nil

        do {
            let targets = try await api.targets(baseURL: configuration.baseURL, token: session.token)
            self.targets = targets
            let current = selectedTarget?.id
            guard
                let chosen = targets.first(where: { $0.id == current })
                ?? targets.first(where: \.isRoom)
                ?? targets.first
            else {
                await preferences.clearSelectedTarget()
                clearTarget()
                connection = .connected
                return
            }
            try await load(chosen, configuration: configuration, session: session, refreshRevision: refreshRevision)
        } catch {
            await handle(error)
        }
    }

    /// Shows another room or device.
    public func select(_ targetID: String) async {
        guard
            let configuration,
            let session,
            targetID != selectedTarget?.id,
            let target = targets.first(where: { $0.id == targetID })
        else { return }
        clearTarget()
        selectedTarget = CachedTarget(target: target, state: nil)
        connection = .loading
        lastError = nil
        do {
            try await load(target, configuration: configuration, session: session, refreshRevision: latestRevision)
        } catch {
            await handle(error)
        }
    }

    public func setPower(_ isOn: Bool) async {
        guard !isPowerCommandInFlight else { return }
        isPowerCommandInFlight = true
        defer { isPowerCommandInFlight = false }
        do {
            try await apply(RoomChanges(on: isOn))
        } catch {
            await handle(error)
        }
    }

    public func setBrightness(_ brightness: Int) async {
        do {
            try await apply(RoomChanges(brightness: brightness))
        } catch {
            await handle(error)
        }
    }

    public func setColor(_ color: RoomColor) async {
        do {
            try await apply(RoomChanges(color: color))
        } catch {
            await handle(error)
        }
    }

    public func setColorTemperature(_ percentage: Int) async {
        do {
            try await apply(RoomChanges(colorTemperaturePct: percentage))
        } catch {
            await handle(error)
        }
    }

    public func retryLastCommand() async {
        guard let changes = lastFailedChanges else { return }
        do {
            try await apply(changes)
        } catch {
            await handle(error)
        }
    }

    public func clearError() {
        lastError = nil
        if case .failed = connection {
            connection = roomState == nil ? .idle : .stale
        }
    }

    // MARK: - Matter

    public func loadMatterNodes() async {
        guard let configuration, let session else { return }
        matter.isLoading = true
        matter.error = nil
        do {
            matter.nodes = try await api.matterNodes(baseURL: configuration.baseURL, token: session.token)
            matter.isLoading = false
        } catch {
            matter.isLoading = false
            matter.error = message(for: error)
            if error as? DevicePanelError == .authenticationRequired {
                await handle(error)
            }
        }
    }

    /// Pairs a Matter device through the hub, using its QR payload or manual code.
    public func pair(code: String, networkOnly: Bool) async {
        guard let configuration, let session, !matter.isPairing else { return }
        guard let normalized = MatterSetupCode.normalize(code) else {
            matter.error = "Enter the 11-digit setup code or the MT: code from the QR label."
            return
        }
        matter.isPairing = true
        matter.pairedNodeID = nil
        matter.error = nil
        do {
            let nodeID = try await api.commission(
                baseURL: configuration.baseURL,
                token: session.token,
                code: normalized,
                networkOnly: networkOnly
            )
            matter.isPairing = false
            matter.pairedNodeID = nodeID
            await loadMatterNodes()
        } catch {
            matter.isPairing = false
            matter.error = message(for: error)
            if error as? DevicePanelError == .authenticationRequired {
                await handle(error)
            }
        }
    }

    public func clearPairingResult() {
        matter.pairedNodeID = nil
        matter.error = nil
    }

    // MARK: - Commands

    private func load(
        _ target: Target,
        configuration: ServerConfiguration,
        session: Session,
        refreshRevision: Int64
    ) async throws {
        loadGeneration += 1
        let generation = loadGeneration
        let response = try await api.state(baseURL: configuration.baseURL, token: session.token, targetID: target.id)
        // A newer load, or a command sent meanwhile, wins.
        guard generation == loadGeneration, refreshRevision == latestRevision, fieldRevisions.isEmpty else { return }
        guard let light = response.state else {
            throw DevicePanelError.devicesFailed(response.failed)
        }
        // The hub doesn't report color, so keep the one picked here.
        let colorMode = target.id == selectedTarget?.id ? roomState?.colorMode ?? .unknown : .unknown
        let state = RoomState(light: light, colorMode: colorMode)
        let cached = CachedTarget(target: target, state: state)
        selectedTarget = cached
        roomState = state
        confirmedState = state
        await preferences.saveSelectedTarget(cached)
        if response.failed.isEmpty {
            connection = .connected
        } else {
            let message = DevicePanelError.devicesFailed(response.failed).errorDescription
            lastError = message
            connection = .stale
        }
    }

    private func apply(_ changes: RoomChanges) async throws {
        guard let configuration, let session else {
            throw DevicePanelError.authenticationRequired
        }
        guard let target = selectedTarget, let currentState = roomState else {
            throw DevicePanelError.noTargetSelected
        }

        let revision = await preferences.nextRevision()
        latestRevision = revision
        for field in changes.affectedFields {
            fieldRevisions[field] = revision
        }

        roomState = try currentState.applying(changes)
        connection = .applying
        lastError = nil
        lastFailedChanges = nil

        do {
            let command = HubCommand(changes: changes, clientId: await preferences.clientID(), revision: revision)
            try await api.send(baseURL: configuration.baseURL, token: session.token, targetID: target.id, command: command)
            // The user moved on to another target while this was in flight.
            guard selectedTarget?.id == target.id else { return }

            let baseConfirmed = confirmedState ?? currentState
            let commandConfirmed = try baseConfirmed.applying(changes, observedAt: Date())
            confirmedState = try baseConfirmed.merging(changes.affectedFields, from: commandConfirmed)

            for field in changes.affectedFields where fieldRevisions[field] == revision {
                fieldRevisions.removeValue(forKey: field)
            }
            if fieldRevisions.isEmpty {
                connection = .connected
            }
            if let state = roomState {
                await preferences.saveSelectedTarget(target.with(state: state))
            }
            if revision == latestRevision {
                startReconciliation(targetID: target.id, features: target.features, revision: revision)
            }
        } catch {
            guard selectedTarget?.id == target.id else { return }
            let didRollback = try rollback(changes: changes, revision: revision)
            guard didRollback else { return }
            lastFailedChanges = changes
            throw error
        }
    }

    private func rollback(changes: RoomChanges, revision: Int64) throws -> Bool {
        guard let confirmedState, let currentState = roomState else { return false }
        let fieldsToRollback = Set(changes.affectedFields.filter { fieldRevisions[$0] == revision })
        guard !fieldsToRollback.isEmpty else { return false }
        roomState = try currentState.merging(fieldsToRollback, from: confirmedState)
        for field in fieldsToRollback {
            fieldRevisions.removeValue(forKey: field)
        }
        return true
    }

    /// Asks the hub a few times to check every device against what was last
    /// set here, so a bulb that missed the command gets fixed.
    private func startReconciliation(targetID: String, features: Features, revision: Int64) {
        reconcileTask?.cancel()
        guard !reconcileDelays.isEmpty else { return }

        reconcileTask = Task { [weak self] in
            guard let self else { return }
            for delay in reconcileDelays {
                do {
                    try await Task.sleep(for: delay)
                    try Task.checkCancellation()
                    guard
                        revision == latestRevision,
                        selectedTarget?.id == targetID,
                        let state = roomState,
                        let configuration,
                        let session
                    else { return }

                    let request = SyncRequest(
                        clientId: await preferences.clientID(),
                        revision: revision,
                        on: state.on,
                        brightness: state.on && features.brightness && state.brightness > 0 ? state.brightness : nil,
                        // Only check white if white was picked here; otherwise
                        // this would undo a color.
                        colorTemperaturePct: state.on && features.colorTemperature && state.colorMode == .temperature
                            ? state.colorTemperaturePct
                            : nil
                    )
                    let response = try await api.sync(
                        baseURL: configuration.baseURL,
                        token: session.token,
                        targetID: targetID,
                        request: request
                    )
                    if response.stale || revision != latestRevision {
                        return
                    }
                    if response.synchronized {
                        connection = .connected
                        return
                    }
                } catch is CancellationError {
                    return
                } catch {
                    if error as? DevicePanelError == .authenticationRequired {
                        await handle(error)
                        return
                    }
                    connection = .stale
                    lastError = message(for: error)
                }
            }
            if revision == latestRevision {
                connection = .stale
            }
        }
    }

    private func clearTarget() {
        reconcileTask?.cancel()
        loadGeneration += 1
        selectedTarget = nil
        roomState = nil
        confirmedState = nil
        fieldRevisions.removeAll()
        lastFailedChanges = nil
    }

    private func handle(_ error: Error) async {
        if error as? DevicePanelError == .authenticationRequired {
            reconcileTask?.cancel()
            try? await sessionStore.clear()
            session = nil
            authentication = .signedOut
        }
        present(error)
    }

    private func present(_ error: Error) {
        let message = message(for: error)
        lastError = message
        connection = error as? DevicePanelError == .offline ? .stale : .failed(message)
    }

    private func message(for error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? "The hub couldn't complete the request."
    }
}

import Foundation
import XCTest
@testable import DevicePanelCore

@MainActor
final class RoomControllerTests: XCTestCase {
    private static let room = Target(
        id: "living-room",
        name: "Living Room",
        kind: "room",
        features: Features(brightness: true, colorTemperature: true, color: true)
    )
    private static let lamp = Target(
        id: "lamp-a",
        name: "Lamp A",
        kind: "govee",
        features: Features(brightness: true, colorTemperature: true, color: true)
    )
    private static let plug = Target(id: "plug", name: "Plug", kind: "matter", features: .powerOnly)

    func testStartsSignedOutWithoutStoredSession() async throws {
        let controller = try await makeController(api: FakeAPI())

        await controller.start()

        XCTAssertEqual(controller.authentication, .signedOut)
        XCTAssertEqual(controller.serverURLString, "https://hub.example")
    }

    func testSignInPicksTheRoomAndLoadsItsState() async throws {
        let api = FakeAPI(targets: [Self.lamp, Self.room], light: try light(on: true, brightness: 50))
        let controller = try await makeController(api: api)

        await controller.signIn(password: "test-password")

        XCTAssertEqual(controller.authentication, .signedIn(serverLabel: "hub.example"))
        let signInOrigins = await api.signInOrigins
        XCTAssertEqual(signInOrigins.map(\.absoluteString), ["https://hub.example"])
        XCTAssertEqual(controller.targets.map(\.id), ["lamp-a", "living-room"])
        XCTAssertEqual(controller.selectedTarget?.id, "living-room")
        XCTAssertEqual(controller.targetName, "Living Room")
        XCTAssertEqual(controller.roomState?.brightness, 50)
        XCTAssertEqual(controller.connection, .connected)
    }

    func testStartDiscardsSessionAndCachedTargetFromAnotherHub() async throws {
        let preferences = SharedPreferences(suiteName: "RoomControllerTests.\(UUID().uuidString)")
        await preferences.saveServerConfiguration(try ServerConfiguration(urlString: "https://old-hub.example"))
        await preferences.saveSelectedTarget(CachedTarget(target: Self.room, state: nil))
        let sessionStore = InMemorySessionStore(session: Session(token: "old-hub-token"))
        let api = FakeAPI(targets: [Self.room])
        let controller = RoomController(
            configuredHub: try ServerConfiguration(urlString: "https://hub.example"),
            api: api,
            sessionStore: sessionStore,
            preferences: preferences
        )

        await controller.start()

        XCTAssertEqual(controller.authentication, .signedOut)
        XCTAssertEqual(controller.serverURLString, "https://hub.example")
        XCTAssertNil(controller.selectedTarget)
        let storedSession = await sessionStore.load()
        let cachedTarget = await preferences.selectedTarget()
        let requestedOrigins = await api.targetOrigins
        XCTAssertNil(storedSession)
        XCTAssertNil(cachedTarget)
        XCTAssertTrue(requestedOrigins.isEmpty, "A session for another hub must never be sent")
    }

    func testShortcutRejectsSessionForAnotherOrigin() async throws {
        let preferences = SharedPreferences(suiteName: "IntentTests.\(UUID().uuidString)")
        await preferences.saveServerConfiguration(try ServerConfiguration(urlString: "https://old-hub.example"))
        await preferences.saveSelectedTarget(CachedTarget(target: Self.room, state: nil))
        let api = FakeAPI(targets: [Self.room])
        let service = IntentCommandService(
            configuration: try ServerConfiguration(urlString: "https://hub.example"),
            api: api,
            sessionStore: InMemorySessionStore(session: Session(token: "old-hub-token")),
            preferences: preferences
        )

        do {
            _ = try await service.apply(RoomChanges(on: true))
            XCTFail("Expected a new sign-in for the configured hub")
        } catch {
            XCTAssertEqual(error as? DevicePanelError, .authenticationRequired)
        }
        let commands = await api.commands
        XCTAssertTrue(commands.isEmpty)
    }

    func testShortcutUsesConfiguredHubWithMatchingSession() async throws {
        let preferences = SharedPreferences(suiteName: "IntentTests.\(UUID().uuidString)")
        let configuration = try ServerConfiguration(urlString: "https://hub.example")
        await preferences.saveServerConfiguration(configuration)
        await preferences.saveSelectedTarget(CachedTarget(
            target: Self.room,
            state: RoomState(light: try light(on: false, brightness: 50))
        ))
        let api = FakeAPI()
        let service = IntentCommandService(
            configuration: configuration,
            api: api,
            sessionStore: InMemorySessionStore(session: Session(token: "matching-hub-token")),
            preferences: preferences
        )

        let updated = try await service.apply(RoomChanges(on: true))

        XCTAssertEqual(updated.state?.on, true)
        let commands = await api.commands
        XCTAssertEqual(commands.first?.origin, configuration.baseURL)
        XCTAssertEqual(commands.first?.target, "living-room")
    }

    func testCommandsGoToTheSelectedTarget() async throws {
        let api = FakeAPI(targets: [Self.room, Self.lamp], light: try light(on: true, brightness: 50))
        let controller = try await startSignedIn(api: api)

        await controller.select("lamp-a")
        await controller.setBrightness(10)

        XCTAssertEqual(controller.selectedTarget?.name, "Lamp A")
        let commands = await api.commands
        XCTAssertEqual(commands.map(\.target), ["lamp-a"])
        XCTAssertEqual(commands.first?.command.brightness, 10)
        XCTAssertNil(commands.first?.command.on)
        XCTAssertEqual(controller.roomState?.brightness, 10)
    }

    func testFailedPowerCommandRollsBackOnlyPower() async throws {
        let api = FakeAPI(targets: [Self.room], light: try light(on: false, brightness: 50), commandError: .offline)
        let controller = try await startSignedIn(api: api)

        await controller.setPower(true)

        XCTAssertEqual(controller.roomState?.on, false)
        XCTAssertEqual(controller.roomState?.brightness, 50)
        XCTAssertEqual(controller.connection, .stale)
        XCTAssertTrue(controller.canRetryLastCommand)
    }

    func testFailedDevicesAreReported() async throws {
        let api = FakeAPI(
            targets: [Self.room],
            light: try light(on: true, brightness: 50),
            commandError: .devicesFailed(["lamp-b": "timeout"])
        )
        let controller = try await startSignedIn(api: api)

        await controller.setBrightness(75)

        XCTAssertEqual(controller.roomState?.brightness, 50)
        XCTAssertEqual(controller.lastError, "1 device(s) didn't respond: lamp-b")
    }

    func testPartlyAnsweredRoomShowsTheMissingDevices() async throws {
        let api = FakeAPI(targets: [Self.room], light: try light(on: true, brightness: 50), failed: ["lamp-b": "offline"])
        let controller = try await startSignedIn(api: api)

        XCTAssertEqual(controller.roomState?.brightness, 50)
        XCTAssertEqual(controller.connection, .stale)
        XCTAssertEqual(controller.lastError, "1 device(s) didn't respond: lamp-b")
    }

    func testTemperatureCommandSwitchesBackToTemperatureMode() async throws {
        let api = FakeAPI(targets: [Self.room], light: try light(on: true, brightness: 75))
        let controller = try await startSignedIn(api: api)

        await controller.setColor(.red)
        XCTAssertEqual(controller.roomState?.colorMode, .red)
        await controller.setColorTemperature(25)

        XCTAssertEqual(controller.roomState?.colorTemperaturePct, 25)
        XCTAssertEqual(controller.roomState?.colorMode, .temperature)
        let colors = await api.commands.map(\.command.color)
        XCTAssertEqual(colors, ["#ff0000", nil])
    }

    func testSyncOnlyChecksWhiteAfterWhiteWasPicked() async throws {
        let api = FakeAPI(targets: [Self.room], light: try light(on: true, brightness: 75), synchronized: true)
        let controller = try await startSignedIn(api: api, reconcileDelays: [.milliseconds(1)])

        await controller.setColor(.orange)
        let afterColor = try await waitForSync(api, count: 1)
        await controller.setColorTemperature(30)
        let afterWhite = try await waitForSync(api, count: 2)

        XCTAssertEqual(afterColor.request.brightness, 75)
        XCTAssertNil(afterColor.request.colorTemperaturePct, "Checking white would undo the color")
        XCTAssertEqual(afterWhite.request.colorTemperaturePct, 30)
        XCTAssertEqual(afterWhite.target, "living-room")
        XCTAssertEqual(controller.connection, .connected)
    }

    func testSyncSkipsWhatTheTargetCantChange() async throws {
        let api = FakeAPI(targets: [Self.plug], light: try light(on: false, brightness: 0), synchronized: true)
        let controller = try await startSignedIn(api: api, reconcileDelays: [.milliseconds(1)])

        await controller.setPower(true)
        let sync = try await waitForSync(api, count: 1)

        XCTAssertEqual(controller.features, .powerOnly)
        XCTAssertTrue(sync.request.on)
        XCTAssertNil(sync.request.brightness)
        XCTAssertNil(sync.request.colorTemperaturePct)
    }

    func testPairingChecksTheCodeBeforeCallingTheHub() async throws {
        let api = FakeAPI(targets: [Self.room], light: try light(on: true, brightness: 50))
        let controller = try await startSignedIn(api: api)

        await controller.pair(code: "1234", networkOnly: false)

        XCTAssertEqual(controller.matter.error, "Enter the 11-digit setup code or the MT: code from the QR label.")
        let codes = await api.commissionedCodes
        XCTAssertTrue(codes.isEmpty)
    }

    func testPairingSendsTheCleanedCodeAndReportsTheNode() async throws {
        let api = FakeAPI(targets: [Self.room], light: try light(on: true, brightness: 50))
        let controller = try await startSignedIn(api: api)

        await controller.pair(code: "3497-011-2332", networkOnly: true)

        let codes = await api.commissionedCodes
        XCTAssertEqual(codes, ["34970112332"])
        XCTAssertEqual(controller.matter.pairedNodeID, 7)
        XCTAssertFalse(controller.matter.isPairing)
    }

    func testPairingReportsAMissingMatterServer() async throws {
        let api = FakeAPI(targets: [Self.room], light: try light(on: true, brightness: 50), matterError: .matterUnavailable)
        let controller = try await startSignedIn(api: api)

        await controller.loadMatterNodes()

        XCTAssertEqual(controller.matter.error, "The hub isn't connected to its Matter server.")
        XCTAssertEqual(controller.authentication, .signedIn(serverLabel: "hub.example"))
    }

    func testExpiredSessionSignsOut() async throws {
        let api = FakeAPI(targets: [Self.room], light: try light(on: true, brightness: 50), commandError: .authenticationRequired)
        let controller = try await startSignedIn(api: api)

        await controller.setPower(false)

        XCTAssertEqual(controller.authentication, .signedOut)
        XCTAssertEqual(controller.lastError, "Your session has ended. Sign in again.")
    }

    // MARK: - Helpers

    private func light(on: Bool, brightness: Int) throws -> LightState {
        try LightState(on: on, brightness: brightness, colorTemperaturePct: 50)
    }

    private func startSignedIn(
        api: FakeAPI,
        reconcileDelays: [Duration] = []
    ) async throws -> RoomController {
        let controller = try await makeController(
            api: api,
            storedSession: Session(token: "token"),
            configuration: "https://hub.example",
            reconcileDelays: reconcileDelays
        )
        await controller.start()
        return controller
    }

    private func makeController(
        api: FakeAPI,
        storedSession: Session? = nil,
        configuration: String? = nil,
        reconcileDelays: [Duration] = []
    ) async throws -> RoomController {
        let preferences = SharedPreferences(suiteName: "RoomControllerTests.\(UUID().uuidString)")
        await preferences.reset()
        if let configuration {
            await preferences.saveServerConfiguration(try ServerConfiguration(urlString: configuration))
        }
        return RoomController(
            configuredHub: try ServerConfiguration(urlString: "https://hub.example"),
            api: api,
            sessionStore: InMemorySessionStore(session: storedSession),
            preferences: preferences,
            reconcileDelays: reconcileDelays
        )
    }

    private func waitForSync(_ api: FakeAPI, count: Int) async throws -> FakeAPI.Sync {
        for _ in 0 ..< 200 {
            let syncs = await api.syncs
            if syncs.count >= count {
                // Let the controller handle the response.
                try await Task.sleep(for: .milliseconds(5))
                return syncs[count - 1]
            }
            try await Task.sleep(for: .milliseconds(5))
        }
        throw NoSync()
    }

    private struct NoSync: Error {}
}

private actor FakeAPI: DevicePanelAPI {
    struct Command: Sendable {
        let origin: URL
        let target: String
        let command: HubCommand
    }

    struct Sync: Sendable {
        let target: String
        let request: SyncRequest
    }

    private let targetList: [Target]
    private let light: LightState?
    private let failed: [String: String]
    private let commandError: DevicePanelError?
    private let matterError: DevicePanelError?
    private let synchronized: Bool
    private(set) var commands: [Command] = []
    private(set) var syncs: [Sync] = []
    private(set) var commissionedCodes: [String] = []
    private(set) var signInOrigins: [URL] = []
    private(set) var targetOrigins: [URL] = []

    init(
        targets: [Target] = [],
        light: LightState? = nil,
        failed: [String: String] = [:],
        commandError: DevicePanelError? = nil,
        matterError: DevicePanelError? = nil,
        synchronized: Bool = false
    ) {
        targetList = targets
        self.light = light
        self.failed = failed
        self.commandError = commandError
        self.matterError = matterError
        self.synchronized = synchronized
    }

    func signIn(baseURL: URL, password: String) async throws -> Session {
        signInOrigins.append(baseURL)
        return Session(token: "token")
    }

    func signOut(baseURL: URL, token: String) async throws {}

    func targets(baseURL: URL, token: String) async throws -> [Target] {
        targetOrigins.append(baseURL)
        return targetList
    }

    func state(baseURL: URL, token: String, targetID: String) async throws -> StateResponse {
        StateResponse(state: light, devices: [:], failed: failed)
    }

    func send(baseURL: URL, token: String, targetID: String, command: HubCommand) async throws {
        if let commandError { throw commandError }
        commands.append(Command(origin: baseURL, target: targetID, command: command))
    }

    func sync(baseURL: URL, token: String, targetID: String, request: SyncRequest) async throws -> SyncResponse {
        syncs.append(Sync(target: targetID, request: request))
        return SyncResponse(synchronized: synchronized, stale: false, corrected: [:], failed: [:])
    }

    func matterNodes(baseURL: URL, token: String) async throws -> [MatterNode] {
        if let matterError { throw matterError }
        return [MatterNode(nodeId: 7, available: true, vendor: "Eve", product: "Energy")]
    }

    func commission(baseURL: URL, token: String, code: String, networkOnly: Bool) async throws -> UInt64 {
        if let matterError { throw matterError }
        commissionedCodes.append(code)
        return 7
    }
}

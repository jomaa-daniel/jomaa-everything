import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import DevicePanelCore

final class HTTPDevicePanelAPITests: XCTestCase {
    private let hub = URL(string: "https://hub.example")!

    override func setUp() {
        super.setUp()
        URLProtocolStub.handler = nil
    }

    func testSignInPostsOnlyThePasswordAndUsesNoCookies() async throws {
        URLProtocolStub.handler = { request in
            XCTAssertEqual(request.url?.absoluteString, "https://hub.example/api/login")
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
            XCTAssertNil(request.value(forHTTPHeaderField: "Cookie"))
            XCTAssertEqual(try Self.json(request) as? [String: String], ["password": "not-logged"])
            return Self.response(request, json: #"{"token":"test-session-token"}"#)
        }

        let session = try await makeClient().signIn(baseURL: hub, password: "not-logged")

        XCTAssertEqual(session.token, "test-session-token")
    }

    func testCommandSendsBearerTokenAndOnlyChangedFields() async throws {
        let clientID = UUID()
        URLProtocolStub.handler = { request in
            XCTAssertEqual(request.url?.absoluteString, "https://hub.example/api/targets/living-room/command")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer secret-token")
            let body = try XCTUnwrap(try Self.json(request) as? [String: Any])
            XCTAssertEqual(Set(body.keys), ["color", "clientId", "revision"])
            XCTAssertEqual(body["color"] as? String, "#ff8000")
            XCTAssertEqual(body["clientId"] as? String, clientID.uuidString)
            XCTAssertEqual((body["revision"] as? NSNumber)?.int64Value, 1_700_000_000_000_001)
            return Self.response(request, json: #"{"ok":true}"#)
        }

        try await makeClient().send(
            baseURL: hub,
            token: "secret-token",
            targetID: "living-room",
            command: HubCommand(changes: try RoomChanges(color: .orange), clientId: clientID, revision: 1_700_000_000_000_001)
        )
    }

    func testDecodesTargetsAndRoomState() async throws {
        URLProtocolStub.handler = { request in
            switch request.url?.path {
            case "/api/targets":
                return Self.response(request, json: """
                {"targets":[
                  {"id":"living-room","name":"Living Room","kind":"room","members":["lamp-a","lamp-b"],
                   "features":{"brightness":true,"colorTemperature":true,"color":true}},
                  {"id":"plug","name":"Plug","kind":"matter",
                   "features":{"brightness":false,"colorTemperature":false,"color":false}}
                ]}
                """)
            default:
                return Self.response(request, json: """
                {"state":{"on":true,"brightness":40,"colorTemperaturePct":10},
                 "devices":{"lamp-a":{"on":true,"brightness":40,"colorTemperaturePct":10}},
                 "failed":{"lamp-b":"offline"}}
                """)
            }
        }
        let client = makeClient()

        let targets = try await client.targets(baseURL: hub, token: "t")
        let state = try await client.state(baseURL: hub, token: "t", targetID: "living-room")

        XCTAssertEqual(targets.map(\.id), ["living-room", "plug"])
        XCTAssertTrue(targets[0].isRoom)
        XCTAssertEqual(targets[0].features, Features(brightness: true, colorTemperature: true, color: true))
        XCTAssertEqual(targets[1].features, .powerOnly)
        XCTAssertEqual(state.state, try LightState(on: true, brightness: 40, colorTemperaturePct: 10))
        XCTAssertEqual(state.failed, ["lamp-b": "offline"])
    }

    func testDecodesStateWhenNoDeviceAnswered() async throws {
        URLProtocolStub.handler = { request in
            Self.response(request, json: #"{"state":null,"devices":{},"failed":{"lamp-a":"offline"}}"#)
        }

        let state = try await makeClient().state(baseURL: hub, token: "t", targetID: "lamp-a")

        XCTAssertNil(state.state)
        XCTAssertEqual(state.failed, ["lamp-a": "offline"])
    }

    func testRejectsResponsesMissingFieldsTheHubAlwaysSends() async {
        URLProtocolStub.handler = { request in
            switch request.url?.path {
            case "/api/targets":
                return Self.response(request, json: #"{"targets":[{"id":"plug","name":"Plug","kind":"matter"}]}"#)
            case "/api/targets/r/sync":
                return Self.response(request, json: #"{"synchronized":true}"#)
            default:
                return Self.response(request, json: #"{"state":{"on":true,"brightness":40,"colorTemperaturePct":10}}"#)
            }
        }
        let client = makeClient()

        await assertThrows(.invalidResponse) {
            _ = try await client.targets(baseURL: self.hub, token: "t")
        }
        await assertThrows(.invalidResponse) {
            _ = try await client.state(baseURL: self.hub, token: "t", targetID: "r")
        }
        await assertThrows(.invalidResponse) {
            _ = try await client.sync(
                baseURL: self.hub,
                token: "t",
                targetID: "r",
                request: SyncRequest(clientId: UUID(), revision: 1, on: true, brightness: nil, colorTemperaturePct: nil)
            )
        }
    }

    func testDecodesSyncResult() async throws {
        URLProtocolStub.handler = { request in
            Self.response(request, json: """
            {"synchronized":false,"stale":false,"corrected":{"lamp-a":["brightness"]},
             "failed":{"lamp-b":"offline"},"observed":{"lamp-a":{"on":true,"brightness":40,"colorTemperaturePct":10}}}
            """)
        }

        let result = try await makeClient().sync(
            baseURL: hub,
            token: "t",
            targetID: "r",
            request: SyncRequest(clientId: UUID(), revision: 1, on: true, brightness: 50, colorTemperaturePct: nil)
        )

        XCTAssertEqual(
            result,
            SyncResponse(synchronized: false, stale: false, corrected: ["lamp-a": ["brightness"]], failed: ["lamp-b": "offline"])
        )
    }

    func testCommissionReturnsTheNewNodeID() async throws {
        URLProtocolStub.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/matter/commission")
            return Self.response(request, json: #"{"node":{"node_id":7,"available":true,"is_bridge":false}}"#)
        }

        let nodeID = try await makeClient().commission(baseURL: hub, token: "t", code: "34970112332", networkOnly: false)

        XCTAssertEqual(nodeID, 7)
    }

    func testRejectsOutOfRangeState() async {
        URLProtocolStub.handler = { request in
            Self.response(
                request,
                json: #"{"state":{"on":true,"brightness":140,"colorTemperaturePct":10},"devices":{},"failed":{}}"#
            )
        }

        await assertThrows(.invalidResponse) {
            _ = try await self.makeClient().state(baseURL: self.hub, token: "t", targetID: "living-room")
        }
    }

    func testMapsPartialFailureToFailedDevices() async {
        URLProtocolStub.handler = { request in
            Self.response(request, status: 502, json: #"{"ok":false,"failed":{"lamp-b":"timeout"}}"#)
        }

        await assertThrows(.devicesFailed(["lamp-b": "timeout"])) {
            try await self.makeClient().send(
                baseURL: self.hub,
                token: "t",
                targetID: "living-room",
                command: HubCommand(changes: try RoomChanges(on: true), clientId: UUID(), revision: 1)
            )
        }
    }

    func testMapsMissingMatterServer() async {
        URLProtocolStub.handler = { request in
            Self.response(request, status: 503, json: #"{"error":"Matter controller is not running"}"#)
        }

        await assertThrows(.matterUnavailable) {
            _ = try await self.makeClient().matterNodes(baseURL: self.hub, token: "t")
        }
    }

    func testMapsUnauthorizedResponses() async {
        URLProtocolStub.handler = { request in
            Self.response(request, status: 401, json: #"{"error":"sign in first"}"#)
        }

        await assertThrows(.authenticationRequired) {
            _ = try await self.makeClient().targets(baseURL: self.hub, token: "expired")
        }
        await assertThrows(.invalidCredentials) {
            _ = try await self.makeClient().signIn(baseURL: self.hub, password: "wrong")
        }
    }

    func testReadsRetryAfterWhenSignInIsLockedOut() async {
        URLProtocolStub.handler = { request in
            Self.response(request, status: 429, headers: ["Retry-After": "120"], json: #"{"error":"too many failed sign-ins; try again later"}"#)
        }

        await assertThrows(.rateLimited(retryAfter: 120)) {
            _ = try await self.makeClient().signIn(baseURL: self.hub, password: "guess")
        }
    }

    func testRejectsSuccessThatIsNotJSON() async {
        URLProtocolStub.handler = { request in
            Self.response(request, headers: ["Content-Type": "text/html"], json: "<html>Wi-Fi login</html>")
        }

        await assertThrows(.invalidResponse) {
            _ = try await self.makeClient().targets(baseURL: self.hub, token: "t")
        }
    }

    func testLoopbackModeRejectsExternalHostsBeforeStartingARequest() async {
        URLProtocolStub.handler = { _ in
            XCTFail("An external request must not start in loopback-only mode")
            throw DevicePanelError.invalidServerURL
        }
        let client = HTTPDevicePanelAPI(session: makeSession(), allowedHosts: ["localhost", "127.0.0.1", "::1"])

        await assertThrows(.invalidServerURL) {
            _ = try await client.targets(baseURL: self.hub, token: "t")
        }
    }

    private func makeClient() -> HTTPDevicePanelAPI {
        HTTPDevicePanelAPI(session: makeSession())
    }

    private func makeSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [URLProtocolStub.self]
        return URLSession(configuration: configuration)
    }

    private func assertThrows(
        _ expected: DevicePanelError,
        file: StaticString = #filePath,
        line: UInt = #line,
        _ body: () async throws -> Void
    ) async {
        do {
            try await body()
            XCTFail("Expected \(expected)", file: file, line: line)
        } catch {
            XCTAssertEqual(error as? DevicePanelError, expected, file: file, line: line)
        }
    }

    private static func response(
        _ request: URLRequest,
        status: Int = 200,
        headers: [String: String] = ["Content-Type": "application/json"],
        json: String
    ) -> (HTTPURLResponse, Data) {
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: headers)!
        return (response, Data(json.utf8))
    }

    /// URLSession hands protocols the body as a stream, not as httpBody.
    private static func json(_ request: URLRequest) throws -> Any {
        var data = request.httpBody ?? Data()
        if data.isEmpty, let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                data.append(buffer, count: count)
            }
        }
        return try JSONSerialization.jsonObject(with: data)
    }
}

private final class URLProtocolStub: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: (@Sendable (URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler else {
            XCTFail("URLProtocolStub.handler was not set")
            return
        }
        do {
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

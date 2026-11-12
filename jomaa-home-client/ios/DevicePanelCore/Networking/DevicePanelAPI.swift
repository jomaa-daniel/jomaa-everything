import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// The hub's HTTP API. Every device looks the same here, whatever brand it
/// is: the hub speaks Matter (and anything else) on the app's behalf.
public protocol DevicePanelAPI: Sendable {
    func signIn(baseURL: URL, password: String) async throws -> Session
    func signOut(baseURL: URL, token: String) async throws
    func targets(baseURL: URL, token: String) async throws -> [Target]
    func state(baseURL: URL, token: String, targetID: String) async throws -> StateResponse
    func send(baseURL: URL, token: String, targetID: String, command: HubCommand) async throws
    func sync(baseURL: URL, token: String, targetID: String, request: SyncRequest) async throws -> SyncResponse
    func matterNodes(baseURL: URL, token: String) async throws -> [MatterNode]
    func commission(baseURL: URL, token: String, code: String, networkOnly: Bool) async throws -> UInt64
}

public actor HTTPDevicePanelAPI: DevicePanelAPI {
    private let session: URLSession
    private let pairingSession: URLSession
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()
    private let allowedHosts: Set<String>?

    public init(session: URLSession? = nil, allowedHosts: Set<String>? = nil) {
        if let session {
            self.session = session
            pairingSession = session
        } else {
            self.session = URLSession(configuration: Self.configuration(requestTimeout: 15, resourceTimeout: 30))
            // Pairing a Matter device can take a few minutes; the hub allows five.
            pairingSession = URLSession(configuration: Self.configuration(requestTimeout: 330, resourceTimeout: 360))
        }
        self.allowedHosts = allowedHosts.map { Set($0.map { $0.lowercased() }) }
    }

    private static func configuration(requestTimeout: TimeInterval, resourceTimeout: TimeInterval) -> URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = requestTimeout
        configuration.timeoutIntervalForResource = resourceTimeout
        #if !canImport(FoundationNetworking)
        configuration.waitsForConnectivity = false
        #endif
        configuration.httpShouldSetCookies = false
        configuration.urlCredentialStorage = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        return configuration
    }

    public func signIn(baseURL: URL, password: String) async throws -> Session {
        let response: SignInResponse = try await send(
            baseURL: baseURL,
            path: ["api", "login"],
            method: "POST",
            token: nil,
            body: try encoder.encode(SignInRequest(password: password)),
            unauthorizedError: .invalidCredentials
        )
        return Session(token: response.token)
    }

    public func signOut(baseURL: URL, token: String) async throws {
        let _: [String: Bool] = try await send(
            baseURL: baseURL,
            path: ["api", "logout"],
            method: "POST",
            token: token,
            body: Data("{}".utf8)
        )
    }

    public func targets(baseURL: URL, token: String) async throws -> [Target] {
        let list: TargetList = try await send(baseURL: baseURL, path: ["api", "targets"], method: "GET", token: token)
        return list.targets
    }

    public func state(baseURL: URL, token: String, targetID: String) async throws -> StateResponse {
        try await send(baseURL: baseURL, path: ["api", "targets", targetID, "state"], method: "GET", token: token)
    }

    public func send(baseURL: URL, token: String, targetID: String, command: HubCommand) async throws {
        let response: CommandResponse = try await send(
            baseURL: baseURL,
            path: ["api", "targets", targetID, "command"],
            method: "POST",
            token: token,
            body: try encoder.encode(command)
        )
        if !response.failed.isEmpty {
            throw DevicePanelError.devicesFailed(response.failed)
        }
    }

    public func sync(baseURL: URL, token: String, targetID: String, request: SyncRequest) async throws -> SyncResponse {
        try await send(
            baseURL: baseURL,
            path: ["api", "targets", targetID, "sync"],
            method: "POST",
            token: token,
            body: try encoder.encode(request)
        )
    }

    public func matterNodes(baseURL: URL, token: String) async throws -> [MatterNode] {
        let list: MatterNodeList = try await send(
            baseURL: baseURL,
            path: ["api", "matter", "nodes"],
            method: "GET",
            token: token
        )
        return list.nodes
    }

    /// Pairs a Matter device through the hub. Returns the new node id.
    public func commission(baseURL: URL, token: String, code: String, networkOnly: Bool) async throws -> UInt64 {
        struct Body: Encodable {
            let code: String
            let networkOnly: Bool
        }
        let response: CommissionResponse = try await send(
            baseURL: baseURL,
            path: ["api", "matter", "commission"],
            method: "POST",
            token: token,
            body: try encoder.encode(Body(code: code, networkOnly: networkOnly)),
            using: pairingSession
        )
        return response.node.nodeId
    }

    private func send<Response: Decodable>(
        baseURL: URL,
        path: [String],
        method: String,
        token: String?,
        body: Data? = nil,
        unauthorizedError: DevicePanelError = .authenticationRequired,
        using urlSession: URLSession? = nil
    ) async throws -> Response {
        let (data, response) = try await perform(
            baseURL: baseURL,
            path: path,
            method: method,
            token: token,
            body: body,
            urlSession: urlSession ?? session
        )
        try validate(response: response, data: data, unauthorizedError: unauthorizedError)
        do {
            return try decoder.decode(Response.self, from: data)
        } catch {
            throw DevicePanelError.invalidResponse
        }
    }

    private func perform(
        baseURL: URL,
        path: [String],
        method: String,
        token: String?,
        body: Data?,
        urlSession: URLSession
    ) async throws -> (Data, HTTPURLResponse) {
        if let allowedHosts {
            guard let host = baseURL.host?.lowercased(), allowedHosts.contains(host) else {
                throw DevicePanelError.invalidServerURL
            }
        }
        var url = baseURL
        for segment in path {
            url.appendPathComponent(segment)
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if body != nil {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if let token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        do {
            let (data, response) = try await urlSession.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse else {
                throw DevicePanelError.invalidResponse
            }
            return (data, httpResponse)
        } catch let error as DevicePanelError {
            throw error
        } catch let error as URLError {
            switch error.code {
            case .notConnectedToInternet, .networkConnectionLost, .cannotConnectToHost, .cannotFindHost:
                throw DevicePanelError.offline
            case .timedOut:
                throw DevicePanelError.timedOut
            default:
                throw DevicePanelError.offline
            }
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw DevicePanelError.offline
        }
    }

    private func validate(response: HTTPURLResponse, data: Data, unauthorizedError: DevicePanelError) throws {
        guard (200 ... 299).contains(response.statusCode) else {
            let payload = try? decoder.decode(APIErrorPayload.self, from: data)
            switch response.statusCode {
            case 401:
                throw unauthorizedError
            case 429:
                let retryAfter = response.value(forHTTPHeaderField: "Retry-After").flatMap(TimeInterval.init)
                throw DevicePanelError.rateLimited(retryAfter: retryAfter)
            case 503:
                throw DevicePanelError.matterUnavailable
            default:
                throw DevicePanelError.server(status: response.statusCode, message: payload?.error)
            }
        }
        let contentType = response.value(forHTTPHeaderField: "Content-Type")?.lowercased() ?? ""
        guard contentType.contains("application/json") else {
            throw DevicePanelError.invalidResponse
        }
    }
}

import Foundation

/// The body of a hub error.
struct APIErrorPayload: Decodable, Sendable {
    let error: String?
}

public enum DevicePanelError: Error, Equatable, Sendable {
    case invalidServerURL
    case invalidCredentials
    case authenticationRequired
    case offline
    case timedOut
    case rateLimited(retryAfter: TimeInterval?)
    case devicesFailed([String: String])
    case matterUnavailable
    case noTargetSelected
    case invalidResponse
    case server(status: Int, message: String?)
    case keychain(status: Int32)
    case storage
}

extension DevicePanelError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .invalidServerURL:
            "Enter a valid hub address, like http://192.168.1.10:8080."
        case .invalidCredentials:
            "Incorrect password."
        case .authenticationRequired:
            "Your session has ended. Sign in again."
        case .offline:
            "Can't reach the hub. Check that you're on your home network."
        case .timedOut:
            "The hub took too long to respond."
        case let .rateLimited(retryAfter):
            if let retryAfter {
                "Too many sign-in attempts. Try again in \(Int(retryAfter.rounded())) seconds."
            } else {
                "Too many sign-in attempts. Wait a while and try again."
            }
        case let .devicesFailed(failed):
            "\(failed.count) device(s) didn't respond: \(failed.keys.sorted().joined(separator: ", "))"
        case .matterUnavailable:
            "The hub isn't connected to its Matter server."
        case .noTargetSelected:
            "Open Device Panel and pick a room first."
        case .invalidResponse:
            "The hub returned an unexpected response."
        case let .server(status, message):
            message ?? "The hub couldn't complete the request (HTTP \(status))."
        case .keychain, .storage:
            "Secure storage is unavailable."
        }
    }
}

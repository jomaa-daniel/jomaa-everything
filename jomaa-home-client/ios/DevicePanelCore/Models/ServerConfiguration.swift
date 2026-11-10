import Foundation

/// The configured hub origin. Plain HTTP is supported for local test hubs.
public struct ServerConfiguration: Equatable, Sendable {
    public let baseURL: URL

    /// App and extension targets receive the same origin from their build configuration.
    public static func bundled(in bundle: Bundle = .main) throws -> ServerConfiguration {
        guard let address = bundle.object(forInfoDictionaryKey: "DevicePanelHubURL") as? String else {
            throw DevicePanelError.invalidServerURL
        }
        return try ServerConfiguration(urlString: address)
    }

    public init(urlString: String) throws {
        let trimmed = urlString.trimmingCharacters(in: .whitespacesAndNewlines)
        guard
            var components = URLComponents(string: trimmed),
            let scheme = components.scheme?.lowercased(),
            scheme == "https" || scheme == "http",
            components.user == nil,
            components.password == nil,
            components.query == nil,
            components.fragment == nil,
            components.path.isEmpty || components.path == "/",
            let host = components.host,
            !host.isEmpty
        else {
            throw DevicePanelError.invalidServerURL
        }
        guard scheme == "https" || Self.isHomeNetwork(host) else {
            throw DevicePanelError.invalidServerURL
        }

        components.scheme = scheme
        components.path = ""
        guard let url = components.url else {
            throw DevicePanelError.invalidServerURL
        }
        baseURL = url
    }

    /// The address without the scheme, for showing to the user.
    public var label: String {
        guard let host = baseURL.host else { return baseURL.absoluteString }
        return baseURL.port.map { "\(host):\($0)" } ?? host
    }

    /// Loopback, private IPv4 ranges, link-local, IPv6 unique-local,
    /// ".local" names and single-label names like "hub".
    static func isHomeNetwork(_ host: String) -> Bool {
        let h = host.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        if h == "localhost" || h.hasSuffix(".local") { return true }
        if h.contains(":") {
            return h == "::1" || h.hasPrefix("fe80:") || h.hasPrefix("fd") || h.hasPrefix("fc")
        }
        let parts = h.split(separator: ".", omittingEmptySubsequences: false)
        if parts.count == 1 { return true }
        let octets = parts.compactMap { Int($0) }
        guard parts.count == 4, octets.count == 4, octets.allSatisfy({ (0 ... 255).contains($0) }) else {
            return false
        }
        let (a, b) = (octets[0], octets[1])
        return a == 10 || a == 127 || (a == 172 && (16 ... 31).contains(b)) || (a == 192 && b == 168)
            || (a == 169 && b == 254)
    }
}

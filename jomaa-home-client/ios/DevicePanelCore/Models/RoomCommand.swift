import Foundation

public enum RoomColor: String, Codable, CaseIterable, Sendable {
    case red
    case orange

    /// How the hub expects the color: "#rrggbb".
    public var hex: String {
        switch self {
        case .red: "#ff0000"
        case .orange: "#ff8000"
        }
    }
}

public struct RoomChanges: Equatable, Sendable {
    public let on: Bool?
    public let brightness: Int?
    public let colorTemperaturePct: Int?
    public let color: RoomColor?

    public init(
        on: Bool? = nil,
        brightness: Int? = nil,
        colorTemperaturePct: Int? = nil,
        color: RoomColor? = nil
    ) throws {
        if let brightness, !(1 ... 100).contains(brightness) {
            throw RoomModelError.invalidBrightness(brightness)
        }
        if let colorTemperaturePct, !(0 ... 100).contains(colorTemperaturePct) {
            throw RoomModelError.invalidColorTemperature(colorTemperaturePct)
        }
        guard on != nil || brightness != nil || colorTemperaturePct != nil || color != nil else {
            throw RoomModelError.emptyChanges
        }
        guard color == nil || colorTemperaturePct == nil else {
            throw RoomModelError.colorAndTemperature
        }
        self.on = on
        self.brightness = brightness
        self.colorTemperaturePct = colorTemperaturePct
        self.color = color
    }
}

/// A partial update for one target. Nil fields are left out of the JSON, and
/// the hub leaves them alone.
public struct HubCommand: Encodable, Equatable, Sendable {
    public let on: Bool?
    public let brightness: Int?
    public let colorTemperaturePct: Int?
    public let color: String?
    public let clientId: String
    public let revision: Int64

    public init(changes: RoomChanges, clientId: UUID, revision: Int64) {
        on = changes.on
        brightness = changes.brightness
        colorTemperaturePct = changes.colorTemperaturePct
        color = changes.color?.hex
        self.clientId = clientId.uuidString
        self.revision = revision
    }
}

/// What the target should look like, as this app last set it. The hub checks
/// each device and fixes only what drifted. Leave brightness or temperature
/// out to leave them alone.
public struct SyncRequest: Encodable, Equatable, Sendable {
    public let clientId: String
    public let revision: Int64
    public let on: Bool
    public let brightness: Int?
    public let colorTemperaturePct: Int?

    public init(clientId: UUID, revision: Int64, on: Bool, brightness: Int?, colorTemperaturePct: Int?) {
        self.clientId = clientId.uuidString
        self.revision = revision
        self.on = on
        self.brightness = brightness
        self.colorTemperaturePct = colorTemperaturePct
    }
}

/// `stale` means a newer command has been sent since, so this check was
/// skipped. `corrected` lists what the hub fixed on each device.
public struct SyncResponse: Decodable, Equatable, Sendable {
    public let synchronized: Bool
    public let stale: Bool
    public let corrected: [String: [String]]
    public let failed: [String: String]

    public init(synchronized: Bool, stale: Bool, corrected: [String: [String]], failed: [String: String]) {
        self.synchronized = synchronized
        self.stale = stale
        self.corrected = corrected
        self.failed = failed
    }
}

import Foundation

// The app only talks to the home hub. Every device looks the same here,
// whatever brand it is: the hub speaks Matter (and anything else) for us.

/// What a device or room can change. A Matter plug, for example, has none.
public struct Features: Codable, Equatable, Sendable {
    public var brightness: Bool
    public var colorTemperature: Bool
    public var color: Bool

    /// Power only: nothing else can change.
    public static let powerOnly = Features(brightness: false, colorTemperature: false, color: false)

    public init(brightness: Bool, colorTemperature: Bool, color: Bool) {
        self.brightness = brightness
        self.colorTemperature = colorTemperature
        self.color = color
    }
}

/// A device or room the hub controls. `kind` is "room" or the driver behind
/// a single device. Only rooms have `members`; it is nil for a device.
public struct Target: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let kind: String
    public let members: [String]?
    public let features: Features

    public init(id: String, name: String, kind: String, members: [String]?, features: Features) {
        self.id = id
        self.name = name
        self.kind = kind
        self.members = members
        self.features = features
    }

    public var isRoom: Bool { kind == "room" }
}

struct TargetList: Decodable, Sendable {
    let targets: [Target]
}

/// A light as the hub reports it. Brightness and colorTemperaturePct are
/// 0-100; 0 is the warmest white.
public struct LightState: Codable, Equatable, Sendable {
    public let on: Bool
    public let brightness: Int
    public let colorTemperaturePct: Int

    public init(on: Bool, brightness: Int, colorTemperaturePct: Int) throws {
        guard (0 ... 100).contains(brightness) else {
            throw RoomModelError.invalidBrightness(brightness)
        }
        guard (0 ... 100).contains(colorTemperaturePct) else {
            throw RoomModelError.invalidColorTemperature(colorTemperaturePct)
        }
        self.on = on
        self.brightness = brightness
        self.colorTemperaturePct = colorTemperaturePct
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        try self.init(
            on: container.decode(Bool.self, forKey: .on),
            brightness: container.decode(Int.self, forKey: .brightness),
            colorTemperaturePct: container.decode(Int.self, forKey: .colorTemperaturePct)
        )
    }
}

/// A target's state. For a room, `state` is the room as a whole, `devices`
/// holds each member that answered, and `failed` each one that didn't.
/// `state` is nil when no device under the target answered.
public struct StateResponse: Decodable, Equatable, Sendable {
    public let state: LightState?
    public let devices: [String: LightState]
    public let failed: [String: String]

    public init(state: LightState?, devices: [String: LightState], failed: [String: String]) {
        self.state = state
        self.devices = devices
        self.failed = failed
    }
}

/// A device paired with the hub's Matter server.
public struct MatterNode: Decodable, Equatable, Identifiable, Sendable {
    public let nodeId: UInt64
    public let available: Bool
    public let vendor: String?
    public let product: String?
    public let label: String?

    public init(nodeId: UInt64, available: Bool, vendor: String? = nil, product: String? = nil, label: String? = nil) {
        self.nodeId = nodeId
        self.available = available
        self.vendor = vendor
        self.product = product
        self.label = label
    }

    public var id: UInt64 { nodeId }

    public var displayName: String {
        let name = [vendor, product, label].compactMap { $0 }.joined(separator: " ")
        return name.isEmpty ? "Matter device" : name
    }
}

struct MatterNodeList: Decodable, Sendable {
    let nodes: [MatterNode]
}

struct CommissionResponse: Decodable, Sendable {
    struct Node: Decodable, Sendable {
        let nodeId: UInt64

        private enum CodingKeys: String, CodingKey {
            case nodeId = "node_id"
        }
    }

    let node: Node
}

/// Checks a Matter setup code before it goes to the hub.
public enum MatterSetupCode {
    /// Returns the cleaned code, or nil if it isn't a QR payload ("MT:...")
    /// or an 11- or 21-digit manual code.
    public static func normalize(_ input: String) -> String? {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.hasPrefix("MT:") {
            return trimmed.count > 3 ? trimmed : nil
        }
        let digits = trimmed.replacingOccurrences(of: "-", with: "").replacingOccurrences(of: " ", with: "")
        guard [11, 21].contains(digits.count), digits.allSatisfy({ ("0" ... "9").contains($0) }) else {
            return nil
        }
        return digits
    }
}

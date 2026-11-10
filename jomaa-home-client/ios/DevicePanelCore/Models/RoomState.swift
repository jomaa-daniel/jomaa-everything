import Foundation

/// The last color the app chose. The hub doesn't report color, so a freshly
/// loaded target is `unknown` until the user picks a color or a white.
public enum RoomColorMode: String, Codable, Equatable, Sendable {
    case temperature
    case red
    case orange
    case unknown
}

/// What the selected room or device looks like, as far as the app knows.
public struct RoomState: Codable, Equatable, Sendable {
    public let on: Bool
    public let brightness: Int
    public let colorTemperaturePct: Int
    public let colorMode: RoomColorMode
    public let observedAt: Date

    public init(
        on: Bool,
        brightness: Int,
        colorTemperaturePct: Int,
        colorMode: RoomColorMode,
        observedAt: Date
    ) throws {
        guard (0 ... 100).contains(brightness) else {
            throw RoomModelError.invalidBrightness(brightness)
        }
        guard (0 ... 100).contains(colorTemperaturePct) else {
            throw RoomModelError.invalidColorTemperature(colorTemperaturePct)
        }
        self.on = on
        self.brightness = brightness
        self.colorTemperaturePct = colorTemperaturePct
        self.colorMode = colorMode
        self.observedAt = observedAt
    }

    /// `light` was already range-checked when it was decoded.
    public init(light: LightState, colorMode: RoomColorMode = .unknown, observedAt: Date = Date()) {
        on = light.on
        brightness = light.brightness
        colorTemperaturePct = light.colorTemperaturePct
        self.colorMode = colorMode
        self.observedAt = observedAt
    }

    private enum CodingKeys: String, CodingKey {
        case on
        case brightness
        case colorTemperaturePct
        case colorMode
        case observedAt
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        try self.init(
            on: container.decode(Bool.self, forKey: .on),
            brightness: container.decode(Int.self, forKey: .brightness),
            colorTemperaturePct: container.decode(Int.self, forKey: .colorTemperaturePct),
            colorMode: container.decode(RoomColorMode.self, forKey: .colorMode),
            observedAt: container.decode(Date.self, forKey: .observedAt)
        )
    }
}

extension RoomState {
    func applying(_ changes: RoomChanges, observedAt: Date? = nil) throws -> RoomState {
        let colorMode: RoomColorMode
        if let color = changes.color {
            colorMode = switch color {
            case .red: .red
            case .orange: .orange
            }
        } else if changes.colorTemperaturePct != nil {
            colorMode = .temperature
        } else {
            colorMode = self.colorMode
        }

        return try RoomState(
            on: changes.on ?? on,
            brightness: changes.brightness ?? brightness,
            colorTemperaturePct: changes.colorTemperaturePct ?? colorTemperaturePct,
            colorMode: colorMode,
            observedAt: observedAt ?? self.observedAt
        )
    }

    func merging(_ fields: Set<RoomField>, from other: RoomState) throws -> RoomState {
        try RoomState(
            on: fields.contains(.power) ? other.on : on,
            brightness: fields.contains(.brightness) ? other.brightness : brightness,
            colorTemperaturePct: fields.contains(.temperature) ? other.colorTemperaturePct : colorTemperaturePct,
            colorMode: fields.contains(.color) || fields.contains(.temperature) ? other.colorMode : colorMode,
            observedAt: max(observedAt, other.observedAt)
        )
    }
}

enum RoomField: Hashable, Sendable {
    case power
    case brightness
    case temperature
    case color
}

extension RoomChanges {
    var affectedFields: Set<RoomField> {
        var fields = Set<RoomField>()
        if on != nil { fields.insert(.power) }
        if brightness != nil { fields.insert(.brightness) }
        if colorTemperaturePct != nil { fields.insert(.temperature) }
        if color != nil { fields.insert(.color) }
        return fields
    }
}

public enum RoomModelError: Error, Equatable, Sendable {
    case invalidBrightness(Int)
    case invalidColorTemperature(Int)
    case emptyChanges
    case colorAndTemperature
}

import AppIntents
import DevicePanelCore
import SwiftUI
import WidgetKit

/// The room or device the app last showed, for the widget.
public struct LivingRoomEntry: TimelineEntry, Sendable {
    public let date: Date
    public let name: String
    public let features: Features
    public let state: RoomState?
    public let isAuthenticated: Bool

    public init(
        date: Date,
        name: String = "Lights",
        features: Features = Features(brightness: true),
        state: RoomState?,
        isAuthenticated: Bool
    ) {
        self.date = date
        self.name = name
        self.features = features
        self.state = state
        self.isAuthenticated = isAuthenticated
    }
}

public struct LiveWidgetStateLoader: Sendable {
    private let configuration: ServerConfiguration?
    private let preferences: SharedPreferences
    private let sessionStore: any SessionStoring

    public init(
        configuration: ServerConfiguration? = try? ServerConfiguration.bundled(),
        preferences: SharedPreferences = SharedPreferences(),
        sessionStore: (any SessionStoring)? = nil
    ) {
        self.configuration = configuration
        self.preferences = preferences
        if let sessionStore {
            self.sessionStore = sessionStore
        } else {
            let accessGroup = Bundle.main.object(
                forInfoDictionaryKey: "DevicePanelKeychainAccessGroup"
            ) as? String
            self.sessionStore = KeychainSessionStore(accessGroup: accessGroup)
        }
    }

    public func load() async -> LivingRoomEntry {
        guard let configuration,
              (try? await preferences.serverConfiguration()) == configuration else {
            return LivingRoomEntry(date: Date(), state: nil, isAuthenticated: false)
        }
        let target = await preferences.selectedTarget()
        let session = try? await sessionStore.load()
        return LivingRoomEntry(
            date: Date(),
            name: target?.name ?? "Lights",
            features: target?.features ?? Features(),
            state: target?.state,
            isAuthenticated: session != nil
        )
    }
}

public struct LivingRoomProvider: TimelineProvider {
    private let loader: LiveWidgetStateLoader

    public init(loader: LiveWidgetStateLoader = LiveWidgetStateLoader()) {
        self.loader = loader
    }

    public func placeholder(in context: Context) -> LivingRoomEntry {
        LivingRoomEntry(date: Date(), state: nil, isAuthenticated: true)
    }

    public func getSnapshot(in context: Context, completion: @escaping (LivingRoomEntry) -> Void) {
        loadEntry(completion: completion)
    }

    public func getTimeline(
        in context: Context,
        completion: @escaping (Timeline<LivingRoomEntry>) -> Void
    ) {
        loadEntry { entry in
            completion(Timeline(entries: [entry], policy: .after(Date().addingTimeInterval(15 * 60))))
        }
    }

    private func loadEntry(completion: @escaping (LivingRoomEntry) -> Void) {
        let completion = CompletionBox(completion)
        let loader = loader
        Task {
            completion.call(await loader.load())
        }
    }
}

// WidgetKit's TimelineProvider callbacks predate Swift 6 sendability annotations.
// WidgetKit owns their lifetime and permits exactly one call, so this wrapper is
// the narrow unchecked boundary between that callback API and structured concurrency.
private final class CompletionBox<Value>: @unchecked Sendable {
    private let completion: (Value) -> Void

    init(_ completion: @escaping (Value) -> Void) {
        self.completion = completion
    }

    func call(_ value: Value) {
        completion(value)
    }
}

public struct LivingRoomWidget: Widget {
    public let kind = "LivingRoomWidget"

    public init() {}

    public var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: LivingRoomProvider()) { entry in
            LivingRoomWidgetContent(entry: entry)
                .containerBackground(for: .widget) {
                    LinearGradient(
                        colors: [
                            Color(red: 0.10, green: 0.10, blue: 0.18),
                            Color(red: 0.09, green: 0.13, blue: 0.24),
                        ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                }
        }
        .configurationDisplayName("Lights")
        .description("Control the room you last used in Device Panel.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

public struct LivingRoomWidgetContent: View {
    public let entry: LivingRoomEntry
    @Environment(\.widgetFamily) private var family
    private let familyOverride: WidgetFamily?

    public init(entry: LivingRoomEntry, familyOverride: WidgetFamily? = nil) {
        self.entry = entry
        self.familyOverride = familyOverride
    }

    public var body: some View {
        if !entry.isAuthenticated {
            Link(destination: URL(string: "devicepanel://signin")!) {
                VStack(alignment: .leading, spacing: 8) {
                    Image(systemName: "lock.fill")
                    Text("Sign in to Device Panel")
                        .font(.headline)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            }
        } else if let state = entry.state {
            if (familyOverride ?? family) == .systemMedium {
                mediumView(state)
            } else {
                smallView(state)
            }
        } else {
            Link(destination: URL(string: "devicepanel://room")!) {
                VStack(alignment: .leading, spacing: 8) {
                    Image(systemName: "arrow.clockwise")
                    Text("Open Device Panel to load state")
                        .font(.headline)
                }
            }
        }
    }

    private func smallView(_ state: RoomState) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(entry.name, systemImage: "lightbulb.max.fill")
                .font(.headline)
                .lineLimit(1)
            Spacer()
            Button(intent: SetPowerIntent(isOn: !state.on)) {
                Label(state.on ? "Turn Off" : "Turn On", systemImage: "power")
                    .font(.headline)
            }
            .buttonStyle(.borderedProminent)
            .tint(state.on ? .green : .orange)
            Text("\(state.brightness)% · \(state.observedAt, style: .relative)")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private func mediumView(_ state: RoomState) -> some View {
        HStack(spacing: 16) {
            VStack(alignment: .leading, spacing: 8) {
                Label(entry.name, systemImage: "lightbulb.max.fill")
                    .font(.headline)
                    .lineLimit(1)
                Text(state.on ? "On" : "Off")
                    .font(.title2.bold())
                Button(intent: SetPowerIntent(isOn: !state.on)) {
                    Label(state.on ? "Off" : "On", systemImage: "power")
                }
                .buttonStyle(.borderedProminent)
                .tint(state.on ? .green : .orange)
            }

            if entry.features.brightness {
                Divider()

                VStack(alignment: .leading, spacing: 8) {
                    Text("Brightness")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    HStack(spacing: 6) {
                        brightnessButton(.ten, current: state.brightness)
                        brightnessButton(.fifty, current: state.brightness)
                        brightnessButton(.seventyFive, current: state.brightness)
                        brightnessButton(.oneHundred, current: state.brightness)
                    }
                }
            }
        }
    }

    private func brightnessButton(_ preset: BrightnessPreset, current: Int) -> some View {
        Button(intent: SetBrightnessIntent(brightness: preset)) {
            Text("\(preset.rawValue)")
                .font(.caption.bold().monospacedDigit())
                .frame(minWidth: 28, minHeight: 32)
        }
        .buttonStyle(.bordered)
        .tint(current == preset.rawValue ? .orange : .secondary)
        .accessibilityLabel("\(preset.rawValue) percent brightness")
    }
}

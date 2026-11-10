import DevicePanelCore
import SwiftUI

struct ConnectionStatusView: View {
    let phase: ConnectionPhase
    let observedAt: Date?
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 10))
            : AnyLayout(HStackLayout(spacing: 10))

        layout {
            Image(systemName: icon)
                .foregroundStyle(color)
                .symbolEffect(.pulse, isActive: phase == .applying || phase == .loading)
            VStack(alignment: .leading, spacing: 2) {
                Text(phase.label)
                    .font(.subheadline.weight(.semibold))
                if let observedAt {
                    Text("Updated \(observedAt, style: .relative) ago")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .fixedSize(horizontal: false, vertical: true)
            if !dynamicTypeSize.isAccessibilitySize {
                Spacer()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .appSurface()
        .accessibilityIdentifier("connectionStatus")
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel)
    }

    private var icon: String {
        switch phase {
        case .connected: "checkmark.circle.fill"
        case .applying, .loading: "arrow.triangle.2.circlepath"
        case .stale: "wifi.slash"
        case .failed: "exclamationmark.triangle.fill"
        case .idle: "circle.dashed"
        }
    }

    private var color: Color {
        switch phase {
        case .connected: AppTheme.success
        case .failed: AppTheme.failure
        case .applying, .loading: AppTheme.accent
        case .idle, .stale: .secondary
        }
    }

    private var accessibilityLabel: String {
        guard let observedAt else { return phase.label }
        return "\(phase.label). State observed at \(observedAt.formatted(date: .omitted, time: .shortened))."
    }
}

struct PowerControl: View {
    let name: String
    let isOn: Bool
    let isBusy: Bool
    let action: () -> Void
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        Button(action: action) {
            Group {
                if dynamicTypeSize.isAccessibilitySize {
                    VStack(alignment: .leading, spacing: 12) {
                        HStack {
                            powerIcon
                            Spacer()
                            stateIndicator
                        }
                        powerDescription
                            .fixedSize(horizontal: false, vertical: true)
                    }
                } else {
                    HStack(spacing: 16) {
                        powerIcon
                        powerDescription
                        Spacer()
                        stateIndicator
                    }
                }
            }
            .contentShape(Rectangle())
            .padding(20)
            .frame(maxWidth: .infinity, minHeight: 76, alignment: .leading)
            .appSurface()
        }
        .buttonStyle(.plain)
        .disabled(isBusy)
        .accessibilityLabel("\(name) power")
        .accessibilityValue(isOn ? "On" : "Off")
        .accessibilityHint(isBusy ? "Applying the power change" : "Double tap to turn \(isOn ? "off" : "on")")
        .accessibilityIdentifier("powerControl")
    }

    private var powerIcon: some View {
        Image(systemName: "power")
            .font(.title2.bold())
    }

    private var powerDescription: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("Power")
                .font(.headline)
            Text(isOn ? "\(name) is on" : "\(name) is off")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private var stateIndicator: some View {
        if isBusy {
            ProgressView()
                .tint(.white)
        } else {
            Image(systemName: isOn ? "checkmark.circle.fill" : "circle")
                .font(.title2)
                .foregroundStyle(isOn ? AppTheme.success : .secondary)
        }
    }
}

/// Chooses the room or single device the controls below act on.
struct TargetPicker: View {
    let targets: [Target]
    let selectedID: String?
    let select: (String) -> Void

    /// Rooms first, as on Android.
    private var ordered: [Target] {
        targets.filter(\.isRoom) + targets.filter { !$0.isRoom }
    }

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(ordered) { target in
                    let selected = target.id == selectedID
                    Button {
                        select(target.id)
                    } label: {
                        Label(target.name, systemImage: target.isRoom ? "square.grid.2x2.fill" : "lightbulb.fill")
                            .font(.subheadline.weight(.semibold))
                            .padding(.horizontal, 14)
                            .frame(minHeight: 44)
                            .background(
                                selected ? AppTheme.accent.opacity(0.22) : AppTheme.surface,
                                in: Capsule()
                            )
                            .overlay {
                                Capsule()
                                    .stroke(selected ? AppTheme.accent : AppTheme.border, lineWidth: selected ? 2 : 1)
                            }
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(selected ? AppTheme.accent : .primary)
                    .accessibilityLabel(target.name)
                    .accessibilityValue(selected ? "Selected" : "Not selected")
                    .accessibilityIdentifier("target-\(target.id)")
                }
            }
        }
        .scrollClipDisabled()
    }
}

struct ColorSection: View {
    let selectedMode: RoomColorMode
    let select: (RoomColor) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Color")
                .font(.headline)
            HStack(spacing: 14) {
                colorButton(.red, color: .red, label: "Red")
                colorButton(.orange, color: .orange, label: "Orange")
            }
        }
    }

    private func colorButton(_ roomColor: RoomColor, color: Color, label: String) -> some View {
        let isSelected = switch (selectedMode, roomColor) {
        case (.red, .red), (.orange, .orange): true
        default: false
        }

        return Button {
            select(roomColor)
        } label: {
            ZStack(alignment: .bottomTrailing) {
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(color.gradient)
                    .frame(maxWidth: .infinity, minHeight: 86)
                if isSelected {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.title2)
                        .foregroundStyle(.white)
                        .shadow(radius: 3)
                        .padding(10)
                }
            }
            .overlay {
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .stroke(isSelected ? Color.white : AppTheme.border, lineWidth: isSelected ? 3 : 1)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityValue(isSelected ? "Selected" : "Not selected")
        .accessibilityIdentifier("color\(label)")
    }
}

struct BrightnessSection: View {
    static let presets = [10, 50, 75, 100]

    let brightness: Int
    let wideLayout: Bool
    let select: (Int) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Brightness")
                    .font(.headline)
                Spacer()
                Text("Current \(brightness)%")
                    .font(.subheadline.monospacedDigit())
                    .foregroundStyle(.secondary)
            }

            LazyVGrid(
                columns: Array(
                    repeating: GridItem(.flexible(), spacing: 10),
                    count: wideLayout ? 4 : 2
                ),
                spacing: 10
            ) {
                ForEach(Self.presets, id: \.self) { preset in
                    let selected = brightness == preset
                    Button {
                        select(preset)
                    } label: {
                        VStack(spacing: 8) {
                            Image(systemName: brightnessIcon(for: preset))
                                .font(.title2)
                            Text("\(preset)%")
                                .font(.headline.monospacedDigit())
                        }
                        .frame(maxWidth: .infinity, minHeight: 76)
                        .background(
                            selected ? AppTheme.accent.opacity(0.22) : AppTheme.surface,
                            in: RoundedRectangle(cornerRadius: 16, style: .continuous)
                        )
                        .overlay {
                            RoundedRectangle(cornerRadius: 16, style: .continuous)
                                .stroke(selected ? AppTheme.accent : AppTheme.border, lineWidth: selected ? 2 : 1)
                        }
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(selected ? AppTheme.accent : .primary)
                    .accessibilityLabel("\(preset) percent brightness")
                    .accessibilityValue(selected ? "Selected" : "Not selected")
                    .accessibilityIdentifier("brightness\(preset)")
                }
            }
        }
    }

    private func brightnessIcon(for value: Int) -> String {
        switch value {
        case ..<25: "sun.min"
        case ..<75: "sun.min.fill"
        default: "sun.max.fill"
        }
    }
}

struct TemperatureSection: View {
    @Binding var value: Double
    @Binding var isEditing: Bool
    let commit: (Double) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Color Temperature")
                    .font(.headline)
                Spacer()
                Text(TemperatureFormatter.signedPercentage(for: value))
                    .font(.headline.monospacedDigit())
            }

            Slider(value: $value, in: 0 ... 100, step: 1) { editing in
                isEditing = editing
                if !editing {
                    commit(value)
                }
            }
            .tint(.white)
            .padding(.horizontal, 6)
            .frame(minHeight: 56)
            .background(
                LinearGradient(
                    colors: [Color(red: 1, green: 0.60, blue: 0.34), .white],
                    startPoint: .leading,
                    endPoint: .trailing
                ),
                in: RoundedRectangle(cornerRadius: 14, style: .continuous)
            )
            .accessibilityLabel("Color temperature")
            .accessibilityValue(TemperatureFormatter.accessibilityValue(for: value))
            .accessibilityIdentifier("temperatureSlider")

            HStack {
                Text("Warm −100%")
                Spacer()
                Text("Cool +100%")
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
    }
}

struct ErrorBanner: View {
    let message: String
    let canRetryCommand: Bool
    let retry: () -> Void
    let dismiss: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(message, systemImage: "exclamationmark.triangle.fill")
                .foregroundStyle(AppTheme.failure)
            HStack {
                Button(canRetryCommand ? "Retry Command" : "Refresh", action: retry)
                    .buttonStyle(.borderedProminent)
                    .tint(AppTheme.failure)
                Button("Dismiss", action: dismiss)
                    .buttonStyle(.bordered)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .appSurface()
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("errorBanner")
    }
}

import DevicePanelCore
import SwiftUI
import UIKit
import WidgetKit
import XCTest
@testable import DevicePanelWidgetSupport

@MainActor
final class DevicePanelWidgetTests: XCTestCase {
    func testWidgetLoadsSharedStateAndRendersSmallAndMediumFamilies() async throws {
        let preferences = SharedPreferences(suiteName: "WidgetTests.\(UUID().uuidString)")
        let configuration = try ServerConfiguration(urlString: "https://hub.example")
        await preferences.saveServerConfiguration(configuration)
        let state = try RoomState(
            on: true,
            brightness: 75,
            colorTemperaturePct: 50,
            colorMode: .temperature,
            // Whole seconds: the cache stores dates without fractions.
            observedAt: Date(timeIntervalSince1970: 1_800_000_000)
        )
        await preferences.saveSelectedTarget(
            CachedTarget(id: "lamp-a", name: "Lamp A", features: Features(brightness: true, colorTemperature: false, color: false), state: state)
        )
        let sessionStore = InMemorySessionStore(session: Session(token: "widget-test-token"))
        let loader = LiveWidgetStateLoader(
            configuration: configuration,
            preferences: preferences,
            sessionStore: sessionStore
        )

        let entry = await loader.load()

        XCTAssertTrue(entry.isAuthenticated)
        XCTAssertEqual(entry.name, "Lamp A")
        XCTAssertTrue(entry.features.brightness)
        XCTAssertEqual(entry.state, state)
        XCTAssertNotNil(render(entry: entry, family: .systemSmall, size: CGSize(width: 170, height: 170)))
        XCTAssertNotNil(render(entry: entry, family: .systemMedium, size: CGSize(width: 364, height: 170)))
    }

    func testWidgetShowsSignedOutWithoutSession() async {
        let loader = LiveWidgetStateLoader(
            configuration: try! ServerConfiguration(urlString: "https://hub.example"),
            preferences: SharedPreferences(suiteName: "WidgetTests.\(UUID().uuidString)"),
            sessionStore: InMemorySessionStore()
        )

        let entry = await loader.load()

        XCTAssertFalse(entry.isAuthenticated)
        XCTAssertNil(entry.state)
        XCTAssertNotNil(render(entry: entry, family: .systemSmall, size: CGSize(width: 170, height: 170)))
    }

    func testWidgetDoesNotShowCachedDevicesFromAnotherHub() async throws {
        let preferences = SharedPreferences(suiteName: "WidgetTests.\(UUID().uuidString)")
        await preferences.saveServerConfiguration(try ServerConfiguration(urlString: "https://old-hub.example"))
        await preferences.saveSelectedTarget(CachedTarget(
            id: "old-room", name: "Old Room", features: .powerOnly,
            state: RoomState(light: try LightState(on: true, brightness: 50, colorTemperaturePct: 50))
        ))
        let loader = LiveWidgetStateLoader(
            configuration: try ServerConfiguration(urlString: "https://hub.example"),
            preferences: preferences,
            sessionStore: InMemorySessionStore(session: Session(token: "old-hub-token"))
        )

        let entry = await loader.load()

        XCTAssertFalse(entry.isAuthenticated)
        XCTAssertNil(entry.state)
        XCTAssertEqual(entry.name, "Lights")
    }

    private func render(
        entry: LivingRoomEntry,
        family: WidgetFamily,
        size: CGSize
    ) -> UIImage? {
        let content = LivingRoomWidgetContent(entry: entry, familyOverride: family)
            .frame(width: size.width, height: size.height)
        let renderer = ImageRenderer(content: content)
        renderer.scale = 2
        return renderer.uiImage
    }
}

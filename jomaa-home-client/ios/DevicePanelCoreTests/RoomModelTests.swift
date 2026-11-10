import Foundation
import XCTest
@testable import DevicePanelCore

final class RoomModelTests: XCTestCase {
    func testAcceptsHttpsAnywhereAndHttpOnlyOnTheHomeNetwork() throws {
        for address in [
            "https://home.example.com",
            "http://192.168.1.10:8080",
            "http://10.0.0.5",
            "http://172.20.1.1",
            "http://127.0.0.1:8797/",
            "http://hub.local:8080",
            "http://hub",
            "http://[::1]:8080",
        ] {
            XCTAssertNoThrow(try ServerConfiguration(urlString: address), address)
        }
        for address in [
            "http://home.example.com",
            "http://8.8.8.8",
            "http://172.32.0.1",
            "ftp://192.168.1.10",
            "https://user:pass@home.example.com",
            "https://home.example.com/panel",
            "https://home.example.com?x=1",
            "not a url",
        ] {
            XCTAssertThrowsError(try ServerConfiguration(urlString: address), address)
        }
    }

    func testNormalizesTheServerAddress() throws {
        let configuration = try ServerConfiguration(urlString: "  HTTP://192.168.1.10:8080/  ")
        XCTAssertEqual(configuration.baseURL.absoluteString, "http://192.168.1.10:8080")
        XCTAssertEqual(configuration.label, "192.168.1.10:8080")
    }

    func testRequiresAtLeastOneCommandChange() {
        XCTAssertThrowsError(try RoomChanges()) { error in
            XCTAssertEqual(error as? RoomModelError, .emptyChanges)
        }
    }

    func testRejectsInvalidCommands() {
        XCTAssertThrowsError(try RoomChanges(brightness: 0)) { error in
            XCTAssertEqual(error as? RoomModelError, .invalidBrightness(0))
        }
        XCTAssertThrowsError(try RoomChanges(colorTemperaturePct: 101)) { error in
            XCTAssertEqual(error as? RoomModelError, .invalidColorTemperature(101))
        }
        XCTAssertThrowsError(try RoomChanges(colorTemperaturePct: 20, color: .red)) { error in
            XCTAssertEqual(error as? RoomModelError, .colorAndTemperature)
        }
    }

    func testCommandLeavesOutUnchangedFields() throws {
        let clientID = UUID()
        let command = HubCommand(changes: try RoomChanges(brightness: 75), clientId: clientID, revision: 9)

        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(command)) as? [String: Any])

        XCTAssertEqual(Set(json.keys), ["brightness", "clientId", "revision"])
        XCTAssertEqual(json["brightness"] as? Int, 75)
        XCTAssertEqual(json["clientId"] as? String, clientID.uuidString)
    }

    func testColorAndWhiteSwitchTheColorMode() throws {
        let state = RoomState(light: try LightState(on: true, brightness: 50, colorTemperaturePct: 50))
        XCTAssertEqual(state.colorMode, .unknown)

        let red = try state.applying(RoomChanges(color: .red))
        XCTAssertEqual(red.colorMode, .red)
        let dimmed = try red.applying(RoomChanges(brightness: 10))
        XCTAssertEqual(dimmed.colorMode, .red)
        let white = try dimmed.applying(RoomChanges(colorTemperaturePct: 20))
        XCTAssertEqual(white.colorMode, .temperature)
        XCTAssertEqual(white.colorTemperaturePct, 20)
    }

    func testCachedStateKeepsItsColorMode() throws {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let state = try RoomState(
            on: true,
            brightness: 34,
            colorTemperaturePct: 50,
            colorMode: .orange,
            observedAt: Date(timeIntervalSince1970: 1_800_000_000)
        )

        XCTAssertEqual(try decoder.decode(RoomState.self, from: encoder.encode(state)), state)
    }

    func testRejectsCachedStateWithoutAColorMode() {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let data = Data(#"{"on":true,"brightness":34,"colorTemperaturePct":50,"observedAt":"2026-10-07T20:00:00Z"}"#.utf8)

        XCTAssertThrowsError(try decoder.decode(RoomState.self, from: data))
    }

    func testChecksMatterSetupCodes() {
        XCTAssertEqual(MatterSetupCode.normalize(" 3497-011-2332 "), "34970112332")
        XCTAssertEqual(MatterSetupCode.normalize("MT:Y.K9042C00KA0648G00"), "MT:Y.K9042C00KA0648G00")
        XCTAssertNil(MatterSetupCode.normalize("MT:"))
        XCTAssertNil(MatterSetupCode.normalize("1234"))
        XCTAssertNil(MatterSetupCode.normalize("3497011233a"))
    }

    func testFormatsTemperatureForDisplayAndAccessibility() {
        XCTAssertEqual(TemperatureFormatter.signedPercentage(for: 0), "-100%")
        XCTAssertEqual(TemperatureFormatter.signedPercentage(for: 50), "0%")
        XCTAssertEqual(TemperatureFormatter.signedPercentage(for: 100), "+100%")
        XCTAssertEqual(TemperatureFormatter.accessibilityValue(for: 25), "50 percent warm")
        XCTAssertEqual(TemperatureFormatter.accessibilityValue(for: 50), "neutral")
        XCTAssertEqual(TemperatureFormatter.accessibilityValue(for: 75), "50 percent cool")
    }
}

import UIKit
import XCTest

/// Runs against the real hub and a fake Govee cloud. Start them first with:
///     python3 jomaa-home-client/scripts/test_hub.py
/// Both lamps start on at 50% in the Living Room.
@MainActor
final class DevicePanelUITests: XCTestCase {
    private let hub = "http://127.0.0.1:8797"
    private let fakeGovee = "http://127.0.0.1:8798"

    func testRoomControlsReachEveryLampAndFailuresRollBack() async throws {
        try await resetLamps()
        let app = launchAndSignIn()
        defer { app.terminate() }

        let power = app.buttons["powerControl"]
        waitForPower(on: true, in: "Living Room", app: app)
        power.tap()
        try await waitForLamps { $0["powerSwitch"] == 0 }
        waitForPower(on: false, in: "Living Room", app: app)
        power.tap()
        try await waitForLamps { $0["powerSwitch"] == 1 }

        let brightness75 = app.buttons["brightness75"]
        brightness75.tap()
        try await waitForLamps { $0["brightness"] == 75 }
        waitForValue("Selected", element: brightness75)

        let orange = app.buttons["colorOrange"]
        orange.tap()
        try await waitForLamps { $0["colorRgb"] == 0xFF8000 }
        waitForValue("Selected", element: orange)

        let temperature = app.sliders["temperatureSlider"]
        if !temperature.isHittable { app.swipeUp() }
        temperature.adjust(toNormalizedSliderPosition: 0.25)
        try await waitForRequest { $0["instance"] as? String == "colorTemperatureK" }
        attach(app, name: "Living Room controls")

        // Scroll back first: a pull-to-refresh after failures are on would
        // show the error for the wrong reason.
        if !power.isHittable { app.swipeDown() }
        try await fake("/__fake/fail", body: ["enabled": true])
        power.tap()
        let banner = app.descendants(matching: .any)["errorBanner"]
        XCTAssertTrue(banner.waitForExistence(timeout: 10))
        waitForPower(on: true, in: "Living Room", app: app)
        attach(app, name: "Failed command rolled back")

        try await fake("/__fake/fail", body: ["enabled": false])
        let retry = app.buttons["Retry Command"]
        if !retry.isHittable { app.swipeUp() }
        retry.tap()
        try await waitForLamps { $0["powerSwitch"] == 0 }
        waitForPower(on: false, in: "Living Room", app: app)
    }

    func testSingleLampCommandOnlyChangesThatLamp() async throws {
        try await resetLamps()
        let app = launchAndSignIn()
        defer { app.terminate() }

        app.buttons["target-lamp-a"].tap()
        XCTAssertTrue(app.navigationBars["Lamp A"].waitForExistence(timeout: 10))
        waitForPower(on: true, in: "Lamp A", app: app)

        app.buttons["brightness10"].tap()
        try await waitFor("Lamp A at 10% and Lamp B still at 50%") {
            let lamps = try await self.lamps()
            return lamps["AA"]?["brightness"] == 10 && lamps["BB"]?["brightness"] == 50
        }
        attach(app, name: "Single lamp")
    }

    func testPowerRemainsReadableAndOperableAtLargestTextSize() async throws {
        try await resetLamps()
        let app = makeApp()
        app.launchArguments += ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]
        app.launch()
        defer { app.terminate() }

        signIn(app, password: "device-panel-test")
        XCTAssertTrue(
            app.navigationBars["Living Room"].waitForExistence(timeout: 15),
            "Sign-in didn't reach the Living Room. Screen:\n\(app.debugDescription)"
        )
        waitForPower(on: true, in: "Living Room", app: app)

        let power = app.buttons["powerControl"]
        reveal(power, in: app)
        let title = power.staticTexts["Power"]
        XCTAssertTrue(title.exists)
        let traits = UITraitCollection(preferredContentSizeCategory: .accessibilityExtraExtraExtraLarge)
        let lineHeight = UIFont.preferredFont(forTextStyle: .headline, compatibleWith: traits).lineHeight
        let defaultTraits = UITraitCollection(preferredContentSizeCategory: .large)
        let defaultLineHeight = UIFont.preferredFont(forTextStyle: .headline, compatibleWith: defaultTraits).lineHeight
        XCTAssertGreaterThan(title.frame.height, defaultLineHeight * 1.5, "The test must actually use enlarged text")
        XCTAssertLessThanOrEqual(title.frame.height, lineHeight + 2, "Power should fit on one line at the largest text size")
        attach(app, name: "Largest text power control")

        power.tap()
        try await waitForLamps { $0["powerSwitch"] == 0 }
        waitForPower(on: false, in: "Living Room", app: app)
    }

    func testMatterPairingExplainsAMissingMatterServer() async throws {
        try await resetLamps()
        let app = launchAndSignIn()
        defer { app.terminate() }

        app.buttons["addMatterDeviceButton"].tap()
        XCTAssertTrue(app.navigationBars["Matter Devices"].waitForExistence(timeout: 5))
        XCTAssertTrue(
            app.staticTexts["The hub isn't connected to its Matter server."].waitForExistence(timeout: 10),
            "Expected the missing Matter server message. Screen:\n\(app.debugDescription)"
        )
        attach(app, name: "Matter pairing")
    }

    func testIncorrectPasswordStaysSignedOut() {
        continueAfterFailure = false
        let app = makeApp()
        defer { app.terminate() }
        app.launch()

        XCTAssertTrue(app.textFields["serverURLField"].waitForExistence(timeout: 10))
        attach(app, name: "Sign-in placeholders")

        signIn(app, password: "wrong-password")

        let error = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label BEGINSWITH %@", "Sign-in error:"))
            .firstMatch
        XCTAssertTrue(error.waitForExistence(timeout: 20), "No sign-in error shown. Screen:\n\(app.debugDescription)")
        XCTAssertEqual(error.label, "Sign-in error: Incorrect password.")
        XCTAssertFalse(app.navigationBars["Living Room"].exists)
    }

    // MARK: - Helpers

    private func resetLamps() async throws {
        continueAfterFailure = false
        try await fake("/__fake/fail", body: ["enabled": false])
        try await fake("/__fake/reset", body: [:])
    }

    private func makeApp() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-ui-testing-reset"]
        return app
    }

    private func launchAndSignIn() -> XCUIApplication {
        let app = makeApp()
        app.launch()
        signIn(app, password: "device-panel-test")
        XCTAssertTrue(
            app.navigationBars["Living Room"].waitForExistence(timeout: 15),
            "Sign-in didn't reach the Living Room. Screen:\n\(app.debugDescription)"
        )
        XCTAssertTrue(app.descendants(matching: .any)["connectionStatus"].waitForExistence(timeout: 5))
        return app
    }

    private func signIn(_ app: XCUIApplication, password: String) {
        let serverField = app.textFields["serverURLField"]
        XCTAssertTrue(serverField.waitForExistence(timeout: 10))
        reveal(serverField, in: app)
        serverField.tap()
        serverField.typeText(hub)
        app.keyboards.descendants(matching: .any)
            .matching(NSPredicate(format: "label ==[c] %@", "next")).firstMatch.tap()
        let passwordField = app.secureTextFields["passwordField"]
        reveal(passwordField, in: app)
        passwordField.tap()
        passwordField.typeText(password)
        let signInButton = app.buttons["signInButton"]
        let enabled = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: signInButton)
        XCTAssertEqual(XCTWaiter.wait(for: [enabled], timeout: 5), .completed, "Both credentials must be entered before submitting")
        app.keyboards.descendants(matching: .any)
            .matching(NSPredicate(format: "label ==[c] %@", "go")).firstMatch.tap()
    }

    private func reveal(_ element: XCUIElement, in app: XCUIApplication) {
        for _ in 0 ..< 6 {
            if element.isHittable { return }
            app.scrollViews.firstMatch.swipeUp()
        }
        XCTAssertTrue(element.isHittable, "Expected \(element) to be reachable by scrolling")
    }

    private func waitForPower(on: Bool, in name: String, app: XCUIApplication) {
        let label = "\(name) is \(on ? "on" : "off")"
        XCTAssertTrue(app.staticTexts[label].waitForExistence(timeout: 10), "Expected \(label)")
    }

    private func waitForValue(_ value: String, element: XCUIElement, file: StaticString = #filePath, line: UInt = #line) {
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", value), object: element)
        XCTAssertEqual(XCTWaiter.wait(for: [expectation], timeout: 10), .completed, file: file, line: line)
    }

    private func waitForLamps(_ condition: ([String: Int]) -> Bool) async throws {
        try await waitFor("both lamps to match") {
            let lamps = try await self.lamps()
            return lamps.count == 2 && lamps.values.allSatisfy(condition)
        }
    }

    private func waitForRequest(_ condition: ([String: Any]) -> Bool) async throws {
        try await waitFor("a matching Govee request") {
            let (data, _) = try await URLSession.shared.data(from: URL(string: self.fakeGovee + "/__fake/requests")!)
            let requests = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] ?? []
            return requests.contains(where: condition)
        }
    }

    private func waitFor(_ what: String, _ condition: () async throws -> Bool) async throws {
        for _ in 0 ..< 100 {
            if try await condition() { return }
            try await Task.sleep(for: .milliseconds(100))
        }
        XCTFail("Timed out waiting for \(what): \(try await lamps())")
    }

    private func lamps() async throws -> [String: [String: Int]] {
        try await fake("/__fake/state")["devices"] as? [String: [String: Int]] ?? [:]
    }

    @discardableResult
    private func fake(_ path: String, body: [String: Any]? = nil) async throws -> [String: Any] {
        var request = URLRequest(url: URL(string: fakeGovee + path)!)
        if let body {
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, _) = try await URLSession.shared.data(for: request)
        return try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
    }

    private func attach(_ app: XCUIApplication, name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}

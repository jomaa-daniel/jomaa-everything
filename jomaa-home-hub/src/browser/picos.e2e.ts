import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { Accounts } from "../accounts.js";
import { Clicks } from "../clicks.js";
import { Api } from "../api.js";
import { HealthStore } from "../health/store.js";
import { Hub } from "../hub.js";
import { Organization } from "../organization.js";
import { silentLog } from "../log.js";
import type { MatterAdmin } from "../matter/nodes.js";
import { ImageCommand, imageSettings, PicoRuns, type PicoImager } from "../picos.js";
import { serve } from "../testing.js";

const matter: MatterAdmin = {
  ready: false,
  nodes: () => [],
  discover: () => Promise.resolve([]),
  register: () => Promise.reject(new Error("unused")),
  rename: () => Promise.reject(new Error("unused")),
  commission: () => Promise.reject(new Error("unused")),
  setWiFiCredentials: () => Promise.resolve(),
  setThreadDataset: () => Promise.resolve(),
  removeNode: () => Promise.resolve(),
};

await test("USB Pico split view selects image functions, confirms erasure, resumes a run and renders results on desktop and mobile", async () => {
  const settings = { ...imageSettings(), pollMilliseconds: 30 };
  const catalog = await new ImageCommand(settings).catalog();
  const target = {
    id: "runtime-fixture",
    name: "Jerry USB Pico",
    uniqueId: "5303284720e42a9c",
    mode: "runtime" as const,
    description: "MicroPython over USB",
    available: true,
    unavailableReason: null,
    latestRunId: null,
  };
  let finish: () => void = () => {
    throw new Error("No active image");
  };
  let flashes = 0;
  let selected: string[] = [];
  let events: unknown[] = [];
  const imager: PicoImager = {
    discover: () => Promise.resolve([target]),
    catalog: () => Promise.resolve(catalog),
    flash: async (_id, request, emit) => {
      flashes++;
      selected = request.features;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      for (const event of events) emit(event);
    },
  };
  const store = new HealthStore(":memory:");
  const accounts = new Accounts(":memory:");
  const clicks = new Clicks(":memory:");
  const organization = new Organization(":memory:");
  const password = "pico browser owner password";
  store.enroll({ id: "existing-health", name: "Existing device" });
  const runs = new PicoRuns(imager, settings, null);
  const origin = await serve(
    new Api(new Hub(), matter, password, accounts, clicks, silentLog, {
      health: store,
      layoutPath: null,
      organization,
      secrets: null,
      picos: runs,
    }).handle,
  );
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(origin + "/manage");
    assert.equal(await page.title(), "Devices · Jomaa Home");
    assert.ok(await page.locator("#usb-picos").isHidden());
    await page.locator("#password").fill(password);
    await page.locator("#login-form button").click();
    await page.getByRole("button", { name: /Jerry USB Pico/ }).waitFor();
    assert.match((await page.locator("#assignment-rows").textContent()) ?? "", /Existing device/);
    const inventoryBox = await page.locator("#device-workspace").boundingBox();
    const cardBox = await page.locator("#usb-picos").boundingBox();
    assert.ok(inventoryBox && cardBox && cardBox.y >= inventoryBox.y + inventoryBox.height);
    await page.getByRole("button", { name: /Jerry USB Pico/ }).click();
    const panel = page.locator("#pico-panel");
    await page.getByRole("checkbox", { name: /Health check/ }).waitFor();
    const listBox = await page.locator(".pico-card").boundingBox();
    const box = await panel.boundingBox();
    assert.ok(listBox && box);
    assert.ok(Math.abs(box.y - listBox.y) < 2 && box.x >= listBox.x + listBox.width);
    assert.ok(box.x + box.width <= 1280);
    assert.equal(await page.locator("dialog[open]").count(), 0);
    assert.ok(await page.locator("#pico-panel-title:focus").isVisible());
    assert.equal(await page.getByRole("button", { name: /Jerry USB Pico/ }).getAttribute("aria-pressed"), "true");
    assert.ok(await page.locator("#pico-flash").isDisabled());
    await page.getByRole("checkbox", { name: /I²C raw logging/ }).check();
    await page.getByRole("checkbox", { name: /PWM fan control/ }).check();
    assert.ok(await page.getByRole("checkbox", { name: /Health check/ }).isChecked());
    assert.ok(await page.getByRole("checkbox", { name: /^Wi-Fi/ }).isChecked());
    assert.equal(await page.locator("#pico-radio").inputValue(), catalog.defaultWifiTransport);
    await page.getByRole("checkbox", { name: /^Wi-Fi/ }).uncheck();
    assert.ok(!(await page.getByRole("checkbox", { name: /Health check/ }).isChecked()));
    assert.ok(!(await page.getByRole("checkbox", { name: /I²C raw logging/ }).isChecked()));
    assert.ok(!(await page.getByRole("checkbox", { name: /PWM fan control/ }).isChecked()));
    await page.getByRole("checkbox", { name: /Temperature reading/ }).check();
    page.once("dialog", (dialog) => {
      void dialog.dismiss();
    });
    await page.locator("#pico-flash").click();
    assert.equal(flashes, 0);
    page.once("dialog", (dialog) => {
      assert.match(dialog.message(), /erases every file/);
      void dialog.accept();
    });
    await page.locator("#pico-flash").click();
    await page.locator("#pico-run-status", { hasText: "Imaging in progress" }).waitFor();
    assert.deepEqual(selected, ["temperature"]);
    assert.equal(flashes, 1);
    assert.ok(await page.getByRole("checkbox", { name: /Temperature reading/ }).isDisabled());
    await page.locator("#pico-close").click();
    await page.getByRole("button", { name: /Jerry USB Pico/ }).click();
    await page.locator("#pico-run-status", { hasText: "Imaging in progress" }).waitFor();
    assert.equal(flashes, 1);
    events = [
      {
        type: "check",
        check: { feature: "temperature", status: "passed", message: "Observed Celsius", evidence: { celsius: 24.5 } },
      },
      { type: "result", status: "passed", message: "Startup and selected functionality verified" },
    ];
    finish();
    await page.locator("#pico-run-status.success").waitFor();
    assert.match((await page.locator("#pico-checks").textContent()) ?? "", /24.5/);
    await page.screenshot({ path: "/tmp/jomaa-picos-desktop.png", fullPage: false });
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileBox = await panel.boundingBox();
    const mobileListBox = await page.locator(".pico-card").boundingBox();
    assert.ok(mobileBox && mobileListBox && mobileBox.x >= 0 && mobileBox.x + mobileBox.width <= 390);
    assert.ok(mobileBox.y >= mobileListBox.y + mobileListBox.height);
    assert.ok(await page.locator("#pico-close").isVisible());
    await page.screenshot({ path: "/tmp/jomaa-picos-mobile.png", fullPage: false });
    await page.keyboard.press("Escape");
    assert.ok(await panel.isHidden());
    assert.equal(await page.locator(".pico-target:focus").getAttribute("data-target-id"), target.id);
    assert.equal(await page.getByRole("button", { name: /Jerry USB Pico/ }).getAttribute("aria-pressed"), "false");
    await page.getByRole("button", { name: /Jerry USB Pico/ }).click();
    await page.locator("#pico-run-status.success").waitFor();
    await page.getByRole("checkbox", { name: /Temperature reading/ }).uncheck();
    await page.getByRole("checkbox", { name: /PWM fan control/ }).check();
    assert.ok(await page.getByRole("checkbox", { name: /Health check/ }).isChecked());
    assert.ok(await page.getByRole("checkbox", { name: /^Wi-Fi/ }).isChecked());
    await page.locator("#pico-ssid").fill("test-network");
    await page.locator("#pico-password").fill("private-fixture");
    page.once("dialog", (dialog) => {
      void dialog.accept();
    });
    await page.locator("#pico-flash").click();
    await page.locator("#pico-run-status", { hasText: "Imaging in progress" }).waitFor();
    assert.deepEqual(selected, ["health", "wifi", "fan"]);
    events = [
      {
        type: "check",
        check: {
          feature: "health",
          status: "passed",
          message: "Persisted",
          evidence: { deviceId: "pico-fan", bootId: "a".repeat(16), reports: 3 },
        },
      },
      {
        type: "check",
        check: {
          feature: "wifi",
          status: "passed",
          message: "Connected",
          evidence: { transport: catalog.defaultWifiTransport, ip: "192.0.2.1" },
        },
      },
      {
        type: "check",
        check: {
          feature: "fan",
          status: "passed",
          message: "PWM acknowledged",
          evidence: {
            deviceId: "pico-fan",
            bootId: "a".repeat(16),
            gpio: 15,
            frequencyHz: 25000,
            percentCurrent: 50,
            appliedRevision: 3,
          },
        },
      },
      { type: "result", status: "passed", message: "Fan image verified" },
    ];
    finish();
    await page.locator("#pico-run-status.success").waitFor();
    assert.match((await page.locator("#pico-checks").textContent()) ?? "", /GP15 · 25000 Hz · 50% PWM · revision 3/);
    await page.screenshot({ path: "/tmp/jomaa-fan-mobile.png", fullPage: false });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: "/tmp/jomaa-fan-desktop.png", fullPage: false });
    await page.locator("#pico-close").click();
    await page.locator("#logout").click();
    await page.locator("#usb-picos").waitFor({ state: "hidden" });
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    store.close();
    accounts.close();
    clicks.close();
    organization.close();
  }
});

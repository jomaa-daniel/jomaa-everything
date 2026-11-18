import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { Accounts } from "../accounts.js";
import { Clicks } from "../clicks.js";
import { Api } from "../api.js";
import { HealthStore } from "../health/store.js";
import { Hub } from "../hub.js";
import { silentLog } from "../log.js";
import type { MatterAdmin } from "../matter/nodes.js";
import { Organization } from "../organization.js";
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

await test("device details show live raw captures, condensed idle spans, pause, reconnect and device isolation", async () => {
  const store = new HealthStore(":memory:");
  const accounts = new Accounts(":memory:");
  const password = "i2c browser owner password";
  store.enroll({ id: "pico-test", name: "Stream Pico" });
  store.enroll({ id: "pico-other", name: "Other Pico" });
  const organization = new Organization(":memory:");
  const origin = await serve(
    new Api(new Hub(), matter, password, accounts, new Clicks(":memory:"), silentLog, {
      health: store,
      layoutPath: null,
      organization,
      secrets: null,
      picos: null,
    }).handle,
  );
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(origin + "/manage");
    assert.equal(await page.title(), "Devices · Jomaa Home");
    await page.locator("#password").fill(password);
    await page.locator("#login-form button").click();
    await page.getByRole("button", { name: "Edit Stream Pico", exact: true }).click();
    await page.locator("#i2c-section summary").click();
    await page.locator("#i2c-status", { hasText: "Live" }).waitFor();
    const empty = { bootId: "abcdef0123456789", sequence: 0, bus: 0, startUs: 0, endUs: 1000000, data: "", dropped: 0 };
    store.i2c.record("pico-test", empty);
    await page.locator("#i2c-live", { hasText: "EMPTY × 1" }).waitFor();
    store.i2c.record("pico-test", { ...empty, sequence: 1, startUs: 1000000, endUs: 2000000 });
    await page.locator("#i2c-live", { hasText: "EMPTY × 2" }).waitFor();
    assert.equal(await page.locator(".i2c-entry").count(), 1);
    store.i2c.record("pico-test", { ...empty, sequence: 2, startUs: 2000000, endUs: 3000000, data: "a632001122" });
    await page.locator("#i2c-live", { hasText: "A6 32 00 11 22" }).waitFor();
    await page.locator("#i2c-pause").click();
    store.i2c.record("pico-test", {
      ...empty,
      sequence: 3,
      startUs: 3000000,
      endUs: 4000000,
      data: "ffeedd",
      dropped: 7,
    });
    assert.ok(!(await page.locator("#i2c-live").textContent())?.includes("FF EE DD"));
    await page.locator("#i2c-pause").click();
    await page.locator("#i2c-live", { hasText: "FF EE DD" }).waitFor();
    await page.locator("#i2c-live", { hasText: "7 capture units lost" }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.locator("#i2c-pause").isVisible());
    await page.locator("#editor-back").click();
    await page.getByRole("button", { name: "Edit Other Pico", exact: true }).click();
    await page.locator("#i2c-section summary").click();
    await page.locator("#i2c-status", { hasText: "Live" }).waitFor();
    await page.locator("#i2c-empty").waitFor();
    assert.equal(await page.locator(".i2c-entry").count(), 0);
    await page.locator("#editor-back").click();
    assert.ok(await page.locator("#device-editor").isHidden());
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    store.close();
    accounts.close();
    organization.close();
  }
});

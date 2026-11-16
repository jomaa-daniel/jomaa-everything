import assert from "node:assert/strict";
import { isFocused } from "./dom.js";
import { after, test } from "node:test";
import { chromium } from "playwright-core";
import { Accounts } from "../accounts.js";
import { Clicks } from "../clicks.js";
import { hubApi } from "../hub-api.js";
import { HealthStore } from "../health/store.js";
import { Hub } from "../hub.js";
import { silentLog } from "../log.js";
import { settings } from "../settings.js";
import type { MatterAdmin } from "../matter/nodes.js";
import { Organization } from "../organization.js";
import { serve } from "../testing.js";

const password = "navigation browser owner password";
const accounts = new Accounts(":memory:", settings.accounts);
const health = new HealthStore(":memory:", settings.i2c);
const organization = new Organization(":memory:");
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
health.enroll({ id: "pico-a", name: "First Pico" });
health.enroll({ id: "pico-b", name: "Second Pico" });
for (const name of ["alpha", "beta"]) {
  await accounts.join(accounts.createInvite().token, name, password);
}
accounts.setScopes("alpha", ["devices"]);
const origin = await serve(
  hubApi({
    hub: new Hub(),
    matter,
    password,
    accounts,
    prefetch: { clicks: new Clicks(":memory:"), settings: settings.prefetch },
    log: silentLog,
    health: { store: health, i2c: settings.i2c, page: settings.health },
    layoutPath: null,
    organization,
    secrets: null,
    tailscale: null,
  }).handle,
);
const browser = await chromium.launch({ channel: "chrome", headless: true });
after(async () => {
  await browser.close();
  health.close();
  organization.close();
  accounts.close();
});

async function pageAt(path: string, owner = true) {
  const context = await browser.newContext();
  if (owner) assert.equal((await context.request.post(origin + "/api/login", { data: { password } })).status(), 200);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin + path);
  after(async () => {
    assert.deepEqual(errors, []);
    await context.close();
  });
  return page;
}

test("Home arrows navigate links, stop at boundaries, and Tab leaves the group", async () => {
  const page = await pageAt("/home");
  const links = page.locator(".home-links a");
  await links.first().focus();
  await page.keyboard.press("ArrowDown");
  assert.ok(await links.nth(1).evaluate(isFocused));
  await page.keyboard.press("End");
  assert.ok(await links.last().evaluate(isFocused));
  await page.keyboard.press("ArrowDown");
  assert.ok(await links.last().evaluate(isFocused));
  await page.keyboard.press("Home");
  assert.ok(await links.first().evaluate(isFocused));
  await page.keyboard.press("Tab");
  assert.ok(!(await links.first().evaluate(isFocused)));
});

test("Permission grid arrows move between accounts and scopes without granting access", async () => {
  const page = await pageAt("/permissions");
  const first = page.getByLabel("alpha can open Lights");
  await first.waitFor();
  await first.focus();
  await page.keyboard.press("ArrowRight");
  assert.ok(await page.getByLabel("alpha can open Device health").evaluate(isFocused));
  await page.keyboard.press("ArrowDown");
  assert.ok(await page.getByLabel("beta can open Device health").evaluate(isFocused));
  assert.deepEqual(accounts.account("alpha")?.scopes, ["devices"]);
  assert.deepEqual(accounts.account("beta")?.scopes, []);
  await page.keyboard.press("Space");
  await page.locator("#notice.success").waitFor();
  assert.deepEqual(accounts.account("beta")?.scopes, ["devices"]);
  await page.keyboard.press("ArrowLeft");
  assert.ok(await page.getByLabel("beta can open Lights").evaluate(isFocused));
});

test("health-only accounts use the unified page without organization controls", async () => {
  const page = await pageAt("/manage#health", false);
  await page.locator("#password").fill(password);
  await page.locator("#username").fill("alpha");
  await page.locator("#login-form button").click();
  await page.locator("#inventory:not([hidden])").waitFor();
  assert.ok(await page.locator("#devices-tab").isHidden());
  assert.ok(await page.locator("#types-tab").isHidden());
  const rows = page.locator("#device-rows button");
  await rows.first().focus();
  await page.keyboard.press("ArrowDown");
  assert.ok(await rows.nth(1).evaluate(isFocused));
  assert.ok(await page.locator("#detail").isHidden());
  await page.keyboard.press("Enter");
  await page.locator("#detail:not([hidden])").waitFor();
});

test("text input arrows retain editing, Alt arrows move fields, and modal navigation stays inside", async () => {
  const page = await pageAt("/manage#health");
  await page.locator("#inventory:not([hidden])").waitFor();
  await page.locator("#add").click();
  await page.locator("#manual-enroll").click();
  const name = page.locator("#enroll-name");
  await name.fill("Keyboard Pico");
  await page.keyboard.press("ArrowLeft");
  assert.equal(await name.inputValue(), "Keyboard Pico");
  assert.ok(await name.evaluate(isFocused));
  await page.keyboard.press("Alt+ArrowDown");
  assert.equal(await page.evaluate<string>("document.activeElement?.id"), "enroll-id");
  await page.locator("#cancel-enroll").focus();
  await page.keyboard.press("ArrowRight");
  assert.ok(await page.evaluate<boolean>("document.activeElement.closest('dialog')?.id === 'enroll-dialog'"));
  await page.keyboard.press("Escape");
  assert.ok(await page.locator("#enroll-dialog").isHidden());
});

test("health edits appear in the organization inventory when returning to Devices", async () => {
  const page = await pageAt("/manage#health");
  await page.getByRole("button", { name: "First Pico", exact: true }).click();
  await page.locator("#device-name").fill("Renamed Pico");
  await page.locator("#edit-form button").click();
  await page.getByRole("button", { name: "Renamed Pico", exact: true }).waitFor();
  await page.locator("#devices-tab").click();
  await page.getByRole("button", { name: "Edit Renamed Pico", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Edit First Pico", exact: true }).count(), 0);
});

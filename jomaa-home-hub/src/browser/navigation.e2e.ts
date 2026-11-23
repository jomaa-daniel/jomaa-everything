import { catalog } from "../nodes.js";
import assert from "node:assert/strict";
import { isFocused } from "./dom.js";
import { after, test } from "node:test";
import { chromium } from "playwright-core";
import { Accounts } from "../accounts.js";
import { Api } from "../api.js";
import { Clicks } from "../clicks.js";
import { HealthStore } from "../health/store.js";
import { Hub } from "../hub.js";
import { silentLog } from "../log.js";
import type { MatterAdmin } from "../matter/nodes.js";
import { Organization } from "../organization.js";
import { serve } from "../testing.js";

const password = "navigation browser owner password";
const accounts = new Accounts(":memory:");
const health = new HealthStore(":memory:");
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
accounts.setGrants("alpha", [{ node: catalog.defaultNode, scopes: ["devices"] }]);
const origin = await serve(
  new Api(new Hub(), matter, password, accounts, new Clicks(":memory:"), silentLog, {
    health,
    layoutPath: null,
    organization,
    secrets: null,
    picos: null,
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

test("unified rows navigate without granting access and permissions edit in Details", async (t) => {
  t.after(() => {
    accounts.setGrants("alpha", [{ node: catalog.defaultNode, scopes: ["devices"] }]);
  });
  const page = await pageAt("/accounts");
  const inspectors = page.locator('#entries button[aria-controls="details"]');
  await inspectors.nth(1).waitFor();
  assert.ok(await page.locator("#link-access").isHidden());
  await inspectors.first().focus();
  await page.keyboard.press("ArrowDown");
  assert.ok(await inspectors.nth(1).evaluate(isFocused));
  assert.ok(await page.locator("#details").isHidden(), "arrow navigation does not open an entry");
  assert.deepEqual(accounts.account("alpha")?.grants[0]?.scopes, ["devices"]);
  assert.deepEqual(accounts.account("beta")?.grants, []);
  await page.keyboard.press("Enter");
  const first = page.getByLabel("alpha can open Lights at Home");
  await first.waitFor();
  await first.focus();
  await page.keyboard.press("ArrowDown");
  assert.ok(await page.getByLabel("alpha can open Device health at Home").evaluate(isFocused));
  assert.deepEqual(accounts.account("alpha")?.grants[0]?.scopes, ["devices"]);
  await page.keyboard.press("Space");
  await page.locator("#notice.success").waitFor();
  assert.deepEqual(accounts.account("alpha")?.grants, []);
  await page.locator("#close-details").click();
  assert.ok(await page.locator("#details").isHidden());
});

test("health-only accounts use the unified page without organization controls", async () => {
  const page = await pageAt("/manage", false);
  await page.locator("#password").fill(password);
  await page.locator("#username").fill("alpha");
  await page.locator("#login-form button").click();
  await page.locator("#assignment-rows tr").first().waitFor();
  assert.ok(await page.locator("#devices-tab").isVisible());
  assert.ok(await page.locator("#types-tab").isHidden());
  const rows = page.locator("#assignment-rows button");
  await rows.first().focus();
  await page.keyboard.press("ArrowDown");
  assert.ok(await rows.nth(1).evaluate(isFocused));
  assert.ok(await page.locator("#editor-fields").isHidden());
  await page.keyboard.press("Enter");
  await page.locator("#detail:not([hidden])").waitFor();
  await page.getByRole("button", { name: "Edit Second Pico", exact: true }).click();
  await page.locator("#edit-device-name").click();
  await page.locator("#device-name").fill("Health-only Pico");
  await page.locator("#save-device-name").click();
  await page.getByRole("button", { name: "Edit Health-only Pico", exact: true }).waitFor();
  assert.equal(await page.locator("#selected-name").textContent(), "Health-only Pico");
});

test("text input arrows retain editing, Alt arrows move fields, and modal navigation stays inside", async () => {
  const page = await pageAt("/manage");
  await page.locator("#assignment-rows tr").first().waitFor();
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

test("renaming in Details updates the device inventory immediately", async () => {
  const page = await pageAt("/manage");
  await page.getByRole("button", { name: "Edit First Pico", exact: true }).click();
  await page.locator("#edit-device-name").click();
  await page.locator("#device-name").fill("Renamed Pico");
  await page.locator("#save-device-name").click();
  assert.ok(await page.locator("#devices-panel").isVisible());
  await page.getByRole("button", { name: "Edit Renamed Pico", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Edit First Pico", exact: true }).count(), 0);
});

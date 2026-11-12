// Drives the account pages in Chrome against the real API and built pages:
// the owner invites someone, they create an account through the share link,
// and the owner grants and removes access.
import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { Accounts } from "../accounts.js";
import { Api } from "../api.js";
import { allFeatures, type Command, type Device, type Features, type State } from "../device.js";
import { Group } from "../group.js";
import { HealthStore } from "../health/store.js";
import { Hub } from "../hub.js";
import { silentLog } from "../log.js";
import { MatterNotReadyError, type MatterAdmin } from "../matter/nodes.js";
import { serve } from "../testing.js";

const ownerPassword = "owner password for the browser test";
const guestPassword = "guest password for the browser test";

class Lamp implements Device {
  readonly id = "lamp";
  readonly name = "Lamp";
  current: State = { on: false, brightness: 50, colorTemperaturePct: 50 };

  apply(command: Command): Promise<void> {
    this.current = {
      on: command.on ?? this.current.on,
      brightness: command.brightness ?? this.current.brightness,
      colorTemperaturePct: command.colorTemperaturePct ?? this.current.colorTemperaturePct,
    };
    return Promise.resolve();
  }

  state(): Promise<State> {
    return Promise.resolve({ ...this.current });
  }

  features(): Features {
    return allFeatures;
  }
}

const noMatter: MatterAdmin = {
  ready: false,
  nodes: () => [],
  discover: () => Promise.reject(new MatterNotReadyError()),
  register: () => Promise.reject(new MatterNotReadyError()),
  rename: () => Promise.reject(new MatterNotReadyError()),
  commission: () => Promise.reject(new MatterNotReadyError()),
  setWiFiCredentials: () => Promise.reject(new MatterNotReadyError()),
  setThreadDataset: () => Promise.reject(new MatterNotReadyError()),
  removeNode: () => Promise.reject(new MatterNotReadyError()),
};

const lamp = new Lamp();
const hub = new Hub();
hub.addDevice("test", lamp);
hub.addRoom(new Group("living-room", "Living room", [lamp]));
const api = new Api(hub, noMatter, ownerPassword, new Accounts(":memory:"), silentLog, new HealthStore(":memory:"));
const origin = await serve(api.handle);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const owner = await browser.newContext();
const guest = await browser.newContext();
const scriptErrors: string[] = [];

async function open(context: BrowserContext, path: string): Promise<Page> {
  const page = await context.newPage();
  page.on("pageerror", (error) => scriptErrors.push(`${path}: ${error.message}`));
  await page.goto(origin + path);
  return page;
}

async function signInAsOwner(page: Page): Promise<void> {
  await page.locator("#password").fill(ownerPassword);
  await page.locator("#login-form button").click();
  await page.locator("#content").waitFor();
}

let inviteLink = "";

await test("the owner signs in and creates an invite link", async () => {
  const permissions = await open(owner, "/permissions");
  await signInAsOwner(permissions);
  await permissions.locator("#accounts-empty").waitFor();
  await permissions.close();

  const invite = await open(owner, "/invite");
  await invite.locator("#content").waitFor();
  await invite.locator("#create").click();
  await invite.locator("#invites li").waitFor();
  inviteLink = await invite.locator("#link").inputValue();
  assert.match(inviteLink, new RegExp(`^${origin}/join#[\\w-]{43}$`));
  assert.ok(await invite.locator("#copy").isEnabled());
  await invite.close();
});

await test("the share link creates an account with a username and password", async () => {
  const join = await open(guest, inviteLink.slice(origin.length));
  await join.locator("#join-form").waitFor();
  assert.equal(new URL(join.url()).hash, "", "the token leaves the address bar");

  await join.locator("#username").fill("Sarah");
  assert.equal(await join.locator("#username").inputValue(), "sarah", "usernames are lowercase");
  await join.locator("#password").fill(guestPassword);
  await join.locator("#confirm").fill("a different password");
  await join.locator("#join-form button").click();
  assert.ok(await join.locator("#join-form").isVisible(), "mismatched passwords keep the form open");

  await join.locator("#confirm").fill(guestPassword);
  await join.locator("#join-form button").click();
  await join.locator("#done").waitFor();
  assert.equal(await join.locator("#done-username").textContent(), "sarah");

  await join.goto(inviteLink);
  await join.locator("#invalid").waitFor();
  await join.close();
});

await test("a new account signs in but can't open any page", async () => {
  const lights = await open(guest, "/lights");
  await lights.locator("#login-section").waitFor();
  await lights.locator("#username").fill("sarah");
  await lights.locator("#password").fill(guestPassword);
  await lights.locator("#login-form button.primary").click();
  await lights.locator("#login-message", { hasText: "does not have access to Lights" }).waitFor();
  assert.ok(await lights.locator("#login-section").isVisible(), "the panel offers sign-in as someone else");
  await lights.close();

  for (const [path, page] of [
    ["/devices", "Device health"],
    ["/manage", "Device organization"],
  ] as const) {
    const tab = await open(guest, path);
    await tab.locator("#notice", { hasText: `does not have access to ${page}` }).waitFor();
    assert.ok(await tab.locator("#login-section").isVisible(), `${path} offers sign-in as someone else`);
    await tab.close();
  }

  for (const path of ["/permissions", "/invite"]) {
    const tab = await open(guest, path);
    await tab.locator("#not-owner").waitFor();
    assert.ok(!(await tab.locator("#content").isVisible()), `${path} hides owner controls`);
    await tab.close();
  }
});

await test("the owner grants Lights and the account controls the room", async () => {
  const permissions = await open(owner, "/permissions");
  await permissions.getByLabel("sarah can open Lights").check();
  await permissions.locator("#notice", { hasText: "Saved sarah" }).waitFor();
  await permissions.reload();
  assert.ok(await permissions.getByLabel("sarah can open Lights").isChecked(), "the grant was saved");
  assert.ok(!(await permissions.getByLabel("sarah can open Device health").isChecked()));
  await permissions.close();

  const lights = await open(guest, "/lights");
  await lights.locator("#controller").waitFor();
  assert.equal(await lights.locator("#target-title").textContent(), "Living room");
  await lights.locator("#power-toggle").click();
  await lights.locator('#power-toggle[aria-checked="true"]').waitFor();
  assert.equal(lamp.current.on, true, "the command reached the light");

  const devices = await open(guest, "/devices");
  await devices.locator("#notice", { hasText: "does not have access to Device health" }).waitFor();
  await devices.close();

  const revoke = await open(owner, "/permissions");
  await revoke.getByLabel("sarah can open Lights").uncheck();
  await revoke.locator("#notice", { hasText: "Saved sarah" }).waitFor();
  await revoke.close();

  await lights.locator("#power-toggle").click();
  await lights.locator("#login-message", { hasText: "does not have access to Lights" }).waitFor();
  assert.equal(lamp.current.on, true, "the revoked account's command was refused");
  await lights.close();
});

await test("deleting the account signs it out", async () => {
  const permissions = await open(owner, "/permissions");
  permissions.once("dialog", (dialog) => void dialog.accept());
  await permissions.getByRole("button", { name: "Delete account sarah" }).click();
  await permissions.locator("#accounts-empty").waitFor();
  await permissions.close();

  const devices = await open(guest, "/devices");
  await devices.locator("#login-section").waitFor();
  await devices.close();
});

await test("no page threw a script error", () => {
  assert.deepEqual(scriptErrors, []);
});

await browser.close();

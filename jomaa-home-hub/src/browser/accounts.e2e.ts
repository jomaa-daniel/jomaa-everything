// Drives the account pages in Chrome against the real API and built pages:
// the owner invites someone, they create an account through the share link,
// and the owner grants and removes access.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
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
let origin = "";
let browser: Browser;
let owner: BrowserContext;
let guest: BrowserContext;

before(async () => {
  const hub = new Hub();
  hub.addDevice("test", lamp);
  hub.addRoom(new Group("living-room", "Living room", [lamp]));
  const api = new Api(hub, noMatter, ownerPassword, new Accounts(":memory:"), silentLog, new HealthStore(":memory:"));
  origin = await serve(api.handle);
  browser = await chromium.launch({ channel: "chrome", headless: true });
  owner = await browser.newContext();
  guest = await browser.newContext();
});

after(async () => {
  await browser.close();
});

async function open(context: BrowserContext, path: string): Promise<Page> {
  const page = await context.newPage();
  page.on("pageerror", (error) => {
    assert.fail(`script error on ${path}: ${error.message}`);
  });
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
  await invite.locator("#created").waitFor();
  inviteLink = await invite.locator("#link").inputValue();
  assert.match(inviteLink, new RegExp(`^${origin}/join#[\\w-]{43}$`));
  assert.equal(await invite.locator("#invites li").count(), 1, "the new invite is listed as unused");
  await invite.close();
});

await test("the share link walks through creating a username and password", async () => {
  const join = await open(guest, inviteLink.slice(origin.length));
  await join.locator("#step-username").waitFor();
  assert.equal(new URL(join.url()).hash, "", "the token leaves the address bar");

  await join.locator("#username").fill("Sarah");
  await join.locator("#step-username button.primary").click();
  await join.locator("#step-password").waitFor();
  assert.equal(await join.locator("#chosen-username").textContent(), "sarah");

  await join.locator("#password").fill(guestPassword);
  await join.locator("#confirm").fill("a different password");
  await join.locator("#step-password button.primary").click();
  assert.ok(await join.locator("#step-password").isVisible(), "mismatched passwords stay on the password step");

  await join.locator("#confirm").fill(guestPassword);
  await join.locator("#step-password button.primary").click();
  await join.locator("#step-done").waitFor();
  assert.equal(await join.locator("#done-username").textContent(), "sarah");

  await join.goto(inviteLink);
  await join.locator("#invalid").waitFor();
  await join.close();
});

await test("a new account can't open any page", async () => {
  const lights = await open(guest, "/lights");
  await lights.locator("#login-section").waitFor();
  assert.match((await lights.locator("#login-message").textContent()) ?? "", /does not have access to Lights/);
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
    assert.equal(await tab.locator("#not-owner-name").textContent(), "sarah");
    assert.ok(!(await tab.locator("#content").isVisible()), `${path} hides owner controls`);
    await tab.close();
  }
});

await test("the owner grants Lights and the account controls the room", async () => {
  const permissions = await open(owner, "/permissions");
  const box = permissions.getByLabel("sarah can open Lights");
  await box.check();
  await permissions.getByRole("button", { name: "Save permissions for sarah" }).click();
  await permissions.locator("#notice", { hasText: "Saved permissions for sarah" }).waitFor();
  assert.ok(await box.isChecked());
  await permissions.close();

  const lights = await open(guest, "/lights");
  await lights.locator("#controller").waitFor();
  assert.equal(await lights.locator("#target-title").textContent(), "Living room");
  await lights.locator("#power-toggle").click();
  await lights.locator('#power-toggle[aria-checked="true"]').waitFor();
  assert.equal(lamp.current.on, true, "the command reached the light");
  await lights.close();

  const devices = await open(guest, "/devices");
  await devices.locator("#notice", { hasText: "does not have access to Device health" }).waitFor();
  await devices.close();
});

await test("the account signs in with its username on a fresh browser", async () => {
  const fresh = await browser.newContext();
  const lights = await open(fresh, "/lights");
  await lights.locator("#login-section").waitFor();
  await lights.locator("#username").fill("sarah");
  await lights.locator("#password").fill(guestPassword);
  await lights.locator("#login-form button.primary").click();
  await lights.locator("#controller").waitFor();
  await fresh.close();
});

await test("deleting the account signs it out", async () => {
  const permissions = await open(owner, "/permissions");
  permissions.once("dialog", (dialog) => void dialog.accept());
  await permissions.getByRole("button", { name: "Delete account sarah" }).click();
  await permissions.locator("#accounts-empty").waitFor();
  await permissions.close();

  const lights = await open(guest, "/lights");
  await lights.locator("#login-section").waitFor();
  await lights.close();
});

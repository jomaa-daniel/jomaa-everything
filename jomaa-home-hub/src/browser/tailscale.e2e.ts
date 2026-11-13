// Drives /tailscale in Chrome against the real API, the real sync and a fake
// provider: the owner turns on managed access, invites someone, links their
// Tailscale user, gives and removes access, recovers from a failed sync, and
// deletes the account.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { Accounts } from "../accounts.js";
import { Api } from "../api.js";
import { allFeatures, type Device, type Features, type State } from "../device.js";
import { Group } from "../group.js";
import { HealthStore } from "../health/store.js";
import { Hub } from "../hub.js";
import { silentLog } from "../log.js";
import { MatterNotReadyError, type MatterAdmin } from "../matter/nodes.js";
import { settings } from "../settings.js";
import { TailscaleService } from "../tailscale.js";
import { schemaText } from "../tailscale-gateway.js";
import { TailscaleStore } from "../tailscale-store.js";
import { FakeTailnet } from "../tailscale-testing.js";
import { serve } from "../testing.js";

const ownerPassword = "owner password for the tailscale browser test";
const guestPassword = "guest password for the tailscale browser test";

class Lamp implements Device {
  readonly id = "lamp";
  readonly name = "Lamp";
  apply(): Promise<void> {
    return Promise.resolve();
  }
  state(): Promise<State> {
    return Promise.resolve({ on: false, brightness: 0, colorTemperaturePct: 0 });
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

const database = join(mkdtempSync(join(tmpdir(), "hub-tailscale-e2e-")), "accounts.sqlite");
const accounts = new Accounts(database);
const fake = await FakeTailnet.create(["old@example.com"]);
const service = new TailscaleService(
  new TailscaleStore(accounts.database, schemaText(), Date.now),
  fake.gateway(database),
  accounts,
  settings.tailscale,
  silentLog,
);
const hub = new Hub();
const lamp = new Lamp();
hub.addDevice("test", lamp);
hub.addRoom(new Group("living-room", "Living room", [lamp]));
const api = new Api(
  hub,
  noMatter,
  ownerPassword,
  accounts,
  silentLog,
  new HealthStore(":memory:"),
  undefined,
  undefined,
  service,
);
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

/** Waits for the sync, then reloads until the account shows the state. */
async function waitForAccess(page: Page, username: string, expected: string): Promise<void> {
  let shown: string | null = null;
  for (let attempt = 0; attempt < 20; attempt++) {
    await service.idle();
    await page.reload();
    shown = await page.locator(`#profile-${username} .heading [data-state]`).getAttribute("data-state");
    if (shown === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`${username} shows ${String(shown)}, not ${expected}`);
}

function text(page: Page, selector: string): Promise<string> {
  return page.locator(selector).innerText();
}

await test("the home page links to /tailscale", async () => {
  const home = await open(owner, "/home");
  assert.equal(await home.getByRole("link", { name: "Tailscale" }).getAttribute("href"), "/tailscale");
  await home.close();
});

await test("the owner signs in and turns on managed access, warned who loses it", async () => {
  const page = await open(owner, "/tailscale");
  await page.locator("#login-section").waitFor();
  assert.ok(!(await page.locator("#content").isVisible()));
  await page.locator("#password").fill(ownerPassword);
  await page.keyboard.press("Enter");
  await page.locator("#enable-panel").waitFor();
  assert.match(await text(page, "#enable-loss"), /old@example\.com/);
  assert.equal(fake.state().writes.length, 0);
  page.once("dialog", (dialog) => void dialog.accept());
  await page.locator("#enable").click();
  await page.locator("#notice.success").waitFor();
  await service.idle();
  assert.deepEqual(fake.family(), []);
  await page.reload();
  await page.locator("#status").waitFor();
  assert.ok(await page.locator("#enable-panel").isHidden());
  await page.close();
});

await test("an invited account joins and its Permissions row opens its Tailscale setup", async () => {
  const invite = await open(owner, "/invite");
  await invite.locator("#create").click();
  await invite.locator("#invites li").waitFor();
  const link = await invite.locator("#link").inputValue();
  await invite.close();
  const join = await open(guest, link.slice(origin.length));
  await join.locator("#username").fill("sarah");
  await join.locator("#password").fill(guestPassword);
  await join.locator("#confirm").fill(guestPassword);
  await join.locator("#join-form button").click();
  await join.locator("#done").waitFor();
  await join.close();

  const permissions = await open(owner, "/permissions");
  await permissions.getByRole("link", { name: "Tailscale setup for sarah" }).click();
  await permissions.waitForURL(`${origin}/tailscale?user=sarah`);
  await permissions.locator("#profile-sarah.focused").waitFor();
  assert.equal(await permissions.evaluate("document.activeElement?.textContent"), "sarah");
  await waitForAccess(permissions, "sarah", "unlinked");
  await permissions.close();
});

await test("an account that isn't the owner gets no controls or data", async () => {
  const signIn = await guest.request.post(`${origin}/api/login`, {
    data: { username: "sarah", password: guestPassword },
    headers: { Origin: origin },
  });
  assert.equal(signIn.status(), 200);
  const page = await open(guest, "/tailscale");
  await page.locator("#not-owner").waitFor();
  assert.ok(!(await page.locator("#content").isVisible()));
  assert.equal((await guest.request.get(`${origin}/api/tailscale`)).status(), 403);
  await page.close();
});

await test("the owner links sarah and gives access; the page shows it once Tailscale lists her", async () => {
  const page = await open(owner, "/tailscale?user=sarah");
  await page.getByLabel("Tailscale user for sarah").selectOption("u1");
  await page.getByRole("button", { name: "Link a Tailscale user to sarah" }).click();
  await page.locator("#notice.success", { hasText: "Linked sarah" }).waitFor();
  await waitForAccess(page, "sarah", "no-access");
  assert.match(await text(page, "#profile-sarah"), /alice-phone/);
  assert.doesNotMatch(await text(page, "#profile-sarah"), /jerry \(linux\)/);
  await page.getByRole("button", { name: "Give exit-node access to sarah" }).click();
  await waitForAccess(page, "sarah", "access");
  assert.deepEqual(fake.family(), ["alice@example.com"]);
  assert.match(await text(page, "#profile-sarah"), /Exit node chosen: Unknown/);
  assert.match(await text(page, "#server"), /Approved routes\s+192\.168\.1\.0\/24/);
  await page.close();
});

await test("a failed removal shows as pending with its error until a sync succeeds", async () => {
  const page = await open(owner, "/tailscale?user=sarah");
  fake.update((s) => {
    s.faults = { policyRead: ["unreachable"] };
  });
  await page.getByRole("button", { name: "Remove exit-node access from sarah" }).click();
  await waitForAccess(page, "sarah", "removing");
  assert.match(await text(page, "#profile-sarah"), /Last sync failed: .*unreachable/);
  assert.deepEqual(fake.family(), ["alice@example.com"]);
  await page.locator("#sync").click();
  await waitForAccess(page, "sarah", "no-access");
  assert.deepEqual(fake.family(), []);
  await page.close();
});

await test("controls are labelled and the page fits a phone", async () => {
  const page = await open(owner, "/tailscale?user=sarah");
  await page.setViewportSize({ width: 375, height: 800 });
  await page.locator("#profile-sarah").waitFor();
  const unnamed = await page.evaluate(`[...document.querySelectorAll("#content button, #content select")]
    .filter((el) => el.offsetParent !== null)
    .filter((el) => !el.getAttribute("aria-label") && !el.labels?.length && !el.textContent.trim()).length`);
  assert.equal(unnamed, 0);
  assert.ok(await page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"));
  assert.equal(await page.locator("#notice").getAttribute("aria-live"), "polite");
  await page.close();
});

await test("deleting the account removes its access", async () => {
  const page = await open(owner, "/tailscale?user=sarah");
  await page.getByRole("button", { name: "Give exit-node access to sarah" }).click();
  await waitForAccess(page, "sarah", "access");
  const permissions = await open(owner, "/permissions");
  permissions.once("dialog", (dialog) => void dialog.accept());
  await permissions.getByRole("button", { name: "Delete account sarah" }).click();
  await permissions.locator("#accounts-empty").waitFor();
  await permissions.close();
  await service.idle();
  assert.deepEqual(fake.family(), []);
  await page.reload();
  await page.locator("#profiles-empty").waitFor();
  assert.ok(await page.locator("#removing-section").isHidden());
  await page.close();
});

await test("an expired session shows sign-in on the next action", async () => {
  const page = await open(owner, "/tailscale");
  await page.locator("#status").waitFor();
  await owner.clearCookies();
  await page.locator("#refresh").click();
  await page.locator("#login-section").waitFor();
  await page.close();
});

await test("no page threw a script error", () => {
  assert.deepEqual(scriptErrors, []);
});

await service.close();
await browser.close();

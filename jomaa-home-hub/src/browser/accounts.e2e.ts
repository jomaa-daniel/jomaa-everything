// Drives the accounts and join pages in Chrome against the real API and built
// pages: the owner invites someone, they create an account through the share
// link, and the owner grants and removes access.
import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { Accounts } from "../accounts.js";
import { Clicks } from "../clicks.js";
import { Api } from "../api.js";
import { allFeatures, type Command, type Device, type Features, type State } from "../device.js";
import { Group } from "../group.js";
import { HealthStore } from "../health/store.js";
import { Hub } from "../hub.js";
import { silentLog } from "../log.js";
import { MatterNotReadyError, type MatterAdmin } from "../matter/nodes.js";
import { serve } from "../testing.js";
import { Federation } from "../federation.js";
import { catalog } from "../nodes.js";
import { captureReviewScreenshots } from "./dom.js";

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
const config = structuredClone(catalog);
config.nodes.push({
  id: "remote",
  name: "Remote",
  enabled: true,
  mode: "node",
  hostname: "remote.example.org",
  tunnelName: "remote",
  secretEnv: "REMOTE_KEY",
  deploySecret: "REMOTE_DEPLOY_KEY",
  scopes: ["lights"],
  publicRoutes: [["GET", "/healthz"]],
  modules: ["hub"],
  moduleOverrides: {},
});
const keys = { REMOTE_KEY: "fixture-node-key-long-enough-for-signing-requests" };
const remoteLamp = new Lamp();
const remoteHub = new Hub();
remoteHub.addDevice("test", remoteLamp);
remoteHub.addRoom(new Group("living-room", "Remote room", [remoteLamp]));
const remoteApi = new Api(
  remoteHub,
  noMatter,
  ownerPassword,
  new Accounts(":memory:"),
  new Clicks(":memory:"),
  silentLog,
  {
    health: null,
    layoutPath: null,
    organization: null,
    secrets: null,
    picos: null,
  },
  new Federation(config, "remote", keys),
);
const remoteOrigin = await serve(remoteApi.handle);
const transport: typeof fetch = (url, init) => {
  const target = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
  return fetch(remoteOrigin + target.pathname + target.search, init);
};
const apiAccounts = new Accounts(":memory:");
const api = new Api(
  hub,
  noMatter,
  ownerPassword,
  apiAccounts,
  new Clicks(":memory:"),
  silentLog,
  {
    health: new HealthStore(":memory:"),
    layoutPath: null,
    organization: null,
    secrets: null,
    picos: null,
  },
  new Federation(config, config.defaultNode, keys, transport),
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

async function signInAsOwner(page: Page): Promise<void> {
  await page.locator("#password").fill(ownerPassword);
  await page.locator("#login-form button").click();
  await page.locator("#content").waitFor();
}

let inviteLink = "";
let inviteId = "";

await test("the owner signs in and creates an invite link", async () => {
  const page = await open(owner, "/accounts");
  await signInAsOwner(page);
  await page.locator("#accounts-empty").waitFor();
  await page.locator("#invites-empty").waitFor();
  await captureReviewScreenshots(page, "invite-create");
  await page.locator("#create").click();
  await page.locator("#invites li").waitFor();
  inviteId = (await page.locator("#invites li").getAttribute("data-id")) ?? "";
  inviteLink = await page.locator("#link").inputValue();
  assert.match(inviteLink, new RegExp(`^${origin}/join#[\\w-]{43}$`));
  assert.ok(await page.locator("#copy").isEnabled());
  assert.ok(await page.locator("#invites-empty").isHidden());
  await page.close();
});

await test("the share link creates an account with a username and password", async () => {
  const join = await open(guest, inviteLink.slice(origin.length));
  await join.locator("#join-form").waitFor();
  await captureReviewScreenshots(join, "join-form");
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
  await captureReviewScreenshots(join, "join-success");

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

  const tab = await open(guest, "/manage");
  await tab.locator("#notice", { hasText: "no device access" }).waitFor();
  assert.ok(await tab.locator("#login-section").isVisible());
  await tab.close();

  const accounts = await open(guest, "/accounts");
  await accounts.locator("#not-owner").waitFor();
  assert.ok(!(await accounts.locator("#content").isVisible()), "/accounts hides owner controls");
  await accounts.close();
});

await test("the owner inspects the created account and daily link opens after joining", async () => {
  const page = await open(owner, "/accounts");
  await page.getByLabel("sarah can open Lights at Home").waitFor();
  assert.equal(await page.locator("#invites li").count(), 1);
  await page.getByRole("button", { name: `Inspect link ${inviteId}` }).click();
  await page.locator("#invite-facts", { hasText: "sarah" }).waitFor();
  assert.match((await page.locator("#invite-facts").textContent()) ?? "", /Account createdYes/);
  assert.equal(await page.locator("#access-days tr").count(), 1);
  assert.equal(await page.locator("#access-days td").last().textContent(), "2");
  assert.match((await page.locator("#access-summary").textContent()) ?? "", /^2 opens in total/);
  assert.ok(await page.locator("#access-chart svg[role=img]").isVisible());
  await captureReviewScreenshots(page, "link-details");
  assert.ok(await page.locator("#save-expiration").isDisabled());
  await page.reload();
  await page.locator("#invite-facts", { hasText: "sarah" }).waitFor();
  await page.locator("#close-invite").click();
  assert.ok(await page.locator("#invite-detail").isHidden());
  assert.equal(new URL(page.url()).hash, "");
  await page.close();
});

await test("the owner grants Lights and the account controls the room", async () => {
  const permissions = await open(owner, "/accounts");
  await permissions.getByLabel("sarah can open Lights at Home").check();
  await permissions.locator("#notice", { hasText: "Saved sarah" }).waitFor();
  await permissions.reload();
  assert.ok(await permissions.getByLabel("sarah can open Lights at Home").isChecked(), "the grant was saved");
  assert.ok(!(await permissions.getByLabel("sarah can open Device health at Home").isChecked()));
  await permissions.close();

  const lights = await open(guest, "/lights");
  await lights.locator("#controller").waitFor();
  assert.equal(await lights.locator("#target-title").textContent(), "Living room");
  await captureReviewScreenshots(lights, "lights-home");
  await lights.locator("#power-toggle").click();
  await lights.locator('#power-toggle[aria-checked="true"]').waitFor();
  assert.equal(lamp.current.on, true, "the command reached the light");

  const devices = await open(guest, "/manage");
  await devices.locator("#notice", { hasText: "no device access" }).waitFor();
  await devices.close();

  const revoke = await open(owner, "/accounts");
  await revoke.getByLabel("sarah can open Lights at Home").uncheck();
  await revoke.locator("#notice", { hasText: "Saved sarah" }).waitFor();
  await revoke.close();

  await lights.locator("#power-toggle").click();
  await lights.locator("#login-message", { hasText: "does not have access to Lights" }).waitFor();
  assert.equal(lamp.current.on, true, "the revoked account's command was refused");
  await lights.close();
});

await test("deleting the account signs it out", async () => {
  const permissions = await open(owner, "/accounts");
  permissions.once("dialog", (dialog) => void dialog.accept());
  await permissions.getByRole("button", { name: "Delete account sarah" }).click();
  await permissions.locator("#accounts-empty").waitFor();
  await permissions.close();

  const devices = await open(guest, "/manage");
  await devices.locator("#login-section").waitFor();
  await devices.close();
});

await test("a shared link grants selected homes and the home picker routes light commands", async () => {
  const permissions = await open(owner, "/accounts");
  await permissions.locator('#invite-grants input[data-node="remote"][data-scope="lights"]').check();
  await permissions.locator(`#invite-grants input[data-node="${config.defaultNode}"][data-scope="lights"]`).check();
  await permissions.locator("#create").click();
  await permissions.locator("#notice", { hasText: "Link created" }).waitFor();
  const link = await permissions.locator("#link").inputValue();
  const join = await open(guest, link.slice(origin.length));
  await join.locator("#join-form").waitFor();
  await join.locator("#username").fill("robin");
  await join.locator("#password").fill(guestPassword);
  await join.locator("#confirm").fill(guestPassword);
  await join.locator("#join-form button").click();
  await join.locator("#done").waitFor();
  await join.close();
  const lights = await open(guest, "/lights");
  await lights.locator("#username").fill("robin");
  await lights.locator("#password").fill(guestPassword);
  await lights.locator("#login-form button.primary").click();
  await lights.locator("#controller").waitFor();
  assert.equal(await lights.getByLabel("Home", { exact: true }).locator("option").count(), 2);
  await lights.getByLabel("Home", { exact: true }).selectOption("remote");
  await lights.locator("#target-title", { hasText: "Remote room" }).waitFor();
  const localOn = lamp.current.on;
  await lights.locator("#power-toggle").click();
  await lights.locator('#power-toggle[aria-checked="true"]').waitFor();
  assert.equal(remoteLamp.current.on, true);
  assert.equal(lamp.current.on, localOn);
  await captureReviewScreenshots(lights, "lights-remote");
  await permissions.reload();
  assert.ok(await permissions.getByLabel("robin can open Lights at Remote").isChecked());
  assert.ok(!(await permissions.getByLabel("robin can open Device health at Home").isChecked()));
  await captureReviewScreenshots(permissions, "account-grants");
  await lights.close();
  await permissions.close();
});

await test("an unused link's expiration saves, expires the link, and can renew it", async (t) => {
  t.after(() => {
    apiAccounts.now = Date.now;
  });
  const page = await open(owner, "/accounts");
  await page.locator("#invites li").first().waitFor();
  const previousCount = await page.locator("#invites li").count();
  await page.locator("#create").click();
  await page.locator("#notice", { hasText: "Link created" }).waitFor();
  await page.locator("#invites li").nth(previousCount).waitFor();
  const link = await page.locator("#link").inputValue();
  const row = page.locator("#invites li").first();
  await row.getByRole("button", { name: /^Inspect link/ }).click();
  await page.locator("#invite-facts", { hasText: "No account yet" }).waitFor();
  await page.locator("#invite-expiration").fill("2000-01-01T00:00");
  await page.locator("#save-expiration").click();
  await page.locator("#invite-notice", { hasText: "after the link was created" }).waitFor();
  const local = (date: Date) => {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };
  const expiry = local(new Date(Date.now() + 172_800_000));
  await page.locator("#invite-expiration").fill(expiry);
  await page.locator("#save-expiration").click();
  await page.locator("#notice", { hasText: "Link expiration saved" }).waitFor();
  await page.reload();
  await page.locator("#invite-expiration:enabled").waitFor();
  assert.equal(await page.locator("#invite-expiration").inputValue(), expiry);
  const id = new URLSearchParams(new URL(page.url()).hash.slice(1)).get("invite") ?? "";
  const now = Date.now();
  apiAccounts.now = () => now + 120_000;
  await page.locator("#invite-expiration").fill(local(new Date(now + 60_000)));
  await page.locator("#save-expiration").click();
  await page.locator("#invite-facts", { hasText: "Expired" }).waitFor();
  const join = await open(guest, link.slice(origin.length));
  await join.locator("#invalid").waitFor();
  await page.locator("#invite-expiration").fill(expiry);
  await page.locator("#save-expiration").click();
  await page.locator("#invite-facts", { hasText: "Unused" }).waitFor();
  await join.goto(link);
  await join.locator("#join-form").waitFor();
  await page.locator("#refresh-invite").click();
  await page.locator("#access-summary", { hasText: "2 opens in total" }).waitFor();
  const revoke = page.locator(`#invites li[data-id="${id}"]`).getByRole("button", { name: /^Revoke invite/ });
  await revoke.click();
  await page.locator("#invite-facts", { hasText: "Revoked" }).waitFor();
  assert.ok(await page.locator("#save-expiration").isDisabled());
  await join.goto(link);
  await join.locator("#invalid").waitFor();
  apiAccounts.now = Date.now;
  await join.close();
  await page.close();
});

await test("no page threw a script error", () => {
  assert.deepEqual(scriptErrors, []);
});

await browser.close();

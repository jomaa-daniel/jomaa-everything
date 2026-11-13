// Drives the Secrets page in Chrome against the real API and built pages,
// with temporary env files linked into a release the way deployment links
// them and a fake GitHub API: the owner views, reveals, edits and saves keys,
// adds the deploy token, and follows a redeploy while the hub is briefly away.
import assert from "node:assert/strict";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { Accounts } from "../accounts.js";
import { Api } from "../api.js";
import { Hub } from "../hub.js";
import { silentLog } from "../log.js";
import { MatterNotReadyError, type MatterAdmin } from "../matter/nodes.js";
import { DeployWorkflow } from "../redeploy.js";
import { EnvFiles, tokenKey } from "../secrets.js";
import { deploySettings } from "../settings.js";
import { serve } from "../testing.js";

const ownerPassword = "owner password for the secrets browser test";
const guestPassword = "guest password for the secrets browser test";
const hubSecret = "hub-secret-shown-only-on-reveal";
const tailnetSecret = "tskey-api-browser-fixture";
const deployToken = "fine_grained_browser_fixture";
const runUrl = "https://example.test/runs/42";

const base = mkdtempSync(join(tmpdir(), "hub-secrets-e2e-"));
const root = join(base, "release");
const checkout = join(base, "checkout");
const contents: Record<string, string> = {
  "app/.env": `# The hub's secrets.\nHUB_PASSWORD=${ownerPassword}\nHUB_SECRET=${hubSecret}\nEMPTY=\n`,
  "net/.env": `TAILSCALE_API_KEY=${tailnetSecret}\n`,
};
for (const [file, text] of Object.entries(contents)) {
  const dir = file.split("/")[0] ?? "";
  mkdirSync(join(root, dir), { recursive: true });
  mkdirSync(join(checkout, dir), { recursive: true });
  writeFileSync(join(checkout, file), text);
  chmodSync(join(checkout, file), 0o600);
  symlinkSync(join(checkout, file), join(root, file));
}

/** One push run of the deploy workflow; a rerun completes successfully at once. */
let attempt = 1;
let reruns = 0;
const fakeGitHub = await serve((req: IncomingMessage, res: ServerResponse) => {
  const path = new URL(req.url ?? "/", "http://fake").pathname;
  const actions = `/repos/${deploySettings.repo}/actions`;
  const run = { id: 42, html_url: runUrl, run_attempt: attempt, status: "completed", conclusion: "success" };
  res.setHeader("Content-Type", "application/json");
  if (req.method === "POST" && path === `${actions}/runs/42/rerun`) {
    reruns++;
    attempt++;
    res.writeHead(201).end();
  } else if (req.method === "GET" && path === `${actions}/runs/42`) {
    res.end(JSON.stringify(run));
  } else if (req.method === "GET" && path.startsWith(`${actions}/workflows/`)) {
    res.end(JSON.stringify({ workflow_runs: [run] }));
  } else {
    res.writeHead(404).end(JSON.stringify({ message: "Not Found" }));
  }
});

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

const accounts = new Accounts(":memory:");
const { token: invite } = accounts.createInvite();
await accounts.join(invite, "guest", guestPassword);
accounts.setScopes("guest", ["lights", "devices", "manage"]);
const api = new Api(new Hub(), noMatter, ownerPassword, accounts, silentLog, undefined, undefined, undefined, {
  files: new EnvFiles(root, Object.keys(contents), "app/.env", deploySettings.hubPasswordMinLength),
  workflow: new DeployWorkflow({
    api: fakeGitHub,
    repo: deploySettings.repo,
    workflow: deploySettings.workflow,
    timeoutMs: 5000,
  }),
});
const origin = await serve(api.handle);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const owner = await browser.newContext();
const scriptErrors: string[] = [];

async function open(context: BrowserContext, path: string): Promise<Page> {
  const page = await context.newPage();
  page.on("pageerror", (error) => scriptErrors.push(`${path}: ${error.message}`));
  await page.goto(origin + path);
  return page;
}

async function confirmWith(page: Page, password: string): Promise<void> {
  await page.locator("#confirm[open]").waitFor();
  await page.locator("#confirm-password").fill(password);
  await page.locator("#confirm-form button.primary").click();
  await page.locator("#confirm").waitFor({ state: "hidden" });
}

const page = await open(owner, "/secrets");

await test("the owner signs in and sees every file's keys with masked values", async () => {
  await page.locator("#password").fill(ownerPassword);
  await page.locator("#login-form button").click();
  await page.locator("#content").waitFor();
  await page.locator(".secret-file h2", { hasText: "net/.env" }).waitFor();
  assert.deepEqual(await page.locator(".secret-file h2").allTextContents(), ["app/.env", "net/.env"]);
  assert.deepEqual(await page.locator(".secret-file").first().locator(".secret-key").allTextContents(), [
    "HUB_PASSWORD",
    "HUB_SECRET",
    "EMPTY",
  ]);
  const text = (await page.locator("#content").textContent()) ?? "";
  for (const secret of [hubSecret, tailnetSecret, ownerPassword])
    assert.ok(!text.includes(secret), "values are masked");
  assert.ok(await page.locator("#redeploy").isHidden(), "redeploy is offered after a save");
});

await test("revealing a value needs the hub password", async () => {
  await page.getByRole("button", { name: "Reveal HUB_SECRET in app/.env" }).click();
  await confirmWith(page, "not the owner password");
  await page.locator("#notice", { hasText: "wrong password" }).waitFor();
  await page.getByRole("button", { name: "Reveal HUB_SECRET in app/.env" }).click();
  await confirmWith(page, ownerPassword);
  await page.locator(".secret-value.revealed", { hasText: hubSecret }).waitFor();
});

await test("the owner edits, adds and deletes keys and saves them with one password", async () => {
  await page.getByRole("button", { name: "Edit HUB_SECRET in app/.env" }).click();
  const value = page.getByLabel("New value for HUB_SECRET in app/.env");
  assert.equal(await value.inputValue(), hubSecret, "editing starts from the revealed value");
  await value.fill("rotated-in-the-browser");
  await page.getByRole("button", { name: "Keep the new value for HUB_SECRET" }).click();
  await page.getByLabel("New key for app/.env", { exact: true }).fill("ADDED_KEY");
  await page.getByLabel("Value of the new key for app/.env").fill("added in the browser");
  await page.getByRole("button", { name: "Add a key to app/.env" }).click();
  await page.getByRole("button", { name: "Delete EMPTY from app/.env" }).click();
  assert.equal(await page.getByRole("button", { name: "Save changes to app/.env" }).textContent(), "Save 3 changes");
  assert.ok(
    readFileSync(join(checkout, "app/.env"), "utf8").includes(`HUB_SECRET=${hubSecret}\n`),
    "nothing is written before saving",
  );

  await page.getByRole("button", { name: "Save changes to app/.env" }).click();
  await confirmWith(page, ownerPassword);
  await page.locator("#notice", { hasText: "Saved app/.env" }).waitFor();
  assert.equal(
    readFileSync(join(checkout, "app/.env"), "utf8"),
    `# The hub's secrets.\nHUB_PASSWORD=${ownerPassword}\nHUB_SECRET=rotated-in-the-browser\nADDED_KEY=added in the browser\n`,
  );
  assert.ok(lstatSync(join(root, "app/.env")).isSymbolicLink(), "the release keeps its symlink");
  assert.equal(statSync(join(checkout, "app/.env")).mode & 0o777, 0o600);
  assert.ok(!((await page.locator("#content").textContent()) ?? "").includes("rotated-in-the-browser"));
});

await test("redeploy waits for the token, then follows the run while the hub is away", async () => {
  await page.locator("#redeploy").waitFor();
  assert.ok(await page.locator("#redeploy-button").isDisabled(), "no token, no redeploy");
  await page.locator("#redeploy-help", { hasText: "app/.env" }).waitFor();

  await page.getByLabel("New key for app/.env", { exact: true }).fill(tokenKey);
  await page.getByLabel("Value of the new key for app/.env").fill(deployToken);
  await page.getByRole("button", { name: "Add a key to app/.env" }).click();
  await page.getByRole("button", { name: "Save changes to app/.env" }).click();
  await confirmWith(page, ownerPassword);
  await page.locator("#redeploy-button:enabled").waitFor();
  assert.ok(await page.locator("#redeploy-help").isHidden());

  let away = true;
  await page.route("**/api/secrets/redeploy/42", async (route) => {
    if (away) {
      away = false;
      await route.abort("connectionrefused");
    } else {
      await route.continue();
    }
  });
  await page.locator("#redeploy-button").click();
  await confirmWith(page, ownerPassword);
  await page.locator("#run-status", { hasText: "Waiting for the hub to come back" }).waitFor();
  assert.equal(await page.locator("#run-link").getAttribute("href"), runUrl);
  await page.locator("#run-status.success", { hasText: "The deploy finished." }).waitFor();
  assert.equal(reruns, 1);
});

await test("an invited account can't open the page", async () => {
  const guest = await browser.newContext();
  await guest.request.post(origin + "/api/login", { data: { username: "guest", password: guestPassword } });
  const tab = await open(guest, "/secrets");
  await tab.locator("#not-owner").waitFor();
  assert.ok(await tab.locator("#content").isHidden());
  await guest.close();
});

await test("no page threw a script error", () => {
  assert.deepEqual(scriptErrors, []);
});

await browser.close();

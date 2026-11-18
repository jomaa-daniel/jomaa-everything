// Opens the home page in Chrome against the real API and built pages: it
// prefetches the linked hub pages most-clicked first within the concurrency
// setting, counts a followed link, and opens the page from the prefetch.
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { after, test } from "node:test";
import { chromium } from "playwright-core";
import { Accounts } from "../accounts.js";
import { Api } from "../api.js";
import { Clicks } from "../clicks.js";
import { Hub } from "../hub.js";
import { silentLog } from "../log.js";
import { MatterNotReadyError, type MatterAdmin } from "../matter/nodes.js";
import { settings } from "../settings.js";
import { serve } from "../testing.js";

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

const homeFiles = new Set([
  "/home/ui.css",
  "/home/ui.js",
  "/home",
  "/home/base.css",
  "/home/style.css",
  "/home/prefetch.js",
  "/api/prefetch",
]);
const linkedPages = ["/lights", "/manage", "/accounts", "/secrets"];

const clicks = new Clicks(":memory:");
for (const path of ["/secrets", "/secrets", "/secrets", "/lights", "/lights"]) clicks.record(path);
const api = new Api(
  new Hub(),
  noMatter,
  "prefetch browser test password",
  new Accounts(":memory:"),
  clicks,
  silentLog,
  { health: null, layoutPath: null, organization: null, secrets: null, picos: null },
);

/** Requests after the home page's own files in arrival order, with their response status once sent. */
const requests: { path: string; status: number | null }[] = [];
let inFlight = 0;
let mostInFlight = 0;

/** Whether a path is a linked page or one of the hub pages' files. */
const prefetchable = (path: string) =>
  path.startsWith("/home/") || linkedPages.some((page) => path === page || path.startsWith(page + "/"));

const origin = await serve((req: IncomingMessage, res: ServerResponse) => {
  const path = new URL(req.url ?? "/", "http://hub").pathname;
  if (homeFiles.has(path) || !(prefetchable(path) || path === "/api/clicks")) {
    api.handle(req, res);
    return;
  }
  const request: { path: string; status: number | null } = { path, status: null };
  requests.push(request);
  inFlight++;
  mostInFlight = Math.max(mostInFlight, inFlight);
  res.on("close", () => {
    inFlight--;
    request.status = res.statusCode;
  });
  setTimeout(() => {
    api.handle(req, res);
  }, 100);
});
const browser = await chromium.launch({ channel: "chrome", headless: true });
after(() => browser.close());

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "timed out waiting for the page");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("the home page prefetches linked pages by popularity and opens them from the prefetch", async () => {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin + "/home");

  const fetched = () => new Set(requests.map((request) => request.path));
  await until(() => [...linkedPages, "/lights/app.js", "/home/accounts.js"].every((path) => fetched().has(path)));
  await until(() => inFlight === 0);
  const documents = requests.map((request) => request.path).filter((path) => linkedPages.includes(path));
  assert.deepEqual(documents, ["/secrets", "/lights", "/accounts", "/manage"]);
  assert.ok(mostInFlight <= settings.prefetch.concurrency, `${mostInFlight} prefetches ran at once`);
  assert.ok(!fetched().has("/home/base.css"), "files the page already loaded are not fetched again");
  assert.equal(new Set(requests.map((request) => request.path)).size, requests.length, "each file is fetched once");

  const prefetched = requests.length;
  await page.locator('.home-links a[href="/lights"]').click();
  await page.waitForURL(origin + "/lights");
  await until(() => requests.some((request) => request.path === "/api/clicks" && request.status !== null));
  assert.deepEqual(
    requests.filter((request) => request.path === "/api/clicks").map((request) => request.status),
    [200],
  );
  assert.equal(clicks.counts().get("/lights"), 3);
  assert.deepEqual(
    requests.slice(prefetched).filter((request) => request.path.startsWith("/lights") && request.status === 200),
    [],
    "the lights page and its files come from the prefetch",
  );
  assert.deepEqual(errors, []);
  await page.close();
});

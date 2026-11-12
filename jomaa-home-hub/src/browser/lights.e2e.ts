// Drives the lights panel in Chrome against the real API and built pages with
// lamps that keep reporting their old state after taking a command, and one
// lamp that rejects every command.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { chromium, type Page } from "playwright-core";
import { Accounts } from "../accounts.js";
import { Api } from "../api.js";
import { allFeatures, type Command, type Device, type Features, type State } from "../device.js";
import { Group } from "../group.js";
import { HealthStore } from "../health/store.js";
import { Hub } from "../hub.js";
import { silentLog } from "../log.js";
import { MatterNotReadyError, type MatterAdmin } from "../matter/nodes.js";
import { serve } from "../testing.js";

const password = "owner password for the lights browser test";

/** Takes commands but keeps reporting the state it had before them. */
class LaggingLamp implements Device {
  readonly features = (): Features => allFeatures;
  commands: Command[] = [];

  constructor(
    readonly id: string,
    readonly name: string,
  ) {}

  apply(command: Command): Promise<void> {
    this.commands.push(command);
    return Promise.resolve();
  }

  state(): Promise<State> {
    return Promise.resolve({ on: false, brightness: 50, colorTemperaturePct: 50 });
  }
}

/** Answers state reads but rejects every command. */
class OfflineLamp extends LaggingLamp {
  override apply(): Promise<void> {
    return Promise.reject(new Error("Device is offline. Please check the Wi-Fi connection."));
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

const lamps = Array.from({ length: 10 }, (_, i) => new LaggingLamp(`lamp-${i}`, `Lamp ${i}`));
const kitchen = new OfflineLamp("kitchen", "Kitchen");
const desk = new LaggingLamp("desk", "Desk");
const hub = new Hub();
for (const lamp of [...lamps, kitchen, desk]) hub.addDevice("test", lamp);
hub.addRoom(new Group("living-room", "Living room", [...lamps, kitchen]));
hub.addRoom(new Group("office", "Office", [desk]));
const api = new Api(hub, noMatter, password, new Accounts(":memory:"), silentLog, new HealthStore(":memory:"));
const origin = await serve(api.handle);
const browser = await chromium.launch({ channel: "chrome", headless: true });
after(() => browser.close());

async function until(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, "timed out waiting for the page");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function openPanel(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 375, height: 740 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin + "/lights");
  await page.locator("#password").fill(password);
  await page.locator("#login-form button.primary").click();
  await page.locator("#device-dots .dot").first().waitFor();
  after(() => {
    assert.deepEqual(errors, []);
  });
  return page;
}

test("a command the hub accepts shows as done even while the lamp still reports its old state", async () => {
  const page = await openPanel();
  await page.locator("#power-toggle").click();
  await page.locator("#device-dots .dot.pending").first().waitFor({ state: "detached" });

  assert.ok(lamps.every((lamp) => lamp.commands.some((command) => command.on === true)));
  assert.equal(await page.locator("#device-dots .dot.on").count(), lamps.length);
  assert.equal(await page.locator("#device-dots .dot.offline").count(), 1);
  assert.equal(await page.locator("#power-state").textContent(), `${lamps.length} of 11 on · 1 not answering`);
  assert.equal(await page.locator("[role=alert]").count(), 0);
  await page.close();
});

test("tapping the status row enlarges the dots and names the devices that aren't answering", async () => {
  const page = await openPanel();
  await page.locator("#power-toggle").click();
  await page.locator("#device-dots .dot.offline").waitFor();
  const small = await page.locator("#device-dots .dot").first().boundingBox();

  await page.locator("#status-toggle").click();
  assert.equal(await page.locator("#status-toggle").getAttribute("aria-expanded"), "true");
  assert.deepEqual(await page.locator("#device-problems .problem-name").allTextContents(), ["Kitchen"]);
  assert.deepEqual(await page.locator("#device-problems .problem-reason").allTextContents(), ["not responding"]);
  await until(
    async () => ((await page.locator("#device-dots .dot").first().boundingBox())?.width ?? 0) > (small?.width ?? 0),
  );

  await page.locator("#status-toggle").click();
  assert.ok(await page.locator("#device-problems").isHidden());
  await page.close();
});

test("the room name wraps instead of being cut off beside a long row of dots", async () => {
  const page = await openPanel();
  const title = page.locator("#target-title");
  assert.equal(await title.textContent(), "Living room");
  const fits = await title.evaluate(
    (element: { scrollWidth: number; clientWidth: number }) => element.scrollWidth <= element.clientWidth,
  );
  assert.ok(fits, "the whole room name is visible");
  await page.close();
});

test("when the hub can't be reached, the room's lights turn red and the status row says why", async () => {
  const page = await openPanel();
  await page.route("**/api/targets/*/state", (route) => route.abort());
  await page.locator(".room-btn", { hasText: "Office" }).click();
  await page.locator("#device-dots .dot.offline").waitFor();

  assert.equal(await page.locator("[role=alert]").count(), 0);
  await page.locator("#status-toggle").click();
  assert.deepEqual(await page.locator("#device-problems .problem-name").allTextContents(), ["Desk"]);
  assert.deepEqual(await page.locator("#device-problems .problem-reason").allTextContents(), ["can't reach the hub"]);
  await page.close();
});

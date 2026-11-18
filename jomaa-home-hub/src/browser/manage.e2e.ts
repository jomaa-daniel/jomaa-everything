// Drives the device organization page in Chrome against the real API and
// built pages.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { chromium, type Browser } from "playwright-core";
import { Accounts } from "../accounts.js";
import { Clicks } from "../clicks.js";
import { Api, sessionToken } from "../api.js";
import { parseConfig } from "../config.js";
import { GoveeClient } from "../govee.js";
import { HealthError, HealthStore } from "../health/store.js";
import { Hub } from "../hub.js";
import { silentLog } from "../log.js";
import type { MatterAdmin, MatterNodes, NodeSummary } from "../matter/nodes.js";
import { Organization } from "../organization.js";
import { serve } from "../testing.js";
import { settings } from "../settings.js";

const password = "management-test";
const directory = mkdtempSync(join(tmpdir(), "manage-browser-"));
const path = join(directory, "config.json");
const cfg = {
  devices: [
    { id: "coffee-table", name: "coffee-table", driver: "matter", nodeId: 3, endpoint: 1 },
    { id: "lamp", name: "Lamp", driver: "govee", sku: "test", device: "test", minKelvin: 2700, maxKelvin: 6500 },
  ],
  rooms: [{ id: "living-room", name: "Living Room", members: ["coffee-table", "lamp"] }],
};
writeFileSync(path, JSON.stringify(cfg));
const summary: NodeSummary = {
  nodeId: 3,
  available: true,
  isBridge: false,
  lightEndpoints: [1],
  vendor: "GE",
  product: "Strip",
  label: "coffee-table",
  lastSeen: null,
  uptimeSeconds: null,
  uptimeObservedAt: null,
  type: "Extended Color Light",
  capabilities: ["Power", "Color"],
};
const matter: MatterAdmin & MatterNodes = {
  ready: true,
  node: () => ({
    nodeId: 3,
    available: true,
    isBridge: false,
    attributes: { "1/6/0": true },
    displayName: null,
    lastSeen: null,
    uptimeSeconds: null,
    uptimeObservedAt: null,
  }),
  nodes: () => [summary],
  invoke: () => Promise.resolve(),
  discover: () => Promise.resolve([]),
  register: () => Promise.reject(new Error("unused")),
  rename: (_nodeId, name) => {
    summary.label = name;
    return Promise.resolve(summary);
  },
  commission: () => Promise.reject(new Error("unused")),
  setWiFiCredentials: () => Promise.resolve(),
  setThreadDataset: () => Promise.resolve(),
  removeNode: () => Promise.resolve(),
};
const organization = new Organization(":memory:");
const health = new HealthStore(":memory:");
const reporterCredential = health.enroll({ id: "pico-test", name: "Pico" });
health.record("pico-test", {
  bootId: "abcdef0123456789",
  sequence: 0,
  firmware: "test-firmware",
  uptimeSeconds: 120,
  freeHeapBytes: 128000,
  rssi: -51,
  ip: "192.168.1.110",
  status: "healthy",
  message: "Startup complete",
});
const cloudCalls: string[] = [];
const cloud = await serve((req, res) => {
  cloudCalls.push(req.url ?? "");
  res.writeHead(200).end(
    JSON.stringify({
      code: 200,
      payload: {
        capabilities: [
          { instance: "online", state: { value: true } },
          { instance: "powerSwitch", state: { value: 0 } },
          { instance: "brightness", state: { value: 50 } },
        ],
      },
    }),
  );
});
const hub = Hub.build(parseConfig(JSON.stringify(cfg)), new GoveeClient("test", cloud), matter);
const origin = await serve(
  new Api(hub, matter, password, new Accounts(":memory:"), new Clicks(":memory:"), silentLog, {
    health,
    layoutPath: path,
    organization,
    secrets: null,
    picos: null,
  }).handle,
);
const setupHeaders = { Authorization: `Bearer ${sessionToken(password)}`, "Content-Type": "application/json" };
for (const body of [
  { action: "type.create", name: "Light strips" },
  { action: "group.create", name: "Office" },
]) {
  const response = await fetch(origin + "/api/manage", {
    method: "POST",
    headers: setupHeaders,
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
}
let browser: Browser;
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
} catch (reason) {
  health.close();
  organization.close();
  rmSync(directory, { recursive: true, force: true });
  throw reason;
}
after(async () => {
  await browser.close();
  health.close();
  organization.close();
  rmSync(directory, { recursive: true, force: true });
});

async function until(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, "timed out waiting for the page");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function openManage() {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin + "/manage");
  await page.locator("#password").fill(password);
  await page.locator("#login-form button.primary").click();
  await page.locator("#management:not([hidden])").waitFor();
  await page.locator("#assignment-rows tr").first().waitFor();
  after(() => {
    assert.deepEqual(errors, []);
  });
  return page;
}

test("Devices opens first with a compact read-only inventory and one details pane", async () => {
  const page = await openManage();
  assert.equal(await page.locator("#devices-tab").getAttribute("aria-selected"), "true");
  assert.ok(await page.locator("#types-panel").isHidden());
  assert.ok(await page.locator("#groups-panel").isHidden());
  assert.equal(await page.locator("#assignment-rows select, #assignment-rows input").count(), 0);
  assert.equal(await page.locator("#assigned-type").count(), 0);
  const inventory = await page.locator("#assignment-table-wrap").boundingBox();
  assert.ok(inventory && inventory.y < 350);
  const commandBar = await page.locator(".command-bar").boundingBox();
  assert.ok(commandBar && commandBar.y + commandBar.height <= 900);
  await page.close();
});

test("group changes persist through the API and refresh the selected row", async () => {
  const page = await openManage();
  await page.getByRole("button", { name: "Edit Lamp", exact: true }).click();
  const checkbox = page.getByRole("checkbox", { name: "Office", exact: true });
  assert.equal(await checkbox.isChecked(), false);
  await checkbox.check();
  await page.locator("#notice.success").waitFor();
  assert.ok(await checkbox.isChecked());
  const state = (await (await fetch(origin + "/api/manage", { headers: setupHeaders })).json()) as {
    types: Array<{ id: string; name: string }>;
    groups: Array<{ id: string; name: string }>;
    devices: Array<{ key: string; typeId: string | null; groupIds: string[] }>;
  };
  const office = state.groups.find((group) => group.name === "Office");
  assert.ok(office);
  assert.ok(state.devices.find((device) => device.key === "target:lamp")?.groupIds.includes(office.id));
  assert.ok((await page.locator("#assignment-rows tr.selected").innerText()).includes("Office"));
  await page.locator("#device-search").fill("pico");
  assert.equal(await page.locator("#assignment-rows tr").count(), 1);
  assert.equal(await page.locator("#selected-name").textContent(), "Pico");
  await page.close();
});

test("arrow keys select devices, Enter edits, and Escape returns to the list", async () => {
  const page = await openManage();
  await page.keyboard.press("/");
  await page.waitForFunction("document.activeElement?.id === 'device-search'");
  await page.keyboard.press("ArrowDown");
  const first = await page.locator("#assignment-rows .device-select").first().getAttribute("id");
  assert.equal(await page.evaluate<string>("document.activeElement?.id"), first);
  await page.keyboard.press("ArrowDown");
  const second = await page.locator("#assignment-rows .device-select").nth(1).getAttribute("id");
  assert.equal(await page.evaluate<string>("document.activeElement?.id"), second);
  assert.equal(await page.locator("#assignment-rows .device-select").nth(1).getAttribute("aria-pressed"), "true");
  await page.keyboard.press("Enter");
  assert.equal(await page.evaluate<string>("document.activeElement?.id"), "edit-device-name");
  assert.ok(await page.locator("#device-name").isHidden());
  await page.keyboard.press("Enter");
  assert.equal(await page.evaluate<string>("document.activeElement?.id"), "device-name");
  await page.keyboard.press("Escape");
  assert.ok(await page.locator("#device-name").isHidden());
  assert.equal(await page.evaluate<string>("document.activeElement?.id"), "edit-device-name");
  await page.keyboard.press("Escape");
  assert.equal(await page.evaluate<string>("document.activeElement?.id"), second);
  await page.keyboard.press("End");
  const last = await page.locator("#assignment-rows .device-select").last().getAttribute("id");
  assert.equal(await page.evaluate<string>("document.activeElement?.id"), last);
  await page.close();
});

test("tabs expose rename and delete; Escape restores a rename draft; edits persist", async () => {
  const page = await openManage();
  await page.locator("#devices-tab").focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(await page.locator("#types-tab").getAttribute("aria-selected"), "true");
  assert.ok(await page.getByRole("button", { name: "Delete type Light strips" }).isVisible());
  await page.getByRole("button", { name: "Rename type Light strips" }).click();
  await page.locator("#type-list li.editing input").fill("Discard this draft");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#type-list li.editing").count(), 0);
  assert.ok(await page.getByRole("button", { name: "Rename type Light strips" }).isVisible());
  await page.locator("#type-name").fill("Browser category");
  await page.locator("#type-create button").click();
  await page.getByRole("button", { name: "Rename type Browser category", exact: true }).waitFor();
  await page.getByRole("button", { name: "Rename type Browser category", exact: true }).click();
  await page.locator("#type-list li.editing input").fill("Renamed category");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Delete type Renamed category", exact: true }).waitFor();
  page.once("dialog", (dialog) => {
    void dialog.accept();
  });
  await page.getByRole("button", { name: "Delete type Renamed category", exact: true }).click();
  await until(
    async () => (await page.getByRole("button", { name: "Delete type Renamed category", exact: true }).count()) === 0,
  );
  await page.locator("#groups-tab").click();
  assert.ok(await page.getByRole("button", { name: "Rename group Office", exact: true }).isVisible());
  await page.keyboard.press("/");
  assert.equal(await page.locator("#devices-tab").getAttribute("aria-selected"), "true");
  assert.equal(await page.evaluate<string>("document.activeElement?.id"), "device-search");
  await page.close();
});

test("mobile shows the inventory first, opens one device, and returns without overflow", async () => {
  const page = await openManage();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.locator("#device-editor").isHidden());
  const inventory = await page.locator("#assignment-table-wrap").boundingBox();
  assert.ok(inventory && inventory.y < 350);
  assert.equal(await page.evaluate<boolean>("document.documentElement.scrollWidth <= innerWidth"), true);
  await page.getByRole("button", { name: "Edit Lamp", exact: true }).click();
  assert.ok(await page.locator("#device-editor").isVisible());
  const paneTitle = await page.locator("#device-editor .pane-heading").boundingBox();
  const editor = await page.locator("#device-editor").boundingBox();
  assert.ok(paneTitle && editor && Math.abs(paneTitle.y - editor.y) < 30);
  assert.ok(await page.locator(".device-list").isHidden());
  assert.equal(await page.locator("#selected-name").textContent(), "Lamp");
  await page.locator("#editor-back").click();
  assert.ok(await page.locator(".device-list").isVisible());
  assert.ok(await page.locator("#device-editor").isHidden());
  assert.equal(await page.evaluate<boolean>("document.documentElement.scrollWidth <= innerWidth"), true);
  await page.setViewportSize({ width: 320, height: 640 });
  assert.equal(await page.evaluate<boolean>("document.documentElement.scrollWidth <= innerWidth"), true);
  await page.close();
});

test("failed assignment saves restore the server values and leave editing usable", async () => {
  const page = await openManage();
  await page.getByRole("button", { name: "Edit Pico", exact: true }).click();
  await page.route("**/api/manage", async (route) => {
    if (route.request().method() === "POST")
      await route.fulfill({ status: 500, json: { error: "Assignment rejected" } });
    else await route.continue();
  });
  const checkbox = page.getByRole("checkbox", { name: "Office", exact: true });
  assert.equal(await checkbox.isChecked(), false);
  await checkbox.check();
  await page.locator("#notice.error", { hasText: "Assignment rejected" }).waitFor();
  assert.equal(await checkbox.isChecked(), false);
  assert.ok(await checkbox.isEnabled());
  assert.ok(!(await page.locator("#assignment-rows tr.selected").innerText()).includes("Office"));
  await page.close();
});

test("empty searches clear the editor; Escape restores the full device list", async () => {
  const page = await openManage();
  await page.locator("#device-search").fill("no-such-device");
  assert.ok(await page.locator("#devices-no-match").isVisible());
  assert.ok(await page.locator("#device-editor").isHidden());
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#assignment-rows tr").count(), 3);
  assert.ok(await page.locator("#devices-no-match").isHidden());
  await page.close();
});

test("a failed read after saving locks editing until Refresh retrieves the saved values", async () => {
  const page = await openManage();
  await page.getByRole("button", { name: "Edit Pico", exact: true }).click();
  let failRead = false;
  await page.route("**/api/manage", async (route) => {
    if (route.request().method() === "POST") {
      failRead = true;
      await route.continue();
    } else if (failRead) {
      failRead = false;
      await route.fulfill({ status: 500, json: { error: "Read unavailable" } });
    } else await route.continue();
  });
  const checkbox = page.getByRole("checkbox", { name: "Office", exact: true });
  await checkbox.setChecked(!(await checkbox.isChecked()));
  await page.locator("#notice.error", { hasText: "Changes saved, but refresh failed" }).waitFor();
  assert.ok(await checkbox.isDisabled());
  assert.ok(await page.locator("#refresh").isEnabled());
  await page.locator("#refresh").click();
  await page.locator("#notice", { hasText: "Refreshed." }).waitFor();
  assert.ok(await checkbox.isEnabled());
  assert.ok(await checkbox.isChecked());
  await page.unroute("**/api/manage");
  await checkbox.uncheck();
  await page.locator("#notice.success").waitFor();
  await page.close();
});

test("an assignment finishing while searching preserves the search focus", async () => {
  const page = await openManage();
  await page.getByRole("button", { name: "Edit Pico", exact: true }).click();
  let release = () => {};
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/manage", async (route) => {
    if (route.request().method() === "POST") await ready;
    await route.continue();
  });
  await page.getByRole("checkbox", { name: "Office", exact: true }).check();
  await page.locator("#notice", { hasText: "Saving…" }).waitFor();
  await page.locator("#device-search").fill("pico");
  release();
  await page.locator("#notice.success").waitFor();
  assert.equal(await page.evaluate<string>("document.activeElement?.id"), "device-search");
  assert.equal(await page.locator("#selected-name").textContent(), "Pico");
  assert.equal(await page.locator("#assignment-rows tr").count(), 1);
  await page.close();
});

test("an expired session during a save returns to sign-in with a visible message", async () => {
  const page = await openManage();
  await page.getByRole("button", { name: "Edit Pico", exact: true }).click();
  await page.route("**/api/manage", async (route) => {
    if (route.request().method() === "POST") await route.fulfill({ status: 401, json: { error: "Unauthorized" } });
    else await route.continue();
  });
  const checkbox = page.getByRole("checkbox", { name: "Office", exact: true });
  await checkbox.setChecked(!(await checkbox.isChecked()));
  await page.locator("#login-section:not([hidden])").waitFor();
  assert.ok(await page.locator("#management").isHidden());
  assert.ok((await page.locator("#notice").textContent())?.includes("Sign in to continue"));
  await page.close();
});

test("keyboard hints follow focus through search, details, and renaming", async () => {
  const page = await openManage();
  assert.ok((await page.locator("#command-hints").innerText()).includes("Tabs"));
  await page.keyboard.press("/");
  await page.locator("#device-search").fill("pico");
  assert.ok((await page.locator("#command-hints").innerText()).includes("Clear search"));
  await page.keyboard.press("ArrowDown");
  assert.ok((await page.locator("#command-hints").innerText()).includes("Details"));
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  assert.ok((await page.locator("#command-hints").innerText()).includes("Save"));
  await page.getByRole("checkbox", { name: "Office", exact: true }).focus();
  assert.ok((await page.locator("#command-hints").innerText()).includes("Toggle group"));
  await page.locator("#types-tab").click();
  await page.getByRole("button", { name: "Rename type Light strips", exact: true }).click();
  assert.ok((await page.locator("#command-hints").innerText()).includes("Save"));
  assert.ok((await page.locator("#command-hints").innerText()).includes("Cancel"));
  await page.close();
});

test("Govee status is checked through its cloud and never uses Pico enrollment controls", async () => {
  const page = await openManage();
  const row = page.locator("#assignment-rows tr", { hasText: "Lamp" });
  assert.ok((await row.innerText()).includes("online"));
  assert.ok(cloudCalls.every((path) => path === "/router/api/v1/device/state"));
  await page.getByRole("button", { name: "Edit Lamp", exact: true }).click();
  await page.locator("#govee-detail:not([hidden])").waitFor();
  assert.ok((await page.locator("#govee-facts").innerText()).includes("Govee cloud"));
  assert.ok(await page.locator("#edit-form").isHidden());
  assert.ok(await page.locator("#rotate").isHidden());
  await page.close();
});

test("device names save from Details for Govee, Matter and health reporters", async () => {
  const page = await openManage();
  for (const [oldName, name, key] of [
    ["Lamp", "Desk Lamp", "target:lamp"],
    ["coffee-table", "Coffee Strip", "matter:3"],
    ["Pico", "Office Pico", "health:pico-test"],
  ] as const) {
    await page.getByRole("button", { name: `Edit ${oldName}`, exact: true }).click();
    assert.ok(await page.locator("#device-name").isHidden());
    await page.locator("#edit-device-name").click();
    assert.ok(await page.locator("#edit-device-name").isHidden());
    await page.locator("#device-name").fill(name);
    await page.locator("#save-device-name").click();
    await page.locator("#notice.success").waitFor();
    await page.getByRole("button", { name: `Edit ${name}`, exact: true }).waitFor();
    assert.equal(await page.locator("#selected-name").textContent(), name);
    assert.ok(await page.locator("#device-name").isHidden());
    assert.ok(await page.locator("#save-device-name").isHidden());
    assert.ok(await page.locator("#edit-device-name").isVisible());
    const state = (await (await fetch(origin + "/api/manage", { headers: setupHeaders })).json()) as {
      devices: Array<{ key: string; name: string }>;
    };
    assert.equal(state.devices.find((device) => device.key === key)?.name, name);
  }
  await page.reload();
  await page.getByRole("button", { name: "Edit Desk Lamp", exact: true }).waitFor();
  await page.getByRole("button", { name: "Edit Office Pico", exact: true }).click();
  assert.equal(await page.locator("#health-tab, #health-panel, #assigned-type").count(), 0);
  assert.equal(await page.locator("#health-logs").getAttribute("open"), null);
  await page.locator("#health-logs summary").click();
  await page.locator("#log-rows", { hasText: "Startup complete" }).waitFor();
  assert.ok(await page.locator("#no-logs").isHidden());
  await page.close();
});

test("Details includes the health inventory diagnostics and filters", async () => {
  summary.available = false;
  const page = await openManage();
  try {
    await page.locator("#inventory-filters > summary").click();
    await page.locator("#status-filter option", { hasText: "offline" }).waitFor({ state: "attached" });
    await page.locator("#status-filter").selectOption({ label: "offline" });
    assert.equal(await page.locator("#assignment-rows tr").count(), 1);
    assert.ok((await page.locator("#assignment-rows").innerText()).includes("Coffee Strip"));
    await page.locator("#clear-filters").click();
    await page.locator("#group-filter").selectOption({ label: "Office" });
    const grouped = await page.locator("#assignment-rows tr").allTextContents();
    assert.ok(grouped.length > 0 && grouped.every((text) => text.includes("Office")));
    await page.locator("#capability-filter").selectOption({ label: "Health reporting" });
    assert.equal(await page.locator("#assignment-rows tr").count(), 1);
    await page.getByRole("button", { name: "Edit Office Pico", exact: true }).click();
    const healthFacts = await page.locator("#device-facts").innerText();
    for (const label of ["First report", "Report interval", "Signal", "Free heap", "Capabilities"])
      assert.ok(healthFacts.includes(label), label);
    await page.locator("#clear-filters").click();
    await page.getByRole("button", { name: "Edit Coffee Strip", exact: true }).click();
    const matterFacts = await page.locator("#matter-facts").innerText();
    for (const label of ["Uptime reported", "Bridge", "Lights and plugs", "Capabilities", "Category"])
      assert.ok(matterFacts.includes(label), label);
    await page.getByRole("button", { name: "Edit Desk Lamp", exact: true }).click();
    const goveeFacts = await page.locator("#govee-facts").innerText();
    for (const label of ["Capabilities", "Groups", "Status source", "Checked", "Result"])
      assert.ok(goveeFacts.includes(label), label);
    assert.equal(await page.locator("#assigned-type, #health-tab").count(), 0);
  } finally {
    summary.available = true;
    await page.close();
  }
});

test("a rejected name save keeps editing; Escape returns to the pencil", async () => {
  const page = await openManage();
  await page.getByRole("button", { name: "Edit Desk Lamp", exact: true }).click();
  assert.ok(await page.locator("#device-name").isHidden());
  await page.locator("#edit-device-name").click();
  await page.locator("#device-name").fill("Rejected name");
  await page.route("**/api/manage", async (route) => {
    if (route.request().method() === "POST") await route.fulfill({ status: 500, json: { error: "Rename rejected" } });
    else await route.continue();
  });
  await page.locator("#save-device-name").click();
  await page.locator("#notice.error", { hasText: "Rename rejected" }).waitFor();
  assert.equal(await page.locator("#device-name").inputValue(), "Rejected name");
  assert.ok(await page.locator("#save-device-name").isVisible());
  assert.ok(await page.locator("#edit-device-name").isHidden());
  await page.locator("#device-name").press("Escape");
  assert.equal(await page.locator("#selected-name").textContent(), "Desk Lamp");
  assert.ok(await page.locator("#device-name").isHidden());
  assert.ok(await page.locator("#edit-device-name").isVisible());
  await page.close();
});

test("health history pages persist when reopened and Details refresh retrieves the newest reports", async () => {
  const previousNow = health.now;
  const count = settings.health.historyLimit + 2;
  let now = Date.now() - count * 6000;
  health.now = () => now;
  health.enroll({ id: "pico-history", name: "History Pico" });
  const report = {
    bootId: "fedcba9876543210",
    sequence: 0,
    firmware: "history-test",
    uptimeSeconds: 60,
    freeHeapBytes: 100000,
    status: "healthy",
  };
  for (let sequence = 0; sequence < count; sequence++) {
    health.record("pico-history", { ...report, sequence, message: `Report ${sequence}` });
    now += 6000;
  }
  const page = await openManage();
  try {
    await page.getByRole("button", { name: "Edit History Pico", exact: true }).click();
    await page.locator("#health-logs > summary").click();
    await page.locator("#more:not([hidden])").waitFor();
    assert.equal(await page.locator("#log-rows tr").count(), settings.health.historyLimit);
    await page.locator("#more").click();
    await until(async () => (await page.locator("#log-rows tr").count()) === count);
    await page.locator("#health-logs > summary").click();
    await page.locator("#health-logs > summary").click();
    assert.equal(await page.locator("#log-rows tr").count(), count);
    health.record("pico-history", { ...report, sequence: count, message: "Newest report" });
    await page.locator("#detail-refresh").click();
    await page.locator("#notice", { hasText: "Refreshed." }).waitFor();
    assert.ok((await page.locator("#log-rows tr").first().innerText()).includes("Newest report"));
    assert.equal(await page.locator("#log-rows tr").count(), settings.health.historyLimit);
    assert.ok((await page.locator("#retention").innerText()).includes(`${health.retentionDays} days`));
  } finally {
    health.now = previousNow;
    await page.close();
  }
});

test("report settings and the credential lifecycle work from Details", async () => {
  const page = await openManage();
  await page.getByRole("button", { name: "Edit Office Pico", exact: true }).click();
  await page.locator("#device-settings > summary").click();
  await page.locator("#device-interval").fill("120");
  await page.locator("#edit-form button").click();
  await page.locator("#device-facts", { hasText: "120s" }).waitFor();
  assert.equal(health.get("pico-test").intervalSeconds, 120);
  page.once("dialog", (dialog) => {
    void dialog.accept();
  });
  await page.locator("#rotate").click();
  await page.locator("#credential-dialog").waitFor();
  const token = await page.locator("#credential-value").inputValue();
  assert.notEqual(token, reporterCredential.token);
  health.authenticate("pico-test", token);
  assert.throws(() => {
    health.authenticate("pico-test", reporterCredential.token);
  }, HealthError);
  const downloading = page.waitForEvent("download");
  await page.locator("#download-credential").click();
  const download = await downloading;
  const file = join(directory, "credential.json");
  await download.saveAs(file);
  const credential = JSON.parse(readFileSync(file, "utf8")) as { id: string; token: string };
  assert.deepEqual(credential, { id: "pico-test", token });
  await page.locator("#close-credential").click();
  await page.locator("#health-logs > summary").click();
  await page.locator("#log-rows", { hasText: "Startup complete" }).waitFor();
  page.once("dialog", (dialog) => {
    void dialog.accept();
  });
  await page.locator("#revoke").click();
  await page.locator("#device-facts", { hasText: "revoked" }).waitFor();
  assert.ok(await page.locator("#revoke").isDisabled());
  assert.throws(() => {
    health.authenticate("pico-test", token);
  }, HealthError);
  assert.ok((await page.locator("#log-rows").innerText()).includes("Startup complete"));
  await page.close();
});

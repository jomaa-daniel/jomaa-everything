import { catalog } from "./nodes.js";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Api, sessionToken } from "./api.js";
import { Accounts } from "./accounts.js";
import { Clicks } from "./clicks.js";
import { Hub } from "./hub.js";
import { silentLog } from "./log.js";
import type { MatterAdmin } from "./matter/nodes.js";
import {
  ImageCommand,
  imageSettings,
  PicoError,
  PicoRuns,
  type Feature,
  type FlashRequest,
  type PicoImager,
  type PicoTarget,
} from "./picos.js";
import { serve } from "./testing.js";

const features: Feature[] = [
  { id: "health", label: "Health check", description: "Heartbeats", requires: ["wifi"], default: false },
  { id: "wifi", label: "Wi-Fi", description: "Connection", requires: [], default: false },
  { id: "temperature", label: "Temperature reading", description: "Celsius", requires: [], default: false },
  { id: "i2c", label: "I²C raw logging", description: "Active reads", requires: ["health", "wifi"], default: false },
  { id: "fan", label: "PWM fan control", description: "PWM output", requires: ["health", "wifi"], default: false },
];
const target: PicoTarget = {
  id: "runtime-test",
  name: "USB Pico",
  uniqueId: "5303284720e42a9c",
  mode: "runtime",
  description: "USB",
  available: true,
  unavailableReason: null,
  latestRunId: null,
};
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

class Imager implements PicoImager {
  targets = [target];
  calls: FlashRequest[] = [];
  discoveries = 0;
  events: unknown[] = [];
  release: () => void = () => {
    throw new Error("No active flash");
  };
  discover(): Promise<PicoTarget[]> {
    this.discoveries++;
    return Promise.resolve(this.targets);
  }
  catalog(): Promise<{ features: Feature[]; defaultWifiTransport: "native" | "esp8285" }> {
    return Promise.resolve({ features, defaultWifiTransport: "esp8285" });
  }
  state() {
    return Promise.resolve({ features: ["wifi"], wifi: { ssid: "saved-network", transport: "native" as const } });
  }
  async flash(_id: string, request: FlashRequest, emit: (event: unknown) => void): Promise<void> {
    this.calls.push(request);
    await new Promise<void>((resolve) => {
      this.release = resolve;
    });
    for (const event of this.events) emit(event);
  }
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
const passedTemperature: unknown[] = [
  {
    type: "check",
    check: { feature: "temperature", status: "passed", message: "Observed", evidence: { celsius: 24 } },
  },
  { type: "result", status: "passed", message: "Verified" },
];

test("Pico APIs require Devices access before discovering or launching, and refuse cross-origin flashes", async () => {
  const imager = new Imager();
  const runs = new PicoRuns(imager, imageSettings(), null);
  const accounts = new Accounts(":memory:");
  const clicks = new Clicks(":memory:");
  const { token } = accounts.createInvite();
  await accounts.join(token, "guest", "guest test password");
  accounts.setGrants("guest", [{ node: catalog.defaultNode, scopes: ["lights"] }]);
  const guest = accounts.createSession("guest");
  const password = "pico api owner password";
  const origin = await serve(
    new Api(new Hub(), matter, password, accounts, clicks, silentLog, {
      health: null,
      layoutPath: null,
      organization: null,
      secrets: null,
      picos: runs,
    }).handle,
  );
  try {
    assert.equal((await fetch(origin + "/api/picos")).status, 401);
    assert.equal((await fetch(origin + "/api/picos", { headers: { Authorization: `Bearer ${guest}` } })).status, 403);
    assert.equal(imager.discoveries, 0);
    assert.equal((await fetch(origin + "/api/picos/runtime-test/state")).status, 401);
    assert.equal(
      (await fetch(origin + "/api/picos/runtime-test/state", { headers: { Authorization: `Bearer ${guest}` } })).status,
      403,
    );
    const owner = { Authorization: `Bearer ${sessionToken(password)}` };
    const state = await fetch(origin + "/api/picos/runtime-test/state", { headers: owner });
    assert.equal(state.status, 200);
    assert.equal(state.headers.get("cache-control"), "no-store");
    assert.deepEqual(await state.json(), { features: ["wifi"], wifi: { ssid: "saved-network", transport: "native" } });
    const refused = await fetch(origin + "/api/picos/runtime-test/flash", {
      method: "POST",
      headers: { ...owner, "Content-Type": "application/json", Origin: "https://elsewhere.test" },
      body: JSON.stringify({ features: ["temperature"], wifi: null }),
    });
    assert.equal(refused.status, 403);
    assert.equal(imager.calls.length, 0);
    const result = await fetch(origin + "/api/picos", { headers: owner });
    assert.equal(result.status, 200);
    assert.equal(result.headers.get("cache-control"), "no-store");
    const body: unknown = await result.json();
    assert.deepEqual(body, {
      targets: [target],
      activeRunId: null,
      pollMilliseconds: imageSettings().pollMilliseconds,
    });
    assert.equal(
      (await fetch(origin + "/api/picos/runtime-test/flash", { method: "POST", headers: owner, body: "{}" })).status,
      415,
    );
    assert.equal(
      (
        await fetch(origin + "/api/picos/runtime-test/flash", {
          method: "POST",
          headers: { ...owner, "Content-Type": "application/json" },
          body: "{",
        })
      ).status,
      400,
    );
  } finally {
    accounts.close();
    clicks.close();
  }
});

test("invalid options, missing boards and concurrent submissions never launch another flash", async () => {
  const imager = new Imager();
  const runs = new PicoRuns(imager, imageSettings(), null);
  for (const value of [
    { features: [], wifi: null },
    { features: ["health"], wifi: null },
    { features: ["i2c"], wifi: null },
    { features: ["temperature", "temperature"], wifi: null },
    { features: ["bad"], wifi: null },
    { features: ["temperature"], wifi: null, port: "/dev/untrusted" },
    { features: ["temperature"] },
    { features: ["wifi"], wifi: null },
  ]) {
    await assert.rejects(runs.start(target.id, value));
  }
  await assert.rejects(
    runs.start("gone", { features: ["temperature"], wifi: null }),
    (error: unknown) => error instanceof PicoError && error.status === 404,
  );
  assert.equal(imager.calls.length, 0);
  const run = await runs.start(target.id, { features: ["temperature"], wifi: null });
  assert.equal(imager.calls.length, 1);
  await assert.rejects(
    runs.start(target.id, { features: ["temperature"], wifi: null }),
    (error: unknown) => error instanceof PicoError && error.status === 409,
  );
  imager.events = passedTemperature;
  imager.release();
  await tick();
  assert.equal(runs.get(run.id).status, "passed");
  assert.deepEqual(runs.get(run.id).checks[0]?.evidence, { celsius: 24 });
});

test("completion needs every selected observed result and rejects impossible evidence", async () => {
  for (const events of [
    [{ type: "result", status: "passed", message: "Copied" }],
    [{ type: "stage", stage: "copied", message: "Copied" }, ...passedTemperature],
    [
      {
        type: "check",
        check: { feature: "temperature", status: "passed", message: "Bad sample", evidence: { celsius: Infinity } },
      },
    ],
    [],
  ]) {
    const imager = new Imager();
    const runs = new PicoRuns(imager, imageSettings(), null);
    const run = await runs.start(target.id, { features: ["temperature"], wifi: null });
    imager.events = events;
    imager.release();
    await tick();
    assert.equal(runs.get(run.id).status, "failed");
    assert.equal(runs.get(run.id).checks[0]?.status, "failed");
  }
});

test("run persistence excludes credentials and marks interrupted work failed on restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pico-runs-"));
  const file = join(directory, "runs.json");
  const imager = new Imager();
  try {
    const runs = new PicoRuns(imager, imageSettings(), file);
    const run = await runs.start(target.id, {
      features: ["wifi"],
      wifi: { ssid: "fixture", password: "private-password-fixture", transport: "esp8285" },
    });
    assert.ok(!readFileSync(file, "utf8").includes("private-password-fixture"));
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const restored = new PicoRuns(new Imager(), imageSettings(), file);
    assert.equal(restored.get(run.id).status, "failed");
    imager.events = [
      { type: "stage", stage: "testing", message: "private-password-fixture", runtimeTargetId: null },
      { type: "result", status: "failed", message: "private-password-fixture" },
    ];
    imager.release();
    await tick();
    assert.ok(!JSON.stringify(runs.get(run.id)).includes("private-password-fixture"));
    assert.ok(!readFileSync(file, "utf8").includes("private-password-fixture"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("USB mode changes retain a board's latest results", async () => {
  const imager = new Imager();
  const runs = new PicoRuns(imager, imageSettings(), null);
  const run = await runs.start(target.id, { features: ["temperature"], wifi: null });
  const runtimeTargetId = "runtime-abcdef";
  imager.events = [{ type: "stage", stage: "returned", message: "Returned", runtimeTargetId }, ...passedTemperature];
  imager.release();
  await tick();
  imager.targets = [{ ...target, id: runtimeTargetId }];
  assert.equal((await runs.inventory()).targets[0]?.latestRunId, run.id);
});

test("saved Wi-Fi requests retain the network and transport without persisting a password", async () => {
  const imager = new Imager();
  const runs = new PicoRuns(imager, imageSettings(), null);
  const request = { features: ["wifi"], wifi: { ssid: "saved-network", password: null, transport: "native" } };
  const run = await runs.start(target.id, request);
  assert.deepEqual(imager.calls[0], request);
  assert.equal(run.wifiTransport, "native");
  await assert.rejects(runs.state(target.id), (error: unknown) => error instanceof PicoError && error.status === 409);
  imager.events = [{ type: "result", status: "failed", message: "Fixture stopped" }];
  imager.release();
  await tick();
  assert.deepEqual(await runs.state(target.id), await imager.state());
});

test("inspection prevents a concurrent flash and releases its lock after failure", async () => {
  const imager = new Imager();
  let reject: (reason: Error) => void = () => {};
  imager.state = () =>
    new Promise((_resolve, failure) => {
      reject = failure;
    });
  const runs = new PicoRuns(imager, imageSettings(), null);
  const inspected = runs.state(target.id);
  await assert.rejects(runs.start(target.id, { features: ["temperature"], wifi: null }));
  reject(new Error("USB failure"));
  await assert.rejects(inspected);
  await runs.start(target.id, { features: ["temperature"], wifi: null });
  imager.events = passedTemperature;
  imager.release();
  await tick();
});

test("the component adapter refuses malformed process output", async () => {
  const adapter = new ImageCommand({
    ...imageSettings(),
    command: [process.execPath, "-e", "process.stdout.write('not JSON')"],
  });
  await assert.rejects(adapter.discover());
});

test("public radio metadata remains valid when its name matches the supplied password", async () => {
  const imager = new Imager();
  const runs = new PicoRuns(imager, imageSettings(), null);
  const run = await runs.start(target.id, {
    features: ["wifi"],
    wifi: { ssid: "fixture", password: "native", transport: "native" },
  });
  imager.events = [
    {
      type: "check",
      check: {
        feature: "wifi",
        status: "passed",
        message: "Connected",
        evidence: { transport: "native", ip: "192.0.2.1" },
      },
    },
    { type: "result", status: "passed", message: "Verified" },
  ];
  imager.release();
  await tick();
  assert.equal(runs.get(run.id).status, "passed");
  assert.equal(runs.get(run.id).wifiTransport, "native");
});

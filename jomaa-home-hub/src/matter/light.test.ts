import assert from "node:assert/strict";
import { test } from "node:test";
import type { MatterDeviceConfig } from "../config.js";
import { noChange, noFeatures, RGB } from "../device.js";
import { parseConfig } from "../config.js";
import { GoveeClient } from "../govee.js";
import { Hub } from "../hub.js";
import { MatterLight } from "./light.js";
import { MatterError, MatterNotReadyError, summarize, type MatterNode, type MatterNodes } from "./nodes.js";

interface Sent {
  nodeId: number;
  endpoint: number;
  cluster: number;
  command: string;
  payload: Record<string, unknown>;
}

const observation = { displayName: null, lastSeen: null, uptimeSeconds: null, uptimeObservedAt: null };

/** Stands in for the controller: serves node attributes and records commands. */
class FakeMatter implements MatterNodes {
  ready = true;
  sent: Sent[] = [];
  fail = new Set<string>();
  readonly nodes = new Map<number, MatterNode>();

  constructor(...nodes: MatterNode[]) {
    for (const n of nodes) this.nodes.set(n.nodeId, n);
  }

  node(nodeId: number): MatterNode | null {
    return this.nodes.get(nodeId) ?? null;
  }

  invoke(nodeId: number, endpoint: number, cluster: number, command: string, payload: Record<string, unknown>) {
    this.sent.push({ nodeId, endpoint, cluster, command, payload });
    return this.fail.has(command) ? Promise.reject(new MatterError("device did not respond")) : Promise.resolve();
  }
}

const colorBulb = (): MatterNode => ({
  ...observation,
  nodeId: 1,
  available: true,
  isBridge: false,
  attributes: {
    "0/40/1": "Acme",
    "0/40/3": "Bulb",
    "1/6/0": true,
    "1/8/0": 127,
    "1/768/0": 0,
    "1/768/7": 250,
    "1/768/16395": 153,
    "1/768/16396": 500,
  },
});

const plug = (): MatterNode => ({
  ...observation,
  nodeId: 2,
  available: true,
  isBridge: false,
  attributes: { "1/6/0": false },
});
const signal = new AbortController().signal;

function light(m: MatterNodes, nodeId: number): MatterLight {
  const cfg: MatterDeviceConfig = {
    driver: "matter",
    id: `node-${nodeId}`,
    name: "Light",
    nodeId,
    endpoint: 1,
    minKelvin: 2700,
    maxKelvin: 6500,
  };
  return new MatterLight(m, cfg);
}

test("state comes from the node's attributes", async () => {
  const l = light(new FakeMatter(colorBulb()), 1);
  // 127/254 = 50%; 250 mireds = 4000K in a 2000-6536K range = 44%.
  assert.deepEqual(await l.state(), { on: true, brightness: 50, colorTemperaturePct: 44 });
  assert.deepEqual(l.features(), { brightness: true, colorTemperature: true, color: true });
});

test("attribute changes show up in state", async () => {
  const m = new FakeMatter(colorBulb());
  const l = light(m, 1);
  m.nodes.set(1, { ...colorBulb(), attributes: { ...colorBulb().attributes, "1/6/0": false, "1/8/0": null } });
  assert.deepEqual(await l.state(), { on: false, brightness: 0, colorTemperaturePct: 44 });
  m.nodes.set(1, { ...colorBulb(), available: false });
  await assert.rejects(l.state(), /unreachable/);
});

test("apply sends cluster commands", async () => {
  const m = new FakeMatter(colorBulb());
  const l = light(m, 1);
  await l.apply({ on: true, brightness: 100, colorTemperaturePct: 0, color: RGB.parse("#ff0000") }, signal);
  const opts = { transitionTime: 0, optionsMask: 0, optionsOverride: 0 };
  assert.deepEqual(m.sent, [
    { nodeId: 1, endpoint: 1, cluster: 6, command: "on", payload: {} },
    { nodeId: 1, endpoint: 1, cluster: 8, command: "moveToLevelWithOnOff", payload: { level: 254, ...opts } },
    // The warmest white the bulb reports.
    {
      nodeId: 1,
      endpoint: 1,
      cluster: 768,
      command: "moveToColorTemperature",
      payload: { colorTemperatureMireds: 500, ...opts },
    },
    {
      nodeId: 1,
      endpoint: 1,
      cluster: 768,
      command: "moveToHueAndSaturation",
      payload: { hue: 0, saturation: 254, ...opts },
    },
  ]);
});

test("turning off skips levels", async () => {
  const m = new FakeMatter(colorBulb());
  await light(m, 1).apply({ ...noChange, on: false, brightness: 40 }, signal);
  assert.deepEqual(
    m.sent.map((s) => s.command),
    ["off"],
  );
});

test("a plug ignores level and color", async () => {
  const m = new FakeMatter(plug());
  const l = light(m, 2);
  await l.apply({ ...noChange, on: true, brightness: 40, colorTemperaturePct: 10 }, signal);
  assert.deepEqual(
    m.sent.map((s) => s.command),
    ["on"],
  );
  assert.deepEqual(l.features(), noFeatures);
});

test("controller errors come back", async () => {
  const m = new FakeMatter(colorBulb());
  m.fail.add("off");
  await assert.rejects(light(m, 1).apply({ ...noChange, on: false }, signal), /device did not respond/);
});

test("an unknown node is an error, and says why", async () => {
  const m = new FakeMatter();
  const l = light(m, 99);
  await assert.rejects(l.state(), /not commissioned/);
  m.ready = false;
  await assert.rejects(l.state(), MatterNotReadyError);
});

test("node summaries", () => {
  assert.deepEqual(summarize(colorBulb()), {
    nodeId: 1,
    available: true,
    isBridge: false,
    lightEndpoints: [1],
    vendor: "Acme",
    product: "Bulb",
    label: null,
    lastSeen: null,
    uptimeSeconds: null,
    uptimeObservedAt: null,
  });
  assert.deepEqual(summarize(plug()), {
    nodeId: 2,
    available: true,
    isBridge: false,
    lightEndpoints: [1],
    vendor: null,
    product: null,
    label: null,
    lastSeen: null,
    uptimeSeconds: null,
    uptimeObservedAt: null,
  });
});

test("living-room commands translate coffee-table and Govee controls through their existing drivers", async () => {
  const cfg = parseConfig(
    JSON.stringify({
      devices: [
        { id: "coffee-table", name: "coffee-table", driver: "matter", nodeId: 3, endpoint: 1 },
        {
          id: "other-light",
          name: "Other",
          driver: "govee",
          sku: "test",
          device: "test",
          minKelvin: 2700,
          maxKelvin: 6500,
        },
      ],
      rooms: [{ id: "living-room", name: "Living Room", members: ["coffee-table", "other-light"] }],
    }),
  );
  const matter = new FakeMatter({ ...colorBulb(), nodeId: 3 });
  const govee = new GoveeClient("test", "http://127.0.0.1:1");
  const requests: Array<Parameters<GoveeClient["post"]>[1]> = [];
  govee.post = (_path, payload) => {
    requests.push(payload);
    return Promise.resolve({});
  };
  const hub = Hub.build(cfg, govee, matter);
  await hub.command(
    "living-room",
    { ...noChange, on: true, brightness: 50, colorTemperaturePct: 25, color: RGB.parse("#ff0000") },
    "test",
    1,
    signal,
  );
  assert.deepEqual(
    matter.sent.map((call) => [call.command, call.payload]),
    [
      ["on", {}],
      ["moveToLevelWithOnOff", { level: 127, transitionTime: 0, optionsMask: 0, optionsOverride: 0 }],
      [
        "moveToColorTemperature",
        { colorTemperatureMireds: 319, transitionTime: 0, optionsMask: 0, optionsOverride: 0 },
      ],
      ["moveToHueAndSaturation", { hue: 0, saturation: 254, transitionTime: 0, optionsMask: 0, optionsOverride: 0 }],
    ],
  );
  const capabilities = requests.map((request) => ("capability" in request ? request.capability : null));
  assert.deepEqual(
    capabilities.map((capability) => capability?.value),
    [1, 50, 3650, 0xff0000],
  );
  matter.nodes.set(3, { ...colorBulb(), nodeId: 3, displayName: "Renamed coffee-table" });
  assert.equal(hub.list().find((target) => target.id === "coffee-table")?.name, "Renamed coffee-table");
  const count = matter.sent.length;
  await hub.command("living-room", { ...noChange, on: false, brightness: 50 }, "test", 2, signal);
  assert.deepEqual(
    matter.sent.slice(count).map((call) => call.command),
    ["off"],
  );
});

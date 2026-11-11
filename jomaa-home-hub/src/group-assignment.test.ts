import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Api, sessionToken } from "./api.js";
import { parseConfig } from "./config.js";
import { GoveeClient } from "./govee.js";
import { Hub } from "./hub.js";
import { HealthStore } from "./health/store.js";
import { silentLog } from "./log.js";
import type { MatterAdmin, MatterNodes, NodeSummary } from "./matter/nodes.js";
import { serve } from "./testing.js";

test("group edits persist room membership and update the running fan-out", async () => {
  const directory = mkdtempSync(join(tmpdir(), "matter-group-"));
  const path = join(directory, "config.json");
  const cfg = {
    devices: [{ driver: "matter", id: "coffee-table", name: "coffee-table", nodeId: 3, endpoint: 1 }],
    rooms: [
      { id: "living-room", name: "Living Room", members: ["coffee-table"] },
      { id: "bedroom", name: "Bedroom", members: [] },
    ],
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
    type: "Light",
    capabilities: ["Power"],
  };
  const controller: MatterNodes & MatterAdmin = {
    ready: true,
    node: () => ({
      nodeId: 3,
      available: true,
      isBridge: false,
      attributes: { "1/6/0": true },
      displayName: "coffee-table",
      lastSeen: null,
      uptimeSeconds: null,
      uptimeObservedAt: null,
    }),
    nodes: () => [summary],
    invoke: () => Promise.resolve(),
    discover: () => Promise.resolve([]),
    register: () => Promise.reject(new Error("unused")),
    rename: () => Promise.resolve(summary),
    commission: () => Promise.reject(new Error("unused")),
    setWiFiCredentials: () => Promise.resolve(),
    setThreadDataset: () => Promise.resolve(),
    removeNode: () => Promise.resolve(),
  };
  const store = new HealthStore(":memory:");
  const hub = Hub.build(parseConfig(JSON.stringify(cfg)), new GoveeClient("test", "http://127.0.0.1:1"), controller);
  const origin = await serve(new Api(hub, controller, "test-password", silentLog, store, path).handle);
  const headers = { Authorization: `Bearer ${sessionToken("test-password")}`, "Content-Type": "application/json" };
  const save = (body: unknown) =>
    fetch(origin + "/api/matter/nodes/3/group", { method: "PATCH", headers, body: JSON.stringify(body) });
  try {
    assert.equal((await save({})).status, 400);
    assert.equal((await save({ groupId: "missing" })).status, 400);
    assert.deepEqual(hub.groupsForMatter(3), ["Living Room"]);
    const moved = await save({ groupId: "bedroom" });
    assert.equal(moved.status, 200);
    assert.deepEqual(hub.groupsForMatter(3), ["Bedroom"]);
    const persisted = parseConfig(readFileSync(path, "utf8"));
    assert.deepEqual(persisted.rooms[0]?.members, []);
    assert.deepEqual(persisted.rooms[1]?.members, ["coffee-table"]);
    const rebuilt = Hub.build(persisted, new GoveeClient("test", "http://127.0.0.1:1"), controller);
    assert.deepEqual(rebuilt.groupsForMatter(3), ["Bedroom"]);
    assert.equal((await save({ groupId: null })).status, 200);
    assert.deepEqual(hub.groupsForMatter(3), []);
    const inventory = (await (await fetch(origin + "/api/devices", { headers })).json()) as {
      groups: unknown[];
      matterNodes: Array<{ groupIds: string[] }>;
    };
    assert.deepEqual(inventory.groups, [
      { id: "living-room", name: "Living Room" },
      { id: "bedroom", name: "Bedroom" },
    ]);
    assert.deepEqual(inventory.matterNodes[0]?.groupIds, []);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

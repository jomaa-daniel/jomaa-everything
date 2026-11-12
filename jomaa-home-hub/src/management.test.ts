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
import type { MatterAdmin, MatterNodes, NodeSummary } from "./matter/nodes.js";
import { Organization } from "./organization.js";
import { Accounts } from "./accounts.js";
import { silentLog } from "./log.js";
import { serve } from "./testing.js";

test("management edits categories, rooms and assignments without changing reported capabilities", async () => {
  const directory = mkdtempSync(join(tmpdir(), "management-"));
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
    rename: () => Promise.resolve(summary),
    commission: () => Promise.reject(new Error("unused")),
    setWiFiCredentials: () => Promise.resolve(),
    setThreadDataset: () => Promise.resolve(),
    removeNode: () => Promise.resolve(),
  };
  const organization = new Organization(":memory:");
  const health = new HealthStore(":memory:");
  health.enroll({ id: "pico-test", name: "Pico" });
  const hub = Hub.build(parseConfig(JSON.stringify(cfg)), new GoveeClient("test", "http://127.0.0.1:1"), matter);
  const origin = await serve(
    new Api(hub, matter, "management-test", new Accounts(":memory:"), silentLog, health, path, organization).handle,
  );
  const headers = { Authorization: `Bearer ${sessionToken("management-test")}`, "Content-Type": "application/json" };
  const read = async () =>
    (await (await fetch(origin + "/api/manage", { headers })).json()) as {
      types: Array<{ id: string; name: string }>;
      groups: Array<{ id: string; name: string }>;
      devices: Array<{ key: string; typeId: string | null; reportedType: string; groupIds: string[] }>;
    };
  const save = (body: unknown) =>
    fetch(origin + "/api/manage", { method: "POST", headers, body: JSON.stringify(body) });
  try {
    assert.equal((await fetch(origin + "/api/manage")).status, 401);
    assert.equal((await fetch(origin + "/api/manage", { method: "POST", body: "{}" })).status, 401);
    assert.equal(
      (
        await fetch(origin + "/api/manage", {
          method: "POST",
          headers: { ...headers, Origin: "https://foreign.example" },
          body: JSON.stringify({ action: "type.create", name: "Unwanted" }),
        })
      ).status,
      403,
    );
    assert.equal((await save({ action: "type.create", name: "Light strips" })).status, 200);
    assert.equal((await save({ action: "group.create", name: "Office" })).status, 200);
    let state = await read();
    assert.equal(state.devices.length, 3);
    const type = state.types[0];
    const office = state.groups.find((group) => group.name === "Office");
    assert.ok(type);
    assert.ok(office);
    for (const body of [
      { action: "type.create", name: "light STRIPS" },
      { action: "device.assign", key: "missing", typeId: null },
      { action: "device.assign", key: "matter:3", typeId: "missing" },
      { action: "device.assign", key: "matter:3", groupIds: "wrong" },
      { action: "device.assign", key: "matter:3", groupIds: ["missing"] },
    ])
      assert.equal((await save(body)).status, 400);
    assert.equal(
      (await save({ action: "device.assign", key: "matter:3", typeId: type.id, groupIds: [office.id] })).status,
      200,
    );
    assert.equal(
      (await save({ action: "device.assign", key: "health:pico-test", typeId: type.id, groupIds: [office.id] })).status,
      200,
    );
    assert.deepEqual(hub.groupsForMatter(3), ["Office"]);
    state = await read();
    assert.equal(state.devices.find((device) => device.key === "matter:3")?.reportedType, "Extended Color Light");
    assert.deepEqual(state.devices.find((device) => device.key === "health:pico-test")?.groupIds, [office.id]);
    const inventory = (await (await fetch(origin + "/api/devices", { headers })).json()) as {
      devices: Array<{ assignedType: { id: string }; groups: string[] }>;
      matterNodes: Array<{ assignedType: { id: string }; groups: string[] }>;
    };
    assert.equal(inventory.devices[0]?.assignedType.id, type.id);
    assert.deepEqual(inventory.devices[0].groups, ["Office"]);
    assert.equal(inventory.matterNodes[0]?.assignedType.id, type.id);
    assert.equal((await save({ action: "device.assign", key: "target:lamp", groupIds: [office.id] })).status, 200);
    assert.deepEqual(hub.directGroupsForTarget("lamp"), [office.id]);
    assert.equal((await save({ action: "device.assign", key: "target:lamp", typeId: type.id })).status, 200);
    assert.deepEqual(hub.directGroupsForTarget("lamp"), [office.id]);
    assert.equal((await save({ action: "device.assign", key: "target:lamp", groupIds: ["living-room"] })).status, 200);
    assert.equal(organization.assignedType("target:lamp")?.id, type.id);
    const concurrent = await Promise.all([
      save({ action: "device.assign", key: "matter:3", typeId: type.id, groupIds: [office.id] }),
      save({ action: "type.delete", id: type.id }),
    ]);
    assert.deepEqual(
      concurrent.map((response) => response.status),
      [200, 200],
    );
    assert.deepEqual(hub.groupsForMatter(3), ["Office"]);
    assert.equal(organization.assignedType("matter:3"), null);
    assert.equal((await save({ action: "group.rename", id: office.id, name: "Study" })).status, 200);
    assert.deepEqual(hub.groupsForMatter(3), ["Study"]);
    assert.equal((await save({ action: "group.delete", id: office.id })).status, 200);
    assert.deepEqual(hub.groupsForMatter(3), []);
    assert.deepEqual(organization.groups("health:pico-test"), []);
    assert.equal((await save({ action: "type.delete", id: type.id })).status, 400);
    assert.equal(organization.assignedType("matter:3"), null);
    const persisted = parseConfig(readFileSync(path, "utf8"));
    assert.equal(persisted.rooms.length, 1);
    assert.deepEqual(persisted.rooms[0]?.members, ["lamp"]);
  } finally {
    health.close();
    organization.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

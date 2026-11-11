import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { silentLog } from "../log.js";
import { MatterInventory, MatterMonitor, uptimeAttribute, uptimeSeconds, type ObservationReader } from "./inventory.js";

test("Matter names and observations persist without renaming inventing contact", () => {
  const directory = mkdtempSync(join(tmpdir(), "matter-inventory-"));
  const path = join(directory, "inventory.sqlite");
  let store = new MatterInventory(path);
  try {
    store.now = () => 1000;
    store.seen(3, 0);
    store.now = () => 2000;
    store.rename(3, " coffee-table ");
    assert.deepEqual(store.get(3), {
      displayName: "coffee-table",
      lastSeen: 1000,
      uptimeSeconds: 0,
      uptimeObservedAt: 1000,
    });
    assert.equal(statSync(path).mode & 0o777, 0o600);
    store.close();
    store = new MatterInventory(path);
    assert.equal(store.get(3).displayName, "coffee-table");
    assert.equal(store.get(3).lastSeen, 1000);
    store.remove(3);
    assert.deepEqual(store.get(3), { displayName: null, lastSeen: null, uptimeSeconds: null, uptimeObservedAt: null });
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("diagnostic values accept safe device integers and preserve zero", () => {
  assert.equal(uptimeSeconds(0), 0);
  assert.equal(uptimeSeconds(123n), 123);
  for (const value of [undefined, null, "123", -1, 1.5, NaN, Infinity, BigInt(Number.MAX_SAFE_INTEGER) + 1n]) {
    assert.equal(uptimeSeconds(value), null);
  }
});

test("successful reads update last-seen and uptime; failures and snapshots do not", async () => {
  const store = new MatterInventory(":memory:");
  let now = 1000;
  let failure = false;
  let attributes: Record<string, unknown> = { "0/40/1": "GE", [uptimeAttribute]: 120n };
  store.now = () => now;
  const reader: ObservationReader = {
    nodes: () => [{ nodeId: 3, available: true, supportsUptime: true }],
    hasNode: () => true,
    read: () => (failure ? Promise.reject(new Error("offline")) : Promise.resolve(attributes)),
  };
  const monitor = new MatterMonitor(reader, store, silentLog);
  try {
    await monitor.probe(3);
    assert.equal(store.get(3).lastSeen, 1000);
    assert.equal(store.get(3).uptimeSeconds, 120);
    now = 2000;
    store.get(3);
    failure = true;
    await monitor.probe(3);
    assert.equal(store.get(3).lastSeen, 1000);
    assert.equal(store.get(3).uptimeSeconds, 120);
    failure = false;
    attributes = { "0/40/1": "GE" };
    await monitor.probe(3);
    assert.equal(store.get(3).lastSeen, 2000);
    assert.equal(store.get(3).uptimeSeconds, null);
  } finally {
    monitor.stop();
    store.close();
  }
});

test("unsupported uptime is probed once until capabilities are refreshed", async () => {
  const store = new MatterInventory(":memory:");
  const requests: string[][] = [];
  const reader: ObservationReader = {
    nodes: () => [{ nodeId: 3, available: true, supportsUptime: false }],
    hasNode: () => true,
    read: (_id, paths) => {
      requests.push(paths);
      return Promise.resolve({ "0/40/1": "GE" });
    },
  };
  const monitor = new MatterMonitor(reader, store, silentLog);
  try {
    await monitor.probe(3);
    await monitor.probe(3);
    assert.ok(requests[0]?.includes(uptimeAttribute));
    assert.deepEqual(requests[1], ["0/40/1"]);
  } finally {
    monitor.stop();
    store.close();
  }
});

test("pending reads are coalesced and cannot record contact after removal", async () => {
  const store = new MatterInventory(":memory:");
  let exists = true;
  let reads = 0;
  let finish: (value: Record<string, unknown>) => void = () => {};
  const reader: ObservationReader = {
    nodes: () => [{ nodeId: 3, available: true, supportsUptime: true }],
    hasNode: () => exists,
    read: () => {
      reads++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  };
  const monitor = new MatterMonitor(reader, store, silentLog);
  try {
    const pending = monitor.probe(3);
    await Promise.resolve();
    assert.equal(monitor.probe(3), undefined);
    assert.equal(reads, 1);
    exists = false;
    finish({ [uptimeAttribute]: 120 });
    await pending;
    assert.equal(store.get(3).lastSeen, null);
  } finally {
    monitor.stop();
    store.close();
  }
});

test("stopping before a queued probe prevents a network read", async () => {
  const store = new MatterInventory(":memory:");
  let reads = 0;
  const monitor = new MatterMonitor(
    {
      nodes: () => [{ nodeId: 3, available: true, supportsUptime: false }],
      hasNode: () => true,
      read: () => {
        reads++;
        return Promise.resolve({});
      },
    },
    store,
    silentLog,
  );
  const pending = monitor.probe(3);
  monitor.stop();
  await pending;
  assert.equal(reads, 0);
  assert.equal(store.get(3).lastSeen, null);
  store.close();
});

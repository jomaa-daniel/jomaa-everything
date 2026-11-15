import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { condense, expand } from "./i2c.js";
import { HealthStore } from "./store.js";

const empty = { bootId: "abcdef0123456789", sequence: 0, bus: 0, startUs: 0, endUs: 1000000, data: "", dropped: 0 };

test("empty intervals occupy one durable row while zero bytes round-trip as captured data", () => {
  const dir = mkdtempSync(join(tmpdir(), "i2c-store-"));
  const path = join(dir, "health.sqlite");
  let store = new HealthStore(path);
  try {
    store.enroll({ id: "pico-test", name: "Pico" });
    for (let sequence = 0; sequence < 1000; sequence++) {
      store.i2c.record("pico-test", {
        ...empty,
        sequence,
        startUs: sequence * 1000000,
        endUs: (sequence + 1) * 1000000,
      });
    }
    const logs = store.i2c.logs("pico-test").logs;
    assert.equal(logs.length, 1);
    assert.equal(logs[0]?.condensed, "empty:1000");
    assert.equal(logs[0].captures, 1000);
    assert.equal(logs[0].endUs, 1000000000);
    const zeros = "00".repeat(1000);
    store.i2c.record("pico-test", { ...empty, sequence: 1000, startUs: 1000000000, endUs: 1001000000, data: zeros });
    store.close();
    store = new HealthStore(path);
    assert.equal(store.i2c.logs("pico-test").logs[0]?.data, zeros);
    assert.equal(store.i2c.logs("pico-test").logs[0]?.condensed, "zero:1000");
    const db = new DatabaseSync(path, { readOnly: true });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM i2c_logs").get()?.["n"], 2);
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name='health_logs'").get());
    db.close();
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("duplicates, bus changes, reboot boundaries, timing gaps and loss remain distinguishable", () => {
  const store = new HealthStore(":memory:");
  try {
    store.enroll({ id: "pico-test", name: "Pico" });
    const events: number[] = [];
    const unsubscribe = store.i2c.subscribe("pico-test", (entry) => events.push(entry.id));
    store.i2c.record("pico-test", empty);
    assert.equal(store.i2c.record("pico-test", empty).duplicate, true);
    assert.equal(events.length, 1);
    store.i2c.record("pico-test", { ...empty, sequence: 1, startUs: 1000000, endUs: 2000000 });
    assert.equal(events[0], events[1], "merged idle row is updated in the live view");
    store.i2c.record("pico-test", { ...empty, bus: 1 });
    store.i2c.record("pico-test", { ...empty, sequence: 3, startUs: 3000000, endUs: 4000000, dropped: 10 });
    store.i2c.record("pico-test", { ...empty, bootId: "fedcba9876543210" });
    assert.equal(store.i2c.logs("pico-test").logs.length, 4);
    assert.throws(() => store.i2c.record("pico-test", { ...empty, sequence: 4 }), /overlap/);
    assert.throws(() => store.i2c.record("pico-test", { ...empty, data: "0" }), /hexadecimal/);
    assert.throws(() => store.i2c.record("pico-test", { ...empty, data: "aa".repeat(10000) }), /bounded/);
    unsubscribe();
    store.i2c.record("pico-test", { ...empty, bootId: "0123456789abcdef" });
    assert.equal(events.length, 5);
  } finally {
    store.close();
  }
});

test("compression preserves literal, repetitive and arbitrary bytes", () => {
  for (const value of [
    "",
    "00".repeat(100),
    "aa".repeat(1000),
    "001122ffeedd",
    Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0")).join(""),
  ])
    assert.equal(expand(condense(value, 1)), value);
});

test("raw history follows health retention without losing retry sequence tracking", () => {
  const store = new HealthStore(":memory:", 1);
  try {
    store.now = () => 0;
    store.enroll({ id: "pico-test", name: "Pico" });
    store.i2c.record("pico-test", empty);
    store.now = () => 86400001;
    store.prune();
    assert.equal(store.i2c.logs("pico-test").logs.length, 0);
    assert.equal(store.i2c.record("pico-test", empty).duplicate, true);
  } finally {
    store.close();
  }
});

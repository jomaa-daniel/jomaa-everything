import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HealthError, HealthStore } from "./store.js";

const ping = {
  bootId: "0123456789abcdef",
  sequence: 0,
  firmware: "test/1",
  uptimeSeconds: 60,
  freeHeapBytes: 100000,
  rssi: -51,
  ip: "192.168.1.10",
  status: "healthy",
};

await test("enrollment, registration, retries, stale status, rename and revocation", () => {
  const store = new HealthStore(":memory:");
  try {
    let now = 1800000000000;
    store.now = () => now;
    const issued = store.enroll({ id: "pico-office", name: "Office Pico", intervalSeconds: 60 });
    assert.equal(issued.device.status, "pending");
    assert.equal(issued.device.registeredAt, null);
    assert.throws(() => {
      store.authenticate("other-device", issued.token);
    }, HealthError);
    assert.throws(() => {
      store.authenticate("pico-office", "a".repeat(64));
    }, HealthError);
    assert.throws(() => store.enroll({ id: "pico-office", name: "Duplicate" }), HealthError);
    store.authenticate("pico-office", issued.token);
    assert.deepEqual(store.record("pico-office", ping), {
      registered: true,
      duplicate: false,
      nextIntervalSeconds: 60,
    });
    assert.equal(store.get("pico-office").status, "online");
    now += 60000;
    assert.equal(store.record("pico-office", ping).duplicate, true);
    assert.equal(store.get("pico-office").lastSeen, now - 60000);
    assert.equal(store.logs("pico-office").logs.length, 1);
    store.record("pico-office", { ...ping, sequence: 1, status: "degraded", message: "Low free heap" });
    assert.equal(store.get("pico-office").status, "degraded");
    assert.throws(
      () => store.record("pico-office", { ...ping, sequence: 2 }),
      (error: unknown) => error instanceof HealthError && error.status === 429,
    );
    now += 181000;
    assert.equal(store.get("pico-office").status, "offline");
    store.update("pico-office", { name: "Study", intervalSeconds: 120 });
    assert.equal(store.get("pico-office").name, "Study");
    assert.equal(store.get("pico-office").status, "degraded");
    store.revoke("pico-office");
    assert.equal(store.get("pico-office").status, "revoked");
    assert.throws(() => {
      store.authenticate("pico-office", issued.token);
    }, HealthError);
    const replacement = store.rotate("pico-office");
    assert.throws(() => {
      store.authenticate("pico-office", issued.token);
    }, HealthError);
    store.authenticate("pico-office", replacement.token);
    assert.equal(store.logs("pico-office").logs.length, 2);
  } finally {
    store.close();
  }
});

await test("database persists registration and hashed credentials; cursor pagination and retention", () => {
  const dir = mkdtempSync(join(tmpdir(), "jomaa-health-"));
  const path = join(dir, "health.sqlite");
  let store = new HealthStore(path, 1);
  try {
    let now = Date.now();
    store.now = () => now;
    const { token } = store.enroll({ id: "pico-test", name: "Test" });
    for (let sequence = 0; sequence < 3; sequence++) {
      store.record("pico-test", { ...ping, sequence });
      now += 60000;
    }
    const first = store.logs("pico-test", 2);
    assert.equal(first.logs.length, 2);
    assert.equal(store.logs("pico-test", 2, first.nextCursor ?? undefined).logs.length, 1);
    store.close();
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(readFileSync(path).includes(Buffer.from(token)), false);
    store = new HealthStore(path, 1);
    store.authenticate("pico-test", token);
    assert.equal(store.logs("pico-test").logs.length, 3);
    assert.notEqual(store.get("pico-test").registeredAt, null);
    store.now = () => now + 86400_000;
    store.prune();
    assert.equal(store.logs("pico-test").logs.length, 0);
    assert.equal(store.get("pico-test").status, "offline");
    assert.equal(store.record("pico-test", { ...ping, sequence: 2 }).duplicate, true);
    assert.equal(store.get("pico-test").status, "offline");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("invalid reports cannot register devices or enter logs", () => {
  const store = new HealthStore(":memory:");
  try {
    store.enroll({ id: "pico-test", name: "Test" });
    for (const invalid of [
      { ...ping, status: "ok" },
      { ...ping, sequence: -1 },
      { ...ping, freeHeapBytes: null },
      { ...ping, rssi: -150 },
      { ...ping, ip: "not an IP" },
      { ...ping, firmware: "a\nsecret" },
      { ...ping, surprise: true },
      { ...ping, bootId: "not-hexadecimal!!" },
    ]) {
      assert.throws(() => store.record("pico-test", invalid), HealthError);
    }
    assert.equal(store.get("pico-test").status, "pending");
    assert.equal(store.logs("pico-test").logs.length, 0);
  } finally {
    store.close();
  }
});

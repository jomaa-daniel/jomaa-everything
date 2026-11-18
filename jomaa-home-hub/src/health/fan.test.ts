import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FanControl } from "@matter/main/clusters";
import { imageConfigFile } from "../picos.js";
import { HealthStore } from "./store.js";

const bootId = "a".repeat(16);
const secondBoot = "c".repeat(16);
const config = JSON.parse(readFileSync(imageConfigFile, "utf8")) as {
  fan: { startupPercent: number; lowPercent: number; mediumPercent: number; staleMilliseconds: number };
};
const heartbeat = (boot = bootId) => ({
  bootId: boot,
  sequence: 0,
  firmware: "fan/1",
  uptimeSeconds: 1,
  freeHeapBytes: 100000,
  status: "healthy",
});
const report = {
  bootId,
  installId: "b".repeat(32),
  sequence: 0,
  appliedRevision: null,
  percentCurrent: config.fan.startupPercent,
  gpio: 15,
  frequencyHz: 25000,
  inverted: true,
};

test("Matter fan attributes retain requested state until PWM acknowledges the command", (t) => {
  const store = new HealthStore(":memory:");
  t.after(() => {
    store.close();
  });
  store.enroll({ id: "pico-fan", name: "Fan" });
  assert.throws(() => store.fan.get("pico-fan"));
  assert.throws(() => store.fan.record("pico-fan", report));
  store.record("pico-fan", heartbeat());
  assert.equal(store.fan.record("pico-fan", report).command.percentSetting, config.fan.startupPercent);
  assert.equal(store.fan.get("pico-fan").pending, true);
  const request = store.fan.write("pico-fan", { percentSetting: 50 });
  assert.equal(request.percentSetting, 50);
  assert.equal(request.percentCurrent, config.fan.startupPercent);
  assert.equal(request.pending, true);
  assert.equal(request.clusterId, FanControl.id);
  assert.equal(request.fanModeSequence, FanControl.FanModeSequence.OffLowMedHigh);
  assert.equal(store.fan.write("pico-fan", { percentSetting: 50 }).revision, request.revision);
  assert.equal(store.fan.write("pico-fan", { percentSetting: null }).revision, request.revision);
  assert.equal(store.fan.record("pico-fan", report).command.revision, request.revision);
  store.fan.record("pico-fan", { ...report, sequence: 1, appliedRevision: request.revision, percentCurrent: 50 });
  assert.equal(store.fan.get("pico-fan").pending, false);
  assert.equal(store.fan.get("pico-fan").percentCurrent, 50);
  for (const [fanMode, percentSetting] of [
    [0, 0],
    [1, config.fan.lowPercent],
    [2, config.fan.mediumPercent],
    [3, 100],
  ]) {
    const state = store.fan.write("pico-fan", { fanMode });
    assert.equal(state.percentSetting, percentSetting);
    assert.equal(state.fanMode, fanMode);
  }
  for (const body of [
    { fanMode: 5 },
    { percentSetting: -1 },
    { percentSetting: 101 },
    { percentSetting: 1.1 },
    { percentSetting: true },
    { fanMode: 0, percentSetting: 0 },
    { speedSetting: 2 },
  ])
    assert.throws(() => store.fan.write("pico-fan", body));
});

test("stale or replayed PWM reports cannot prove that a setting is applied", (t) => {
  const store = new HealthStore(":memory:");
  t.after(() => {
    store.close();
  });
  let now = 1000;
  store.now = () => now;
  store.enroll({ id: "pico-fan", name: "Fan" });
  store.record("pico-fan", heartbeat());
  store.fan.record("pico-fan", report);
  const command = store.fan.write("pico-fan", { percentSetting: 25 });
  assert.throws(() =>
    store.fan.record("pico-fan", { ...report, sequence: 1, appliedRevision: command.revision, percentCurrent: 50 }),
  );
  assert.throws(() =>
    store.fan.record("pico-fan", { ...report, sequence: 1, appliedRevision: command.revision + 1, percentCurrent: 25 }),
  );
  const applied = { ...report, sequence: 1, appliedRevision: command.revision, percentCurrent: 25 };
  store.fan.record("pico-fan", applied);
  const reportedAt = store.fan.get("pico-fan").reportedAt;
  now += config.fan.staleMilliseconds + 1;
  store.fan.record("pico-fan", applied);
  const state = store.fan.get("pico-fan");
  assert.equal(state.reportedAt, reportedAt);
  assert.equal(state.percentCurrent, null);
  assert.equal(state.percentSetting, 25);
  assert.equal(state.pending, true);
  assert.equal(state.available, false);
  assert.throws(() => store.fan.record("pico-fan", { ...applied, sequence: 2, appliedRevision: null }));
  store.record("pico-fan", heartbeat(secondBoot));
  assert.throws(() => store.fan.get("pico-fan"));
  assert.throws(() => store.fan.record("pico-fan", { ...applied, sequence: 2 }));
  assert.equal(store.fan.record("pico-fan", { ...report, bootId: secondBoot }).command.percentSetting, 25);
  assert.equal(store.fan.get("pico-fan").pending, true);
  store.revoke("pico-fan");
  assert.throws(() => store.fan.write("pico-fan", { percentSetting: 100 }));
});

test("fan requests and report identities persist across a hub restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "pico-fan-"));
  const path = join(directory, "health.sqlite");
  let store = new HealthStore(path);
  try {
    store.enroll({ id: "pico-fan", name: "Fan" });
    store.record("pico-fan", heartbeat());
    store.fan.record("pico-fan", report);
    const written = store.fan.write("pico-fan", { percentSetting: 0 });
    store.close();
    store = new HealthStore(path);
    assert.equal(store.fan.get("pico-fan").revision, written.revision);
    assert.equal(store.fan.get("pico-fan").percentSetting, 0);
    assert.equal(store.fan.get("pico-fan").report.installId, report.installId);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

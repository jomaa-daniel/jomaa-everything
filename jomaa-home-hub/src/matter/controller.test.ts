// Runs the real embedded controller on a fresh fabric in a temporary
// directory. No devices are paired, but everything up to the radio is real.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { silentLog } from "../log.js";
import { Matter } from "./controller.js";
import { MatterError, MatterNotReadyError } from "./nodes.js";

const storage = mkdtempSync(join(tmpdir(), "hub-matter-"));
const matter = new Matter({ storagePath: storage, bluetoothAdapter: null, log: silentLog });
const signal = new AbortController().signal;

before(async () => {
  assert.equal(matter.ready, false);
  assert.throws(() => matter.nodes(), MatterNotReadyError);
  await matter.run();
});

after(async () => {
  await matter.stop();
  rmSync(storage, { recursive: true, force: true });
});

test("starts on the storage the standalone Matter server used", () => {
  assert.ok(matter.ready);
  assert.ok(readdirSync(storage).includes("server-1-fff1"), readdirSync(storage).join(", "));
  assert.deepEqual(matter.nodes(), []);
  assert.equal(matter.node(1), null);
});

test("stores pairing credentials", async () => {
  await matter.setWiFiCredentials("home", "secret");
  await matter.setThreadDataset("0e080000000000010000");
  await assert.rejects(matter.setThreadDataset("0e0"), MatterError);
});

test("rejects commands for unknown nodes", async () => {
  await assert.rejects(
    matter.removeNode(42, signal),
    (err: Error) => err instanceof MatterError && /42/.test(err.message),
  );
  await assert.rejects(matter.invoke(42, 1, 6, "on", {}, signal), MatterError);
});

test("rejects a malformed pairing code", async () => {
  await assert.rejects(matter.commission("MT:not-a-code", true, AbortSignal.timeout(30_000)), MatterError);
});

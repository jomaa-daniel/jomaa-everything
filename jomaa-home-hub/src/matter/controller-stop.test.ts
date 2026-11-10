// Stopping the controller while it is still starting. Its own file, so it runs
// in its own process: a controller left running would keep the process alive.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { newLog } from "../log.js";
import { Matter } from "./controller.js";

test("stop during start closes what the start opened", async () => {
  const storage = mkdtempSync(join(tmpdir(), "hub-matter-"));
  const lines: string[] = [];
  const matter = new Matter({ storagePath: storage, bluetoothAdapter: null, log: newLog({}, (l) => lines.push(l)) });
  try {
    const running = matter.run();
    await matter.stop();
    await running;
    assert.equal(matter.ready, false);
    assert.ok(!lines.some((l) => l.includes("matter controller started")), lines.join("\n"));
  } finally {
    rmSync(storage, { recursive: true, force: true });
  }
});

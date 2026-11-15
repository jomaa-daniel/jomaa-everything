import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Clicks } from "./clicks.js";

test("click counts persist in a private file", () => {
  const directory = mkdtempSync(join(tmpdir(), "clicks-"));
  try {
    const path = join(directory, "data", "clicks.sqlite");
    const first = new Clicks(path);
    first.record("/lights");
    first.record("/lights");
    first.record("/manage");
    first.close();
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const reopened = new Clicks(path);
    assert.deepEqual(
      reopened.counts(),
      new Map([
        ["/lights", 2],
        ["/manage", 1],
      ]),
    );
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

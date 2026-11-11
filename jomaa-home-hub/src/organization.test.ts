import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { Organization } from "./organization.js";

test("custom types and assignments persist and deleting a type clears its assignment", () => {
  const dir = mkdtempSync(join(tmpdir(), "organization-"));
  const path = join(dir, "organization.sqlite");
  let store = new Organization(path);
  try {
    const strips = store.createType("Light strips");
    const sensors = store.createType("Sensors");
    assert.notEqual(strips.hue, sensors.hue);
    store.assign("matter:3", strips.id);
    store.assignGroups("health:pico", ["living-room", "bedroom"]);
    store.renameType(strips.id, "LED strips");
    assert.equal(store.assignedType("matter:3")?.name, "LED strips");
    assert.throws(() => {
      store.renameType(sensors.id, "LED strips");
    }, /exists/);
    store.close();
    store = new Organization(path);
    assert.equal(store.assignedType("matter:3")?.id, strips.id);
    assert.deepEqual(store.groups("health:pico"), ["bedroom", "living-room"]);
    store.deleteType(strips.id);
    assert.equal(store.assignedType("matter:3"), null);
    store.removeGroup("living-room");
    assert.deepEqual(store.groups("health:pico"), ["bedroom"]);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

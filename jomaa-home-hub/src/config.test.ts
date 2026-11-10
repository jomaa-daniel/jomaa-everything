import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { loadConfig, parseConfig, parseListen, usesDriver } from "./config.js";

test("the example config is valid", () => {
  const c = loadConfig(fileURLToPath(new URL("../config.example.json", import.meta.url)));
  assert.ok(usesDriver(c, "govee") && usesDriver(c, "matter"), "example should show both drivers");
});

test("defaults", () => {
  const c = parseConfig("{}");
  assert.equal(c.listen, ":8080");
  assert.deepEqual(c.devices, []);
});

test("matter devices get default endpoint and white range", () => {
  const c = parseConfig('{"devices":[{"id":"bulb","name":"Bulb","driver":"matter","nodeId":3}]}');
  assert.deepEqual(c.devices, [
    { driver: "matter", id: "bulb", name: "Bulb", nodeId: 3, endpoint: 1, minKelvin: 2700, maxKelvin: 6500 },
  ]);
});

test("rejects bad layouts", () => {
  const cases: Record<string, string> = {
    "duplicate id": '{"devices":[{"id":"a","driver":"matter","nodeId":1},{"id":"a","driver":"matter","nodeId":2}]}',
    "bad id": '{"devices":[{"id":"Living Room","driver":"matter","nodeId":1}]}',
    "unknown driver": '{"devices":[{"id":"a","driver":"hue"}]}',
    "govee no sku": '{"devices":[{"id":"a","driver":"govee","device":"x","minKelvin":1,"maxKelvin":2}]}',
    "govee no range": '{"devices":[{"id":"a","driver":"govee","sku":"s","device":"x"}]}',
    "matter no node": '{"devices":[{"id":"a","driver":"matter"}]}',
    "node id not a number": '{"devices":[{"id":"a","driver":"matter","nodeId":"1"}]}',
    "unknown member": '{"rooms":[{"id":"r","members":["ghost"]}]}',
    "room contains itself": '{"rooms":[{"id":"r","members":["r"]}]}',
    "empty room": '{"rooms":[{"id":"r","members":[]}]}',
    "not json": "{",
  };
  for (const [name, raw] of Object.entries(cases)) {
    assert.throws(() => parseConfig(raw), Error, name);
  }
});

test("a missing file is an error", () => {
  assert.throws(() => loadConfig("does-not-exist.json"), { code: "ENOENT" });
});

test("listen addresses", () => {
  assert.deepEqual(parseListen(":8080"), { host: null, port: 8080 });
  assert.deepEqual(parseListen("127.0.0.1:8080"), { host: "127.0.0.1", port: 8080 });
  assert.deepEqual(parseListen("[::1]:8080"), { host: "::1", port: 8080 });
  assert.throws(() => parseListen("8080"));
  assert.throws(() => parseListen(":99999"));
});

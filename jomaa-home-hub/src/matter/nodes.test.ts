import assert from "node:assert/strict";
import { test } from "node:test";
import { summarize } from "./nodes.js";
const observation = { displayName: null, lastSeen: null, uptimeSeconds: null, uptimeObservedAt: null };

test("node summaries list OnOff endpoints in numeric order, including plugs on bridges", () => {
  const summary = summarize({
    ...observation,
    nodeId: 7,
    available: true,
    isBridge: true,
    attributes: {
      "0/40/1": "Acme",
      "0/6/0": true,
      "10/6/0": false,
      "2/6/0": true,
      "3/6/0": null,
      "4/8/0": 120,
      "5/6/1": true,
      "6/6/0": "false",
    },
  });
  assert.deepEqual(summary.lightEndpoints, [2, 10]);
  assert.equal(summary.vendor, "Acme");
  assert.equal(summary.isBridge, true);
});

test("a node without an OnOff attribute has no light endpoints", () => {
  assert.deepEqual(
    summarize({ ...observation, nodeId: 1, available: false, isBridge: false, attributes: {} }).lightEndpoints,
    [],
  );
});

test("device type and functional capabilities come from reported descriptors and attributes", () => {
  const summary = summarize(
    {
      ...observation,
      nodeId: 3,
      available: true,
      isBridge: false,
      attributes: {
        "0/29/0": [{ "0": 22, "1": 1 }],
        "1/29/0": [{ "0": 269, "1": 5 }],
        "1/6/0": true,
        "1/8/0": 100,
        "1/768/0": 0,
        "1/768/7": 250,
        "2/29/1": [1026],
      },
    },
    (id) => (id === 269 ? "Extended Color Light" : null),
  );
  assert.equal(summary.type, "Extended Color Light");
  assert.deepEqual(summary.capabilities, ["Power", "Brightness", "Color", "White temperature", "Temperature sensing"]);
});

test("temperature-only lights do not report color and unknown descriptors stay explicit", () => {
  const summary = summarize({
    ...observation,
    nodeId: 3,
    available: false,
    isBridge: false,
    attributes: { "1/768/7": null, "1/29/0": [{ "0": 0xffff, "1": 1 }] },
  });
  assert.equal(summary.type, "Device type 0xffff");
  assert.deepEqual(summary.capabilities, ["White temperature"]);
});

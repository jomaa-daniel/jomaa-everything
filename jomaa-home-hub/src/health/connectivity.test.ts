import assert from "node:assert/strict";
import { test } from "node:test";
import { GoveeClient, GoveeLight } from "../govee.js";
import { Hub } from "../hub.js";
import { settings } from "../settings.js";
import { serve, readBody } from "../testing.js";
import { Connectivity } from "./connectivity.js";

async function setup() {
  let online: unknown = true;
  let fail = false;
  let clock = 1000;
  const calls: { path: string; body: unknown }[] = [];
  const origin = await serve((req, res) => {
    void readBody(req).then((body) => {
      calls.push({ path: req.url ?? "", body });
      res.writeHead(fail ? 503 : 200).end(
        JSON.stringify({
          code: 200,
          payload: {
            capabilities: [
              { instance: "online", state: { value: online } },
              { instance: "powerSwitch", state: { value: 0 } },
              { instance: "brightness", state: { value: 50 } },
            ],
          },
        }),
      );
    });
  });
  const hub = new Hub();
  const light = new GoveeLight(new GoveeClient("test", origin), {
    driver: "govee",
    id: "lamp",
    name: "Lamp",
    sku: "test",
    device: "test",
    minKelvin: 2700,
    maxKelvin: 6500,
  });
  hub.addDevice("govee", light);
  return {
    connectivity: new Connectivity(hub, () => clock),
    calls,
    setOnline: (value: unknown) => {
      online = value;
    },
    setFail: () => {
      fail = true;
    },
    expire: () => {
      clock += settings.health.goveeStatusCacheSeconds * 1000 + 1;
    },
  };
}

test("Govee aliveness uses its online flag, including lights whose power is off", async () => {
  const env = await setup();
  let result = await env.connectivity.govee();
  assert.equal(result[0]?.status, "online");
  env.setOnline(false);
  env.expire();
  result = await env.connectivity.govee();
  assert.equal(result[0]?.status, "offline");
  env.setOnline(1);
  env.expire();
  assert.equal((await env.connectivity.govee())[0]?.status, "online");
  env.setOnline(0);
  env.expire();
  assert.equal((await env.connectivity.govee())[0]?.status, "offline");
  assert.ok(
    env.calls.every((call) => call.path === "/router/api/v1/device/state"),
    "checks send no light commands",
  );
});

test("cloud checks share a bounded cache and failures do not claim a device is offline", async () => {
  const env = await setup();
  await Promise.all([env.connectivity.govee(), env.connectivity.govee()]);
  assert.equal(env.calls.length, 1);
  await env.connectivity.govee();
  assert.equal(env.calls.length, 1);
  env.expire();
  env.setFail();
  const result = await env.connectivity.govee();
  assert.equal(result[0]?.status, "unknown");
  assert.equal(result[0].statusSource, "Govee cloud");
  assert.ok(result[0].reason);
});

test("cached switch state without an online flag is not proof of aliveness", async () => {
  const env = await setup();
  env.setOnline("unavailable");
  assert.equal((await env.connectivity.govee())[0]?.status, "unknown");
});

test("one deadline bounds the whole inventory even when cloud requests hang", async () => {
  const old = settings.health.goveeStatusTimeoutSeconds;
  settings.health.goveeStatusTimeoutSeconds = 1;
  let requests = 0;
  const origin = await serve(() => {
    requests++;
  });
  const hub = new Hub();
  for (let i = 0; i < 5; i++)
    hub.addDevice(
      "govee",
      new GoveeLight(new GoveeClient("test", origin), {
        driver: "govee",
        id: `lamp-${i}`,
        name: "Lamp",
        sku: "test",
        device: `test-${i}`,
        minKelvin: 2700,
        maxKelvin: 6500,
      }),
    );
  try {
    const results = await new Connectivity(hub).govee();
    assert.equal(results.length, 5);
    assert.ok(results.every((result) => result.status === "unknown"));
    assert.equal(requests, settings.health.goveeStatusConcurrency);
  } finally {
    settings.health.goveeStatusTimeoutSeconds = old;
  }
});

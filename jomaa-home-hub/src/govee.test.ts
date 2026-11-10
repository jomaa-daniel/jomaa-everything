import assert from "node:assert/strict";
import { test } from "node:test";
import { noChange, RGB } from "./device.js";
import { GoveeClient, GoveeLight } from "./govee.js";
import { readBody, serve } from "./testing.js";

interface Call {
  path: string;
  key: string;
  body: {
    requestId: string;
    payload: { sku: string; device: string; capability?: { instance: string; value: number } };
  };
}

async function fakeGovee(handle: (c: Call) => [number, string]): Promise<{ client: GoveeClient; calls: Call[] }> {
  const calls: Call[] = [];
  const url = await serve((req, res) => {
    void readBody(req).then((body) => {
      const c = { path: req.url ?? "", key: String(req.headers["govee-api-key"]), body: body as Call["body"] };
      calls.push(c);
      const [status, out] = handle(c);
      res.writeHead(status).end(out);
    });
  });
  return { client: new GoveeClient("test-key", url), calls };
}

const lamp = (c: GoveeClient) =>
  new GoveeLight(c, {
    driver: "govee",
    id: "lamp",
    name: "Lamp",
    sku: "H607C",
    device: "3F:3C",
    minKelvin: 2200,
    maxKelvin: 6500,
  });
const signal = new AbortController().signal;

test("apply sends one call per field", async () => {
  const { client, calls } = await fakeGovee(() => [200, '{"code":200,"msg":"success"}']);
  await lamp(client).apply({ on: true, brightness: 50, colorTemperaturePct: 50, color: RGB.parse("#ff0000") }, signal);
  const want = [
    ["powerSwitch", 1],
    ["brightness", 50],
    ["colorTemperatureK", 4350],
    ["colorRgb", 0xff0000],
  ];
  assert.equal(calls.length, want.length);
  want.forEach(([instance, value], i) => {
    const got = calls[i] as Call;
    assert.equal(got.path, "/router/api/v1/device/control");
    assert.equal(got.key, "test-key");
    assert.equal(got.body.payload.capability?.instance, instance);
    assert.equal(got.body.payload.capability?.value, value);
    assert.equal(got.body.payload.sku, "H607C");
    assert.equal(got.body.payload.device, "3F:3C");
    assert.ok(got.body.requestId);
  });
});

test("turning off skips levels", async () => {
  const { client, calls } = await fakeGovee(() => [200, '{"code":200}']);
  await lamp(client).apply({ ...noChange, on: false, brightness: 80 }, signal);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.body.payload.capability?.value, 0);
});

test("an error in the body is a failure", async () => {
  const { client } = await fakeGovee(() => [200, '{"code":400,"msg":"devices not exist"}']);
  await assert.rejects(lamp(client).apply({ ...noChange, on: true }, signal), /devices not exist/);
});

test("an HTTP error is a failure", async () => {
  const { client } = await fakeGovee(() => [429, "rate limited"]);
  await assert.rejects(lamp(client).apply({ ...noChange, on: true }, signal), /HTTP 429: rate limited/);
});

test("state", async () => {
  const { client, calls } = await fakeGovee(() => [
    200,
    `{"code":200,"payload":{"sku":"H607C","device":"3F:3C","capabilities":[
      {"type":"devices.capabilities.online","instance":"online","state":{"value":true}},
      {"type":"devices.capabilities.on_off","instance":"powerSwitch","state":{"value":1}},
      {"type":"devices.capabilities.range","instance":"brightness","state":{"value":75}},
      {"type":"devices.capabilities.color_setting","instance":"colorTemperatureK","state":{"value":4350}}]}}`,
  ]);
  const s = await lamp(client).state(signal);
  assert.equal(calls[0]?.path, "/router/api/v1/device/state");
  assert.deepEqual(s, { on: true, brightness: 75, colorTemperaturePct: 50 });
});

test("state without power is an error", async () => {
  const { client } = await fakeGovee(() => [200, '{"code":200,"payload":{"capabilities":[]}}']);
  await assert.rejects(lamp(client).state(signal), /no powerSwitch/);
});

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const source = readFileSync(join(__dirname, "app.js"), "utf8").split(
  '$("login-form").addEventListener',
)[0];

function panel() {
  const calls = [];
  const context = vm.createContext({ calls });
  vm.runInContext(source, context);
  vm.runInContext(
    `
    const bulb = { id: "bulb", kind: "light", features: { brightness: true, color: true, colorTemperature: true } };
    const plug = { id: "plug", kind: "light", features: { brightness: false, color: false, colorTemperature: false } };
    const white = { id: "white", kind: "light", features: { brightness: true, color: false, colorTemperature: true } };
    const nested = { id: "nested", kind: "room", members: ["plug", "white"] };
    const room = { id: "room", kind: "room", members: ["bulb", "nested"] };
    app.targets = new Map([bulb, plug, white, nested, room].map(item => [item.id, item]));
    app.selected = ["room"];
    app.authenticated = true;
    app.observation = { devices: Object.fromEntries([bulb, plug, white].map(item => [item.id, { on: true, brightness: 100, colorTemperaturePct: 50 }])), failed: {} };
    render = () => {};
    announce = () => {};
    api = async (path, method, body) => { calls.push({ path, method, body }); return { failed: {} }; };
  `,
    context,
  );
  return { context, calls };
}

async function send(changes) {
  const { context, calls } = panel();
  context.changes = changes;
  await vm.runInContext("send(changes)", context);
  return {
    calls: JSON.parse(JSON.stringify(calls)),
    states: JSON.parse(
      vm.runInContext("JSON.stringify(app.observation.devices)", context),
    ),
  };
}

const request = (id, body) => ({
  path: `/api/targets/${id}/command`,
  method: "POST",
  body,
});

test("unsupported colors turn devices off and the panel shows the result", async () => {
  const changes = { on: true, color: "#ff0000" };
  const { calls, states } = await send(changes);
  assert.deepEqual(calls, [
    request("bulb", changes),
    request("plug", { on: false }),
    request("white", { on: false }),
  ]);
  assert.equal(states.plug.on, false);
  assert.equal(states.white.on, false);
});

test("unsupported white temperature turns devices off", async () => {
  const changes = { on: true, colorTemperaturePct: 50 };
  const { calls } = await send(changes);
  assert.deepEqual(calls, [
    request("bulb", changes),
    request("plug", { on: false }),
    request("white", changes),
  ]);
});

test("non-dimmable devices turn off below 50% and stay unchanged at 50% or above", async () => {
  for (const brightness of [10, 49, 50, 75, 100]) {
    const changes = { on: true, brightness };
    const { calls, states } = await send(changes);
    assert.deepEqual(
      calls.filter((call) => call.path.includes("plug")),
      brightness < 50 ? [request("plug", { on: false })] : [],
    );
    assert.deepEqual(
      calls.filter((call) => !call.path.includes("plug")),
      [request("bulb", changes), request("white", changes)],
    );
    assert.equal(states.plug.on, brightness >= 50);
  }
});

test("power commands reach all devices", async () => {
  const { calls } = await send({ on: false });
  assert.deepEqual(calls, [
    request("bulb", { on: false }),
    request("plug", { on: false }),
    request("white", { on: false }),
  ]);
});

test("failed devices retain their previous state and others receive commands", async () => {
  const { context, calls } = panel();
  vm.runInContext(
    `api = async (path, method, body) => {
    calls.push({ path, method, body });
    return { failed: path.includes("plug") ? { plug: "offline" } : {} };
  };`,
    context,
  );
  await vm.runInContext('send({ on: true, color: "#ff0000" })', context);
  assert.equal(calls.length, 3);
  assert.equal(
    vm.runInContext("app.observation.devices.plug.on", context),
    true,
  );
  assert.equal(vm.runInContext("app.failed.plug", context), "offline");
});

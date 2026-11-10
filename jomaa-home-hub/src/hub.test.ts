import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConfig } from "./config.js";
import {
  allFeatures,
  InvalidCommandError,
  noChange,
  noFeatures,
  type Command,
  type Device,
  type Features,
  type State,
} from "./device.js";
import { GoveeClient } from "./govee.js";
import { Group, leaves } from "./group.js";
import { Hub, NotFoundError, type Desired } from "./hub.js";
import type { MatterNodes } from "./matter/nodes.js";

/** An in-memory light that changes state when commanded. */
class Bulb implements Device {
  readonly name: string;
  got: Command[] = [];
  stateErr: Error | null = null;
  applyErr: Error | null = null;
  /** Runs once, the next time state is read, after the state is taken. */
  onState: (() => Promise<void>) | null = null;
  caps: Features = allFeatures;

  constructor(
    readonly id: string,
    public current: State = state(false),
  ) {
    this.name = id;
  }

  apply(c: Command): Promise<void> {
    this.got.push(c);
    if (this.applyErr !== null) return Promise.reject(this.applyErr);
    this.current = {
      on: c.on ?? this.current.on,
      brightness: c.brightness ?? this.current.brightness,
      colorTemperaturePct: c.colorTemperaturePct ?? this.current.colorTemperaturePct,
    };
    return Promise.resolve();
  }

  async state(): Promise<State> {
    const s = { ...this.current };
    const hook = this.onState;
    this.onState = null;
    await hook?.();
    if (this.stateErr !== null) throw this.stateErr;
    return s;
  }

  features(): Features {
    return this.caps;
  }
}

function room(...bulbs: Bulb[]): Hub {
  const h = new Hub();
  for (const b of bulbs) h.addDevice("test", b);
  h.addRoom(new Group("living-room", "Living Room", bulbs));
  return h;
}

/** A sync that checks nothing; spread it and set the fields to check. */
const checkNothing: Desired = { clientId: "", revision: null, on: null, brightness: null, colorTemperaturePct: null };

const signal = new AbortController().signal;
function state(on: boolean, brightness = 0, colorTemperaturePct = 0): State {
  return { on, brightness, colorTemperaturePct };
}

test("sync fixes only the bulbs that drifted", async () => {
  const good = new Bulb("good", state(true, 50, 30));
  const dim = new Bulb("dim", state(true, 10, 31));
  const off = new Bulb("off", state(false, 50, 30));
  const h = room(good, dim, off);

  const want = { ...checkNothing, on: true, brightness: 50, colorTemperaturePct: 30 };
  let res = await h.sync("living-room", want, signal);
  assert.equal(res.synchronized, false, "reported synchronized while bulbs had drifted");
  assert.deepEqual(res.corrected, { dim: ["brightness"], off: ["on"] });
  assert.equal(good.got.length, 0, "touched a bulb that was already right");

  // The next pass sees everything in place.
  res = await h.sync("living-room", want, signal);
  assert.ok(res.synchronized);
  assert.deepEqual(res.corrected, {});
});

test("sync never relights an off room", async () => {
  const b = new Bulb("b", state(false, 5));
  const res = await room(b).sync("living-room", { ...checkNothing, on: false, brightness: 80 }, signal);
  assert.ok(res.synchronized);
  assert.equal(b.got.length, 0);
});

test("sync skips fields a device can't change", async () => {
  const plug = new Bulb("plug", state(true));
  plug.caps = noFeatures;
  const res = await room(plug).sync(
    "living-room",
    { ...checkNothing, on: true, brightness: 80, colorTemperaturePct: 20 },
    signal,
  );
  assert.ok(res.synchronized, "plug can't dim, but sync wanted to fix it");
});

test("an older sync stands down after a newer command", async () => {
  const b = new Bulb("b", state(true, 50));
  const h = room(b);
  await h.command("b", { ...noChange, brightness: 90 }, "phone", 5, signal);
  let res = await h.sync(
    "living-room",
    { ...checkNothing, clientId: "phone", revision: 4, on: true, brightness: 50 },
    signal,
  );
  assert.ok(res.stale);
  assert.equal(b.got.length, 1, "stale sync changed things");

  // Another client's revisions are tracked separately.
  res = await h.sync(
    "living-room",
    { ...checkNothing, clientId: "tablet", revision: 1, on: true, brightness: 90 },
    signal,
  );
  assert.equal(res.stale, false);
  assert.ok(res.synchronized);
});

test("sync stands down if a command arrives midway", async () => {
  const b = new Bulb("b", state(true, 10));
  const h = new Hub();
  h.addDevice("test", b);
  h.addRoom(new Group("r", "R", [b]));
  b.onState = async () => {
    await h.command("b", { ...noChange, brightness: 70 }, "phone", 2, signal);
  };
  const res = await h.sync("r", { ...checkNothing, clientId: "phone", revision: 1, on: true, brightness: 40 }, signal);
  assert.ok(res.stale);
  assert.equal(b.current.brightness, 70, "sync overwrote the newer command");
});

test("sync reports unreachable devices", async () => {
  const ok = new Bulb("ok", state(true));
  const gone = new Bulb("gone");
  gone.stateErr = new Error("timeout");
  const res = await room(ok, gone).sync("living-room", { ...checkNothing, on: true }, signal);
  assert.equal(res.synchronized, false);
  assert.equal(res.failed["gone"], "timeout");
});

test("command reports per-device failures", async () => {
  const ok = new Bulb("ok");
  const bad = new Bulb("bad");
  bad.applyErr = new Error("401");
  const failed = await room(ok, bad).command("living-room", { ...noChange, on: true }, "", null, signal);
  assert.deepEqual(failed, { bad: "401" });
  assert.equal(ok.got.length, 1);
});

test("command rejects bad input and unknown targets", async () => {
  const h = room(new Bulb("b"));
  await assert.rejects(h.command("nope", { ...noChange, on: true }, "", null, signal), NotFoundError);
  await assert.rejects(h.command("b", noChange, "", null, signal), InvalidCommandError);
});

test("state reports each device and a summary", async () => {
  const on = new Bulb("on", state(true, 60));
  const broken = new Bulb("broken");
  broken.stateErr = new Error("unreachable");
  const res = await room(on, broken).state("living-room", signal);
  assert.deepEqual(res, {
    state: state(true, 60),
    devices: { on: state(true, 60) },
    failed: { broken: "unreachable" },
  });
});

test("build from config", () => {
  const cfg = parseConfig(`{
    "devices": [
      {"id":"lamp","name":"Lamp","driver":"govee","sku":"H607C","device":"AA:BB","minKelvin":2200,"maxKelvin":6500},
      {"id":"bulb","name":"Bulb","driver":"matter","nodeId":3}
    ],
    "rooms": [
      {"id":"living-room","name":"Living Room","members":["lamp","bulb"]},
      {"id":"house","name":"House","members":["living-room"]}
    ]}`);
  const matter: MatterNodes = { ready: false, node: () => null, invoke: () => Promise.resolve() };
  const h = Hub.build(cfg, new GoveeClient("k", "http://127.0.0.1:1"), matter);
  assert.deepEqual(h.list(), [
    { id: "lamp", name: "Lamp", kind: "govee", features: allFeatures },
    { id: "bulb", name: "Bulb", kind: "matter", features: noFeatures },
    { id: "living-room", name: "Living Room", kind: "room", members: ["lamp", "bulb"], features: allFeatures },
    // The house can do what its Govee lamp can, though the unpaired Matter bulb reports nothing.
    { id: "house", name: "House", kind: "room", members: ["living-room"], features: allFeatures },
  ]);
  const house = h.get("house");
  assert.ok(house !== null);
  assert.equal(leaves(house).length, 2);
});

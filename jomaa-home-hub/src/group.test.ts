import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { allFeatures, noChange, type Command, type Device, type Features, type State } from "./device.js";
import { failures, Group, leaves } from "./group.js";

class Fake implements Device {
  readonly name: string;
  got: Command[] = [];
  current: State = { on: false, brightness: 0, colorTemperaturePct: 0 };
  err: Error | null = null;
  delayMs = 0;
  caps: Features = allFeatures;

  constructor(readonly id: string) {
    this.name = id;
  }

  async apply(c: Command): Promise<void> {
    await sleep(this.delayMs);
    this.got.push(c);
    if (this.err !== null) throw this.err;
  }

  state(): Promise<State> {
    return this.err !== null ? Promise.reject(this.err) : Promise.resolve(this.current);
  }

  features(): Features {
    return this.caps;
  }
}

function fake(id: string, set: (f: Fake) => void): Fake {
  const f = new Fake(id);
  set(f);
  return f;
}

const signal = new AbortController().signal;

test("a group sends to every member at once", async () => {
  const members = ["a", "b", "c"].map((id) => fake(id, (f) => (f.delayMs = 100)));
  const g = new Group("room", "Room", members);
  const start = performance.now();
  await g.apply({ ...noChange, on: true }, signal);
  assert.ok(performance.now() - start < 250, "members ran one after another");
  for (const f of members) {
    assert.deepEqual(f.got, [{ ...noChange, on: true }]);
  }
});

test("a group keeps going when one member fails", async () => {
  const ok = new Fake("ok");
  const bad = fake("bad", (f) => (f.err = new Error("offline")));
  const g = new Group("room", "Room", [ok, new Group("inner", "Inner", [bad])]);
  const err = await g.apply({ ...noChange, on: false }, signal).then(
    () => undefined,
    (e: unknown) => e,
  );
  assert.equal(ok.got.length, 1, "healthy member was skipped");
  assert.deepEqual(failures("room", err), { bad: "offline" });
});

test("group state prefers a member that is on", async () => {
  const g = new Group("room", "Room", [
    fake("a", (f) => (f.current = { on: false, brightness: 10, colorTemperaturePct: 0 })),
    fake("b", (f) => (f.current = { on: true, brightness: 80, colorTemperaturePct: 0 })),
  ]);
  const s = await g.state(signal);
  assert.equal(s.on, true);
  assert.equal(s.brightness, 80);
});

test("leaves expands nested rooms", () => {
  const [a, b, c] = [new Fake("a"), new Fake("b"), new Fake("c")];
  const g = new Group("all", "All", [a, new Group("r", "R", [b, c])]);
  assert.deepEqual(leaves(g), [a, b, c]);
});

test("a room can do what any of its devices can", () => {
  const plug = fake("plug", (f) => (f.caps = { brightness: false, colorTemperature: false, color: false }));
  const dimmer = fake("dimmer", (f) => (f.caps = { brightness: true, colorTemperature: false, color: false }));
  assert.deepEqual(new Group("r", "R", [plug, dimmer]).features(), {
    brightness: true,
    colorTemperature: false,
    color: false,
  });
});

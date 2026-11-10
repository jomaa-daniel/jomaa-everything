import assert from "node:assert/strict";
import { test } from "node:test";
import { InvalidCommandError, kelvinAtPct, noChange, pctFromKelvin, RGB, validate, type Command } from "./device.js";

test("validate rejects empty and out-of-range commands", () => {
  const cases: Record<string, Command> = {
    empty: noChange,
    "brightness zero": { ...noChange, brightness: 0 },
    "brightness 101": { ...noChange, brightness: 101 },
    "temp -1": { ...noChange, colorTemperaturePct: -1 },
  };
  for (const [name, c] of Object.entries(cases)) {
    assert.throws(
      () => {
        validate(c);
      },
      InvalidCommandError,
      name,
    );
  }
  validate({ ...noChange, brightness: 100, colorTemperaturePct: 0 });
});

test("colors parse from and print as #rrggbb", () => {
  const c = RGB.parse("#FF8000");
  assert.equal(c.toInt(), 0xff8000);
  assert.equal(c.toString(), "#ff8000");
  assert.equal(JSON.stringify({ color: c }), '{"color":"#ff8000"}');
  assert.throws(() => RGB.parse("red"), InvalidCommandError);
});

test("kelvin and percent round-trip", () => {
  for (let pct = 0; pct <= 100; pct++) {
    const k = kelvinAtPct(2200, 6500, pct);
    assert.equal(pctFromKelvin(2200, 6500, k), pct, `${pct}% -> ${k}K`);
  }
});

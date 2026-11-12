import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseJson } from "./json.js";
import { parseSettings, settingsFile } from "./settings.js";

test("settings.md documents every setting in settings.json", () => {
  const doc = readFileSync(new URL("../settings.md", import.meta.url), "utf8");
  const keys = (value: unknown, prefix: string): string[] =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.entries(value).flatMap(([key, field]) => [prefix + key, ...keys(field, `${prefix}${key}.`)])
      : [];
  for (const key of keys(parseJson(readFileSync(settingsFile, "utf8")), "")) {
    assert.ok(doc.includes(`\`${key}\``), `settings.md does not document ${key}`);
  }
});

test("invalid settings name the setting", () => {
  const valid = {
    databaseFile: "accounts.sqlite",
    sessionLifetimeDays: 1,
    sessionsPerAccount: 1,
    inviteLifetimeDays: 1,
    passwordLength: { min: 1, max: 2 },
  };
  assert.equal(parseSettings(JSON.stringify({ accounts: valid })).accounts.sessionsPerAccount, 1);
  const broken = (change: Record<string, unknown>) => JSON.stringify({ accounts: { ...valid, ...change } });
  assert.throws(() => parseSettings(broken({ sessionLifetimeDays: 0 })), /accounts\.sessionLifetimeDays/);
  assert.throws(() => parseSettings(broken({ passwordLength: { min: 20, max: 10 } })), /passwordLength\.max/);
  assert.throws(() => parseSettings(broken({ extra: 1 })), /unknown field "extra"/);
});

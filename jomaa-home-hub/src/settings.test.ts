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
    busyTimeoutMs: 1,
  };
  const tailscale = {
    python: "python3",
    script: "../jomaa-tailscale/tailnet.py",
    commandTimeoutSeconds: 1,
    syncIntervalSeconds: 1,
    observationMaxAgeSeconds: 1,
    downloadUrl: "https://example.com/download",
    adminUsersUrl: "https://example.com/admin/users",
  };
  assert.equal(parseSettings(JSON.stringify({ accounts: valid, tailscale })).accounts.sessionsPerAccount, 1);
  const broken = (change: Record<string, unknown>) => JSON.stringify({ accounts: { ...valid, ...change }, tailscale });
  assert.throws(() => parseSettings(broken({ sessionLifetimeDays: 0 })), /accounts\.sessionLifetimeDays/);
  assert.throws(() => parseSettings(broken({ passwordLength: { min: 20, max: 10 } })), /passwordLength\.max/);
  assert.throws(() => parseSettings(broken({ extra: 1 })), /unknown field "extra"/);
});

test("invalid Tailscale settings name the setting", () => {
  const settings = parseJson(readFileSync(settingsFile, "utf8")) as Record<string, Record<string, unknown>>;
  const broken = (change: Record<string, unknown>) =>
    JSON.stringify({ ...settings, tailscale: { ...settings["tailscale"], ...change } });
  assert.throws(() => parseSettings(broken({ syncIntervalSeconds: 0 })), /tailscale\.syncIntervalSeconds/);
  assert.throws(() => parseSettings(broken({ commandTimeoutSeconds: 0 })), /tailscale\.commandTimeoutSeconds/);
  assert.throws(() => parseSettings(broken({ downloadUrl: "http://example.com" })), /tailscale\.downloadUrl/);
  assert.throws(() => parseSettings(broken({ python: "" })), /tailscale\.python/);
  assert.throws(() => parseSettings(broken({ retries: 3 })), /unknown field "retries"/);
  const missing = { ...settings["tailscale"] };
  delete missing["script"];
  assert.throws(() => parseSettings(JSON.stringify({ ...settings, tailscale: missing })), /missing field "script"/);
  assert.throws(() => parseSettings(JSON.stringify({ accounts: settings["accounts"] })), /missing field "tailscale"/);
});

test("a Tailscale command can finish within its deadline", () => {
  const tailnet = parseJson(
    readFileSync(new URL("../../jomaa-tailscale/config.json", import.meta.url), "utf8"),
  ) as Record<string, number>;
  const api = tailnet["apiTimeoutSeconds"] ?? 0;
  const sync = (tailnet["lockTimeoutSeconds"] ?? 0) + 4 * api;
  const observe = 3 * api + 2 * (tailnet["queryTimeoutSeconds"] ?? 0);
  const deadline = parseSettings(readFileSync(settingsFile, "utf8")).tailscale.commandTimeoutSeconds;
  assert.ok(deadline >= sync, `tailscale.commandTimeoutSeconds must be at least ${sync} for a sync`);
  assert.ok(deadline >= observe, `tailscale.commandTimeoutSeconds must be at least ${observe} for an observation`);
});

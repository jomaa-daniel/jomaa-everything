import assert from "node:assert/strict";
import { test } from "node:test";
import { applyEnvChanges, EnvError, envKeys, envValue, parseEnv, serializeEnv } from "./envfile.js";
import { deploySettings } from "./settings.js";

const sample = [
  "# Copy to .env and fill in.",
  "HUB_PASSWORD=a long enough password",
  "",
  "GOVEE_API_KEY=",
  "# HUB_TLS_CERT=/path/to/cert.pem",
  "lowercase=kept as written",
  "HUB_URL=http://127.0.0.1:8080?a=b",
  "GOVEE_API_KEY=second",
  "",
].join("\n");

const minimum = deploySettings.hubPasswordMinLength;

test("parsing and serializing keeps every line, comment and blank line", () => {
  for (const text of [sample, sample.trimEnd(), "", "\n", "ONLY=one", "# only a comment\n"]) {
    assert.equal(serializeEnv(parseEnv(text)), text, JSON.stringify(text));
  }
  const env = parseEnv(sample);
  assert.deepEqual(envKeys(env), ["HUB_PASSWORD", "GOVEE_API_KEY", "HUB_URL"]);
  assert.equal(envValue(env, "HUB_URL"), "http://127.0.0.1:8080?a=b", "a value keeps later = signs");
  assert.equal(envValue(env, "GOVEE_API_KEY"), "second", "the last entry of a key takes effect");
  assert.equal(envValue(env, "HUB_TLS_CERT"), null, "commented entries are not keys");
});

test("changes keep comments and order and append new keys", () => {
  const changed = applyEnvChanges(
    parseEnv(sample),
    [
      { key: "HUB_URL", value: "http://hub.local" },
      { key: "NEW_KEY", value: "value with = and spaces" },
      { key: "GOVEE_API_KEY", delete: true },
    ],
    minimum,
  );
  assert.equal(
    serializeEnv(changed),
    [
      "# Copy to .env and fill in.",
      "HUB_PASSWORD=a long enough password",
      "",
      "# HUB_TLS_CERT=/path/to/cert.pem",
      "lowercase=kept as written",
      "HUB_URL=http://hub.local",
      "NEW_KEY=value with = and spaces",
      "",
    ].join("\n"),
  );
  assert.equal(
    serializeEnv(applyEnvChanges(parseEnv("A=1"), [{ key: "B", value: "2" }], minimum)),
    "A=1\nB=2\n",
    "appending to a file without a final newline starts a new line",
  );
});

test("changes are validated before anything is applied", () => {
  const env = parseEnv(sample);
  const refused = (changes: Parameters<typeof applyEnvChanges>[1], pattern: RegExp) => {
    assert.throws(
      () => applyEnvChanges(env, changes, minimum),
      (err: unknown) => {
        assert.ok(err instanceof EnvError);
        assert.match(err.message, pattern);
        return true;
      },
    );
  };
  for (const key of ["lower", "1ABC", "_ABC", "A-B", "A B", ""]) refused([{ key, value: "x" }], /invalid key/);
  refused([{ key: "TOKEN", value: "secret-one\nINJECTED=1" }], /line breaks/);
  refused([{ key: "TOKEN", value: "secret-two\r" }], /line breaks/);
  refused([{ key: "HUB_PASSWORD", value: "x".repeat(minimum - 1) }], new RegExp(`at least ${minimum}`));
  refused([{ key: "HUB_PASSWORD", value: `"${"x".repeat(minimum - 2)}"` }], /HUB_PASSWORD/);
  refused([{ key: "HUB_PASSWORD", delete: true }], /can't be deleted/);
  refused([{ key: "MISSING", delete: true }], /not in the file/);
  refused([], /no changes/);
  refused(
    [
      { key: "A", value: "1" },
      { key: "A", value: "2" },
    ],
    /more than once/,
  );
  assert.throws(
    () => applyEnvChanges(env, [{ key: "TOKEN", value: "secret-three\n" }], minimum),
    (err: unknown) => err instanceof Error && !err.message.includes("secret-three"),
    "messages never contain values",
  );
  const password = "y".repeat(minimum);
  assert.equal(
    envValue(applyEnvChanges(env, [{ key: "HUB_PASSWORD", value: password }], minimum), "HUB_PASSWORD"),
    password,
  );
});

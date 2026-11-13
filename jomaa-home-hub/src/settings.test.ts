import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Fields, parseJson } from "./json.js";
import { deploySettings, parseDeploySettings, parseSettings, releaseRoot, settings, settingsFile } from "./settings.js";

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
  const secrets = {
    envFiles: ["app/.env", "other/.env"],
    ghCommand: "/usr/bin/gh",
    deployConfig: "deploy/config.json",
    redeployPollSeconds: 1,
  };
  assert.equal(parseSettings(JSON.stringify({ accounts: valid, secrets })).accounts.sessionsPerAccount, 1);
  const broken = (change: Record<string, unknown>) => JSON.stringify({ accounts: { ...valid, ...change }, secrets });
  assert.throws(() => parseSettings(broken({ sessionLifetimeDays: 0 })), /accounts\.sessionLifetimeDays/);
  assert.throws(() => parseSettings(broken({ passwordLength: { min: 20, max: 10 } })), /passwordLength\.max/);
  assert.throws(() => parseSettings(broken({ extra: 1 })), /unknown field "extra"/);
  const badSecrets = (change: Record<string, unknown>) =>
    JSON.stringify({ accounts: valid, secrets: { ...secrets, ...change } });
  assert.throws(() => parseSettings(badSecrets({ envFiles: ["../outside/.env"] })), /secrets\.envFiles/);
  assert.throws(() => parseSettings(badSecrets({ envFiles: ["/etc/.env"] })), /secrets\.envFiles/);
  assert.throws(() => parseSettings(badSecrets({ envFiles: [] })), /secrets\.envFiles/);
  assert.throws(() => parseSettings(badSecrets({ ghCommand: "gh" })), /secrets\.ghCommand/);
  assert.throws(() => parseSettings(badSecrets({ ghCommand: "" })), /secrets\.ghCommand/);
  assert.throws(() => parseSettings(badSecrets({ redeployPollSeconds: 0 })), /secrets\.redeployPollSeconds/);
});

test("the hub reads its deployment settings from the deployment's config.json", () => {
  const text = readFileSync(new URL(settings.secrets.deployConfig, releaseRoot), "utf8");
  const deploy = new Fields(parseJson(text), "config.json");
  const github = new Fields(deploy.value("github"), "github");
  assert.deepEqual(deploySettings, {
    repo: deploy.string("repo"),
    workflow: github.string("workflow"),
    githubApi: github.string("api"),
    githubTimeoutSeconds: github.int("timeoutSeconds"),
    hubPasswordMinLength: deploy.int("hubPasswordMinLength"),
  });
  assert.throws(() => parseDeploySettings(text.replace(/"workflow": "[^"]*"/, '"workflow": ""')), /github\.workflow/);
  assert.throws(() => parseDeploySettings(text.replace(/"repo": "[^"]*"/, '"repo": "no-owner"')), /repo/);
});

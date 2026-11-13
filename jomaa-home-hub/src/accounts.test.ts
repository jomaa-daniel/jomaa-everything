import assert from "node:assert/strict";
import { test } from "node:test";
import { AccountError, Accounts, inviteLifetimeMs, sessionLifetimeMs } from "./accounts.js";
import { settings } from "./settings.js";

test("invites and sessions expire", async () => {
  const accounts = new Accounts(":memory:");
  let now = 1_000_000;
  accounts.now = () => now;
  const { token } = accounts.createInvite();
  now += inviteLifetimeMs;
  assert.throws(() => accounts.checkInvite(token), AccountError);
  assert.deepEqual(accounts.invites(), []);

  const fresh = accounts.createInvite();
  const account = await accounts.join(fresh.token, " Sam ", "a long enough password");
  assert.equal(account.username, "sam");
  const session = accounts.createSession("sam");
  assert.equal(accounts.session(session)?.username, "sam");
  now += sessionLifetimeMs;
  assert.equal(accounts.session(session), null);
  accounts.prune();
  assert.equal(accounts.session(session), null);
});

test("passwords are verified without storing them", async () => {
  const accounts = new Accounts(":memory:");
  await accounts.join(accounts.createInvite().token, "sam", "a long enough password");
  assert.equal((await accounts.verify("sam", "a long enough password"))?.username, "sam");
  assert.equal(await accounts.verify("sam", "the wrong password"), null);
  assert.equal(await accounts.verify("nobody", "a long enough password"), null);
});

test("an account keeps its newest sessions up to the configured count", async () => {
  const accounts = new Accounts(":memory:");
  await accounts.join(accounts.createInvite().token, "sam", "a long enough password");
  const sessions = Array.from({ length: settings.accounts.sessionsPerAccount + 1 }, () =>
    accounts.createSession("sam"),
  );
  assert.equal(accounts.session(sessions[0] ?? ""), null, "the oldest session ended");
  assert.ok(sessions.slice(1).every((token) => accounts.session(token)?.username === "sam"));
});

test("scopes are stored in a fixed order without duplicates", async () => {
  const accounts = new Accounts(":memory:");
  await accounts.join(accounts.createInvite().token, "sam", "a long enough password");
  assert.deepEqual(accounts.setScopes("sam", ["manage", "lights", "manage"]).scopes, ["lights", "manage"]);
  assert.throws(() => accounts.setScopes("nobody", []), AccountError);
});

test("two concurrent joins with one invite create one account", async () => {
  const accounts = new Accounts(":memory:");
  const { token } = accounts.createInvite();
  const results = await Promise.allSettled([
    accounts.join(token, "first", "a long enough password"),
    accounts.join(token, "second", "a long enough password"),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
  const refused = results.find((result) => result.status === "rejected");
  assert.ok(refused?.reason instanceof AccountError);
  assert.equal(accounts.accounts().length, 1);
  assert.deepEqual(accounts.invites(), []);
  assert.throws(() => accounts.checkInvite(token), AccountError);
});

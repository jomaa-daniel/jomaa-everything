import assert from "node:assert/strict";
import { test } from "node:test";
import { AccountError, Accounts, inviteLifetimeMs, sessionLifetimeMs } from "./accounts.js";

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

test("scopes are stored in a fixed order without duplicates", async () => {
  const accounts = new Accounts(":memory:");
  await accounts.join(accounts.createInvite().token, "sam", "a long enough password");
  assert.deepEqual(accounts.setScopes("sam", ["manage", "lights", "manage"]).scopes, ["lights", "manage"]);
  assert.throws(() => accounts.setScopes("nobody", []), AccountError);
});

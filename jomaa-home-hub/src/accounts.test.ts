import { catalog } from "./nodes.js";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  assert.equal(accounts.invites()[0]?.status, "expired");

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

test("daily opens retain zero days, lifetime totals, and unusable link attempts", (t) => {
  const accounts = new Accounts(":memory:");
  t.after(() => {
    accounts.close();
  });
  const day = 86_400_000;
  const createdAt = Date.UTC(2026, 0, 1, 23, 59);
  let now = createdAt;
  accounts.now = () => now;
  const { invite, token } = accounts.createInvite();
  accounts.openInvite(token);
  accounts.openInvite(token);
  now = Date.UTC(2026, 0, 3);
  accounts.openInvite(token);
  assert.deepEqual(accounts.inviteActivity(invite.id).days, [
    { date: "2026-01-01", count: 2 },
    { date: "2026-01-02", count: 0 },
    { date: "2026-01-03", count: 1 },
  ]);
  now = createdAt + (settings.accounts.inviteChartDays + settings.accounts.inviteLifetimeDays) * day;
  accounts.prune();
  assert.throws(() => accounts.openInvite(token), AccountError);
  const activity = accounts.inviteActivity(invite.id);
  assert.equal(activity.days.length, settings.accounts.inviteChartDays);
  assert.equal(activity.days[0]?.count, 0);
  assert.equal(activity.days.at(-1)?.count, 1);
  assert.equal(activity.total, 4, "the total includes opens outside the chart window");
  assert.equal(activity.lastAccessAt, now);
  assert.throws(() => accounts.openInvite("unknown token"), AccountError);
  assert.equal(accounts.inviteActivity(invite.id).total, 4);
});

test("expiration can expire and renew an unused link without erasing history", (t) => {
  const accounts = new Accounts(":memory:");
  t.after(() => {
    accounts.close();
  });
  let now = Date.UTC(2026, 0, 1);
  accounts.now = () => now;
  const { invite, token } = accounts.createInvite();
  accounts.openInvite(token);
  now += inviteLifetimeMs;
  assert.equal(accounts.invite(invite.id).status, "expired");
  const renewed = accounts.setInviteExpiration(invite.id, now + inviteLifetimeMs);
  assert.equal(renewed.status, "pending");
  assert.equal(accounts.checkInvite(token).expiresAt, renewed.expiresAt);
  accounts.setInviteExpiration(invite.id, now);
  assert.throws(() => accounts.checkInvite(token), AccountError);
  accounts.prune();
  assert.equal(accounts.inviteActivity(invite.id).total, 1);
  for (const invalid of [invite.createdAt, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER])
    assert.throws(() => accounts.setInviteExpiration(invite.id, invalid), AccountError);
  accounts.revokeInvite(invite.id);
  assert.equal(accounts.invite(invite.id).status, "revoked");
  assert.throws(() => accounts.setInviteExpiration(invite.id, now + inviteLifetimeMs), AccountError);
});

test("the created account and access history persist after account deletion and reopening", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "invite-history-"));
  t.after(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  const path = join(directory, "accounts.sqlite");
  let accounts = new Accounts(path);
  t.after(() => {
    accounts.close();
  });
  accounts.now = () => Date.UTC(2026, 0, 1);
  const { invite, token } = accounts.createInvite([{ node: catalog.defaultNode, scopes: ["lights"] }]);
  const revoked = accounts.createInvite();
  accounts.revokeInvite(revoked.invite.id);
  accounts.openInvite(token);
  const account = await accounts.join(token, " Sarah ", "a long enough password");
  assert.deepEqual(account.grants, invite.grants);
  assert.throws(() => accounts.openInvite(token), AccountError);
  assert.throws(() => accounts.setInviteExpiration(invite.id, invite.expiresAt + 1), AccountError);
  assert.throws(() => {
    accounts.revokeInvite(invite.id);
  }, AccountError);
  await assert.rejects(accounts.join(token, "second", "a long enough password"), AccountError);
  assert.equal(accounts.inviteActivity(invite.id).total, 2, "joining does not count as another opening");
  accounts.deleteAccount(account.username);
  accounts.close();
  accounts = new Accounts(path);
  const detail = accounts.invite(invite.id);
  assert.equal(detail.status, "used");
  assert.deepEqual(detail.account, { username: "sarah", createdAt: account.createdAt });
  assert.equal(accounts.inviteActivity(invite.id).total, 2);
  assert.equal(accounts.invite(revoked.invite.id).status, "revoked");
  assert.throws(() => accounts.openInvite(revoked.token), AccountError);
  assert.equal(accounts.inviteActivity(revoked.invite.id).total, 1);
  assert.ok(!JSON.stringify(accounts.invites()).includes(token), "inspection does not reveal the token");
});

test("passwords are verified without storing them", async () => {
  const accounts = new Accounts(":memory:");
  await accounts.join(accounts.createInvite().token, "sam", "a long enough password");
  assert.equal((await accounts.verify("sam", "a long enough password"))?.username, "sam");
  assert.equal(await accounts.verify("sam", "the wrong password"), null);
  assert.equal(await accounts.verify("nobody", "a long enough password"), null);
});

test("unused link access edits apply at signup and failed edits preserve its grants", async (t) => {
  const accounts = new Accounts(":memory:");
  t.after(() => {
    accounts.close();
  });
  let now = Date.UTC(2026, 0, 1);
  accounts.now = () => now;
  const { invite, token } = accounts.createInvite();
  const grants = [{ node: catalog.defaultNode, scopes: ["devices" as const] }];
  assert.deepEqual(accounts.setInviteGrants(invite.id, grants).grants, grants);
  assert.throws(() =>
    accounts.setInviteGrants(invite.id, [
      { node: catalog.defaultNode, scopes: ["lights"] },
      { node: catalog.defaultNode, scopes: ["lights"] },
    ]),
  );
  assert.deepEqual(accounts.invite(invite.id).grants, grants, "a failed update rolls back the deleted grants");
  now += inviteLifetimeMs;
  assert.deepEqual(accounts.setInviteGrants(invite.id, [{ node: catalog.defaultNode, scopes: ["lights"] }]).grants, [
    { node: catalog.defaultNode, scopes: ["lights"] },
  ]);
  accounts.setInviteExpiration(invite.id, now + inviteLifetimeMs);
  assert.deepEqual((await accounts.join(token, "changed-access", "a long enough password")).grants, [
    { node: catalog.defaultNode, scopes: ["lights"] },
  ]);
  assert.throws(() => accounts.setInviteGrants(invite.id, []), AccountError);
  const revoked = accounts.createInvite();
  accounts.revokeInvite(revoked.invite.id);
  assert.throws(() => accounts.setInviteGrants(revoked.invite.id, []), AccountError);
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
  assert.deepEqual(
    accounts.setGrants("sam", [{ node: catalog.defaultNode, scopes: ["manage", "lights", "manage"] }]).grants,
    [{ node: catalog.defaultNode, scopes: ["lights", "manage"] }],
  );
  assert.throws(() => accounts.setGrants("nobody", [{ node: catalog.defaultNode, scopes: [] }]), AccountError);
});

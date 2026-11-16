// TailscaleStore against an in-memory account database.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Accounts } from "./accounts.js";
import { settings, settingsFile } from "./settings.js";
import { schemaText, scriptPath } from "./tailscale-gateway.js";
import { TailscaleError, TailscaleStore } from "./tailscale-store.js";

const alice = { providerUserId: "u1", login: "alice@example.com", displayName: "Alice" };
const bob = { providerUserId: "u2", login: "bob@example.com", displayName: "Bob" };

async function setup(...usernames: string[]) {
  const accounts = new Accounts(":memory:", settings.accounts);
  for (const username of usernames)
    await accounts.join(accounts.createInvite().token, username, "a long enough password");
  const clock = { now: 1_000 };
  const store = new TailscaleStore(
    accounts.database,
    schemaText(scriptPath(settings.tailscale, settingsFile)),
    () => clock.now,
  );
  return { accounts, store, clock };
}

await test("a new store has no links and managed access off", async () => {
  const { store } = await setup();
  assert.deepEqual(store.links(), []);
  assert.equal(store.linkOf("alice"), null);
  assert.deepEqual(store.state(), { enabledAt: null, syncedAt: null, error: null, family: null, familyReadAt: null });
});

await test("links start without access and are listed by username", async () => {
  const { store, clock } = await setup("bob", "alice");
  clock.now = 2_000;
  assert.deepEqual(store.link("bob", bob), { username: "bob", ...bob, access: false, linkedAt: 2_000 });
  store.link("alice", alice);
  assert.deepEqual(
    store.links().map((link) => link.username),
    ["alice", "bob"],
  );
  assert.equal(store.linkOf("alice")?.login, "alice@example.com");
});

await test("linking the same user again refreshes its login and name but keeps access and link time", async () => {
  const { store, clock } = await setup("alice");
  store.link("alice", alice);
  store.setAccess("alice", true);
  clock.now = 5_000;
  const renamed = store.link("alice", { ...alice, login: "alice@new.example.com", displayName: "Alice B" });
  assert.equal(renamed.login, "alice@new.example.com");
  assert.equal(renamed.displayName, "Alice B");
  assert.equal(renamed.access, true);
  assert.equal(renamed.linkedAt, 1_000);
});

await test("an account links to one user and a user to one account", async () => {
  const { store } = await setup("alice", "bob");
  store.link("alice", alice);
  assert.throws(
    () => store.link("alice", bob),
    (error) => error instanceof TailscaleError && error.status === 409,
  );
  assert.throws(
    () => store.link("bob", alice),
    (error) => error instanceof TailscaleError && error.status === 409,
  );
  assert.equal(store.linkOf("bob"), null);
});

await test("linking an unknown account is a 404", async () => {
  const { store } = await setup();
  assert.throws(
    () => store.link("nobody", alice),
    (error) => error instanceof TailscaleError && error.status === 404,
  );
});

await test("access changes need a link", async () => {
  const { store } = await setup("alice");
  assert.throws(
    () => store.setAccess("alice", true),
    (error) => error instanceof TailscaleError && error.status === 409,
  );
  store.link("alice", alice);
  assert.equal(store.setAccess("alice", true).access, true);
  assert.equal(store.setAccess("alice", false).access, false);
});

await test("unlinking reports whether a link was removed", async () => {
  const { store } = await setup("alice");
  store.link("alice", alice);
  assert.equal(store.unlink("alice"), true);
  assert.equal(store.unlink("alice"), false);
  assert.equal(store.linkOf("alice"), null);
});

await test("deleting an account deletes its link", async () => {
  const { accounts, store } = await setup("alice");
  store.link("alice", alice);
  accounts.deleteAccount("alice");
  assert.deepEqual(store.links(), []);
});

await test("enabling records the first time only", async () => {
  const { store, clock } = await setup();
  clock.now = 3_000;
  store.enable();
  clock.now = 4_000;
  store.enable();
  assert.equal(store.state().enabledAt, 3_000);
});

await test("the state reads the sync's result and group:family as written by the sync", async () => {
  const { accounts, store } = await setup();
  accounts.database
    .prepare("UPDATE tailscale_sync SET synced_at=?, error=?, family=?, family_read_at=? WHERE id=1")
    .run(7_000, "provider down", JSON.stringify(["alice@example.com"]), 6_000);
  assert.deepEqual(store.state(), {
    enabledAt: null,
    syncedAt: 7_000,
    error: "provider down",
    family: ["alice@example.com"],
    familyReadAt: 6_000,
  });
});

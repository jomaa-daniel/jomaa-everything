// TailscaleService against an in-memory gateway, an in-memory account
// database, and a fake clock.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Accounts, type Account } from "./accounts.js";
import { newLog } from "./log.js";
import { settings, settingsFile } from "./settings.js";
import { TailscaleService } from "./tailscale.js";
import {
  schemaText,
  scriptPath,
  type Observation,
  type ProviderUser,
  type SyncOutcome,
  type TailscaleGateway,
} from "./tailscale-gateway.js";
import { TailscaleError, TailscaleStore } from "./tailscale-store.js";

const maxAgeMs = settings.tailscale.observationMaxAgeSeconds * 1000;
const intervalMs = settings.tailscale.syncIntervalSeconds * 1000;

function user(id: string, loginName: string, type = "member", role = "member"): ProviderUser {
  return { id, loginName, displayName: loginName, type, role, status: "active", lastSeen: null };
}

const alice = user("u1", "alice@example.com");
const sharedAlice = user("u9", "alice@example.com", "shared");

/** A tailnet held in memory. */
class MemoryGateway implements TailscaleGateway {
  observation: Observation = {
    observedAt: 0,
    users: { ok: true, value: [alice, sharedAlice] },
    devices: { ok: true, value: [] },
    policy: { ok: true, value: { family: [] } },
    server: { ok: false, error: "not read in this test" },
  };
  observeFailure: Error | null = null;
  syncFailure: Error | null = null;
  observes = 0;
  syncs = 0;
  /** Runs while each sync is in progress, after the sync has started. */
  duringSync: () => void = () => undefined;

  observe(): Promise<Observation> {
    this.observes++;
    if (this.observeFailure) return Promise.reject(this.observeFailure);
    return Promise.resolve(structuredClone(this.observation));
  }

  async sync(): Promise<SyncOutcome> {
    this.syncs++;
    await Promise.resolve();
    this.duringSync();
    if (this.syncFailure) throw this.syncFailure;
    return { status: "applied", message: "policy written" };
  }
}

async function setup() {
  const accounts = new Accounts(":memory:", settings.accounts);
  await accounts.join(accounts.createInvite().token, "alice", "a long enough password");
  const clock = { now: 1_000_000 };
  const gateway = new MemoryGateway();
  const logs: string[] = [];
  const store = new TailscaleStore(
    accounts.database,
    schemaText(scriptPath(settings.tailscale, settingsFile)),
    () => clock.now,
  );
  const service = new TailscaleService(
    store,
    gateway,
    accounts,
    settings.tailscale,
    newLog({}, (line) => logs.push(line)),
    () => clock.now,
  );
  const account = (username: string): Account => {
    const found = accounts.account(username);
    if (found === null) throw new Error(`no account ${username}`);
    return found;
  };
  return { accounts, clock, gateway, logs, store, service, account };
}

await test("a change during a sync runs one more sync, not one per change", async () => {
  const { gateway, service, clock } = await setup();
  gateway.duringSync = () => {
    if (gateway.syncs === 1) {
      service.sync();
      service.sync();
      service.sync();
    }
  };
  service.sync();
  assert.equal(service.syncing, true);
  await service.idle();
  assert.equal(gateway.syncs, 2);
  assert.equal(service.syncing, false);
  assert.equal(service.nextSyncAt, clock.now + intervalMs);
  await service.close();
});

await test("a failing sync is logged and the next one is still scheduled", async () => {
  const { gateway, service, logs, clock } = await setup();
  gateway.syncFailure = new Error("provider down");
  service.sync();
  await service.idle();
  assert.ok(logs.some((line) => line.includes("tailscale sync failed") && line.includes("provider down")));
  assert.equal(service.nextSyncAt, clock.now + intervalMs);
  await service.close();
});

await test("a closed service doesn't sync", async () => {
  const { gateway, service } = await setup();
  await service.close();
  service.sync();
  await service.idle();
  assert.equal(gateway.syncs, 0);
  assert.equal(service.nextSyncAt, null);
});

await test("enabling turns on managed access and syncs", async () => {
  const { gateway, service, clock } = await setup();
  clock.now = 2_000_000;
  service.enable();
  await service.idle();
  assert.equal(service.state().enabledAt, 2_000_000);
  assert.equal(gateway.syncs, 1);
  await service.close();
});

await test("linking reads the user fresh from the provider, saves it without access, and syncs", async () => {
  const { gateway, service, account, store } = await setup();
  const link = await service.link(account("alice"), "u1");
  await service.idle();
  assert.equal(link.login, "alice@example.com");
  assert.equal(link.access, false);
  assert.deepEqual(store.linkOf("alice"), link);
  assert.equal(gateway.observes, 1);
  assert.equal(gateway.syncs, 1);
  assert.equal(service.profile(account("alice")).access, "no-access");
  await service.close();
});

await test("linking refuses users the provider doesn't list or that are shared in, and saves nothing", async () => {
  const { gateway, service, account, store } = await setup();
  const refused = (status: number) => (error: unknown) => error instanceof TailscaleError && error.status === status;
  await assert.rejects(service.link(account("alice"), "missing"), refused(404));
  await assert.rejects(service.link(account("alice"), "u9"), refused(409));
  gateway.observation.users = { ok: false, error: "users unavailable" };
  await assert.rejects(service.link(account("alice"), "u1"), refused(502));
  gateway.observeFailure = new Error("command failed");
  await assert.rejects(service.link(account("alice"), "u1"), refused(502));
  assert.equal(store.linkOf("alice"), null);
  assert.equal(gateway.syncs, 0);
  await service.close();
});

await test("unlinking syncs only when something was linked", async () => {
  const { gateway, service, account, store } = await setup();
  service.unlink(account("alice"));
  await service.idle();
  assert.equal(gateway.syncs, 0);
  await service.link(account("alice"), "u1");
  await service.idle();
  service.unlink(account("alice"));
  await service.idle();
  assert.equal(store.linkOf("alice"), null);
  assert.equal(gateway.syncs, 2);
  await service.close();
});

await test("access is saved for linked accounts and shown as pending until Tailscale lists them", async () => {
  const { gateway, service, account, accounts } = await setup();
  assert.throws(
    () => service.setAccess(account("alice"), true),
    (error) => error instanceof TailscaleError && error.status === 409,
  );
  await service.link(account("alice"), "u1");
  await service.idle();
  assert.equal(service.setAccess(account("alice"), true).access, true);
  await service.idle();
  assert.equal(gateway.syncs, 2);
  assert.equal(service.profile(account("alice")).access, "giving");
  accounts.database.prepare("UPDATE tailscale_sync SET family=? WHERE id=1").run(JSON.stringify(["alice@example.com"]));
  assert.equal(service.profile(account("alice")).access, "access");
  service.setAccess(account("alice"), false);
  await service.idle();
  assert.equal(service.profile(account("alice")).access, "removing");
  await service.close();
});

await test("observations go stale after observationMaxAgeSeconds and refresh only then", async () => {
  const { gateway, service, clock } = await setup();
  assert.deepEqual(service.observed().users, { value: null, observedAt: null, stale: true, error: null });
  await service.refresh(false);
  assert.equal(gateway.observes, 1);
  const observedAt = clock.now;
  assert.deepEqual(service.observed().users, {
    value: [alice, sharedAlice],
    observedAt,
    stale: false,
    error: null,
  });
  clock.now += maxAgeMs;
  assert.equal(service.observed().users.stale, false);
  await service.refresh(false);
  assert.equal(gateway.observes, 1);
  clock.now += 1;
  assert.equal(service.observed().users.stale, true);
  await service.refresh(false);
  assert.equal(gateway.observes, 2);
  await service.refresh(true);
  assert.equal(gateway.observes, 3);
  await service.close();
});

await test("a failed observation keeps the last values, marks them stale, and records the error", async () => {
  const { gateway, service, clock } = await setup();
  await service.refresh(true);
  const observedAt = clock.now;
  gateway.observation.devices = { ok: false, error: "devices unavailable" };
  await service.refresh(true);
  assert.deepEqual(service.observed().devices, { value: [], observedAt, stale: true, error: "devices unavailable" });
  assert.equal(service.observed().users.stale, false);
  gateway.observeFailure = new Error("command failed");
  await service.refresh(true);
  const users = service.observed().users;
  assert.deepEqual(users.value, [alice, sharedAlice]);
  assert.equal(users.stale, true);
  assert.equal(users.error, "command failed");
  await service.close();
});

await test("provider users list members with the account each is linked to", async () => {
  const { service, account } = await setup();
  await service.link(account("alice"), "u1");
  await service.idle();
  assert.deepEqual(service.providerUsers(), [
    { id: "u1", login: "alice@example.com", displayName: "alice@example.com", linkedTo: "alice" },
  ]);
  await service.close();
});

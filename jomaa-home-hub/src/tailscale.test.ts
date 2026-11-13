// The Tailscale API and service against the real sync (tailnet.py) and a fake
// provider: isolated databases, fake lights, and no real tailnet or token.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { mock, test } from "node:test";
import { Accounts } from "./accounts.js";
import { Api } from "./api.js";
import { allFeatures, type Command, type Device, type Features, type State } from "./device.js";
import { Group } from "./group.js";
import { HealthStore } from "./health/store.js";
import { Hub } from "./hub.js";
import { silentLog } from "./log.js";
import { MatterNotReadyError, type MatterAdmin } from "./matter/nodes.js";
import { AccountOnboarding, OnboardingError, TailscaleOnboarding } from "./onboarding.js";
import { MemberPrincipal, OwnerPrincipal } from "./principal.js";
import { settings } from "./settings.js";
import { TailscaleService } from "./tailscale.js";
import { schemaText, type SyncOutcome, type TailscaleGateway } from "./tailscale-gateway.js";
import { TailscaleStore } from "./tailscale-store.js";
import { FakeTailnet } from "./tailscale-testing.js";
import { serve } from "./testing.js";
import { UserService } from "./users.js";

const ownerPassword = "owner password for tailscale tests";

class Lamp implements Device {
  readonly name = "Lamp";
  commands: Command[] = [];
  constructor(readonly id: string) {}
  apply(command: Command): Promise<void> {
    this.commands.push(command);
    return Promise.resolve();
  }
  state(): Promise<State> {
    return Promise.resolve({ on: false, brightness: 0, colorTemperaturePct: 0 });
  }
  features(): Features {
    return allFeatures;
  }
}

const noMatter: MatterAdmin = {
  ready: false,
  nodes: () => [],
  discover: () => Promise.reject(new MatterNotReadyError()),
  register: () => Promise.reject(new MatterNotReadyError()),
  rename: () => Promise.reject(new MatterNotReadyError()),
  commission: () => Promise.reject(new MatterNotReadyError()),
  setWiFiCredentials: () => Promise.reject(new MatterNotReadyError()),
  setThreadDataset: () => Promise.reject(new MatterNotReadyError()),
  removeNode: () => Promise.reject(new MatterNotReadyError()),
};

type Json = Record<string, unknown>;

interface Reply {
  status: number;
  body: Json;
}

class World {
  url = "";
  ownerToken = "";
  lamp = new Lamp("lamp");
  clock = { now: Date.now() };
  service!: TailscaleService;

  private constructor(
    readonly database: string,
    readonly accounts: Accounts,
    readonly fake: FakeTailnet,
  ) {}

  /** A hub with a fake provider whose policy lists family; managed access is on unless enabled is false. */
  static async create(family: string[] = [], enabled = true): Promise<World> {
    const database = join(mkdtempSync(join(tmpdir(), "hub-tailscale-")), "accounts.sqlite");
    const world = new World(database, new Accounts(database), await FakeTailnet.create(family));
    world.service = world.newService();
    await world.listen();
    if (enabled) {
      assert.equal((await world.owner("POST", "/api/tailscale/enable", {})).status, 200);
      await world.service.idle();
    }
    return world;
  }

  newService(gateway?: TailscaleGateway): TailscaleService {
    return new TailscaleService(
      new TailscaleStore(this.accounts.database, schemaText(), () => this.clock.now),
      gateway ?? this.fake.gateway(this.database),
      this.accounts,
      settings.tailscale,
      silentLog,
      () => this.clock.now,
    );
  }

  async listen(): Promise<void> {
    const hub = new Hub();
    hub.addDevice("test", this.lamp);
    hub.addRoom(new Group("room", "Room", [this.lamp]));
    const api = new Api(
      hub,
      noMatter,
      ownerPassword,
      this.accounts,
      silentLog,
      new HealthStore(":memory:"),
      undefined,
      undefined,
      this.service,
    );
    this.url = await serve(api.handle);
    this.ownerToken = String((await this.call("POST", "/api/login", { password: ownerPassword })).body["token"]);
  }

  async call(
    method: string,
    path: string,
    body?: unknown,
    token = "",
    headers: Record<string, string> = {},
  ): Promise<Reply> {
    const response = await fetch(this.url + path, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as Json };
  }

  owner(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
    return this.call(method, path, body, this.ownerToken, headers);
  }

  /** Creates an account through an invite and signs it in. */
  async member(username: string, scopes: string[] = []): Promise<string> {
    const token = String((await this.owner("POST", "/api/invites", {})).body["token"]);
    const password = `${username} password long enough`;
    assert.equal((await this.call("POST", "/api/join", { token, username, password })).status, 201);
    if (scopes.length)
      assert.equal((await this.owner("PUT", `/api/accounts/${username}/scopes`, { scopes })).status, 200);
    return String((await this.call("POST", "/api/login", { username, password })).body["token"]);
  }

  async view(): Promise<Json> {
    return (await this.owner("GET", "/api/tailscale")).body;
  }

  async profile(username: string): Promise<Json> {
    const found = ((await this.view())["profiles"] as Json[]).find((p) => p["username"] === username);
    assert.ok(found, `no profile ${username}`);
    return found;
  }

  async access(username: string): Promise<unknown> {
    return (await this.profile(username))["access"];
  }

  link(username: string, providerUserId: string): Promise<Reply> {
    return this.owner("PUT", `/api/tailscale/profiles/${username}/link`, { providerUserId });
  }

  async setAccess(username: string, access: boolean): Promise<Reply> {
    const reply = await this.owner("PUT", `/api/tailscale/profiles/${username}/access`, { access });
    await this.service.idle();
    return reply;
  }

  rows(sql: string): Json[] {
    const db = new DatabaseSync(this.database, { readOnly: true });
    try {
      return db.prepare(sql).all();
    } finally {
      db.close();
    }
  }

  snapshot(): string {
    return JSON.stringify({
      links: this.rows("SELECT * FROM tailscale_links"),
      sync: this.rows("SELECT enabled_at FROM tailscale_sync"),
      writes: this.fake.state().writes.length,
    });
  }

  close(): Promise<void> {
    return this.service.close();
  }
}

await test("linking saves the Tailscale user and gives no access", async () => {
  const w = await World.create();
  await w.member("alice");
  assert.equal(await w.access("alice"), "unlinked");
  const reply = await w.link("alice", "u1");
  assert.equal(reply.status, 200);
  const profile = reply.body["profile"] as Json;
  assert.deepEqual(profile["link"], {
    providerUserId: "u1",
    login: "alice@example.com",
    displayName: "Alice",
    role: "member",
    access: false,
  });
  assert.equal(profile["access"], "no-access");
  await w.service.idle();
  assert.deepEqual(w.fake.family(), []);
  const steps = (profile["onboarding"] as Json)["steps"] as Json[];
  assert.deepEqual(
    steps.map((s) => [s["id"], s["state"]]),
    [
      ["account", "complete"],
      ["identity", "complete"],
      ["access", "not-started"],
      ["device", "complete"],
      ["exit-node", "unknown"],
    ],
  );
  await w.close();
});

await test("typed logins, shared users, unknown users and unknown fields never link", async () => {
  const w = await World.create();
  await w.member("alice");
  const before = w.snapshot();
  for (const body of [
    { providerUserId: "u1", login: "alice@example.com" },
    { login: "alice@example.com" },
    { providerUserId: "<script>" },
    { providerUserId: "u9" },
    { providerUserId: "u404" },
  ])
    assert.ok((await w.owner("PUT", "/api/tailscale/profiles/alice/link", body)).status >= 400, JSON.stringify(body));
  assert.equal((await w.owner("PUT", "/api/tailscale/profiles/%3Cb%3E/link", { providerUserId: "u1" })).status, 404);
  assert.equal((await w.owner("PUT", "/api/tailscale/profiles/%E0%A4/link", { providerUserId: "u1" })).status, 400);
  assert.equal(w.snapshot(), before);
  await w.close();
});

await test("an account has one Tailscale user and a Tailscale user one account", async () => {
  const w = await World.create();
  await w.member("alice");
  await w.member("bob");
  const [first, second] = await Promise.all([w.link("alice", "u1"), w.link("bob", "u1")]);
  assert.deepEqual([first.status, second.status].sort(), [200, 409]);
  assert.equal(w.rows("SELECT * FROM tailscale_links").length, 1);
  const winner = first.status === 200 ? "alice" : "bob";
  assert.equal((await w.link(winner, "u4")).status, 409);
  assert.equal((await w.link(winner, "u1")).status, 200, "linking the same user again is fine");
  assert.equal(w.rows("SELECT * FROM tailscale_links").length, 1);
  await w.close();
});

await test("only the linked user's untagged devices are listed", async () => {
  const w = await World.create();
  await w.member("alice");
  await w.link("alice", "u1");
  const devices = ((await w.profile("alice"))["devices"] as Json)["value"] as Json[];
  assert.deepEqual(
    devices.map((d) => d["name"]),
    ["alice-phone", "alice-laptop"],
  );
  assert.equal(devices[1]?.["connected"], null, "fields Tailscale didn't report stay unknown");
  await w.close();
});

await test("nothing is written until managed access is on, and the page says who would lose access", async () => {
  const w = await World.create(["old@example.com", "alice@example.com"], false);
  await w.member("alice");
  await w.link("alice", "u1");
  await w.setAccess("alice", true);
  assert.equal(w.fake.state().writes.length, 0);
  assert.deepEqual(w.fake.family(), ["alice@example.com", "old@example.com"]);
  const view = await w.view();
  assert.deepEqual(view["wouldLoseAccess"], ["old@example.com"]);
  assert.equal((view["sync"] as Json)["enabledAt"], null);
  await w.owner("POST", "/api/tailscale/enable", {});
  await w.service.idle();
  assert.deepEqual(w.fake.family(), ["alice@example.com"]);
  assert.equal(await w.access("alice"), "access");
  await w.close();
});

await test("giving and removing access shows what is saved and what Tailscale enforces", async () => {
  const w = await World.create();
  await w.member("alice");
  await w.link("alice", "u1");
  assert.equal((await w.setAccess("alice", true)).status, 200);
  assert.deepEqual(w.fake.family(), ["alice@example.com"]);
  assert.equal(await w.access("alice"), "access");
  const writes = w.fake.state().writes.length;
  await w.setAccess("alice", true);
  assert.equal(w.fake.state().writes.length, writes, "an unchanged policy is not rewritten");
  w.fake.update((s) => {
    s.faults = { policyRead: ["unreachable"] };
  });
  await w.setAccess("alice", false);
  assert.equal(await w.access("alice"), "removing");
  assert.match(String(((await w.view())["sync"] as Json)["error"]), /unreachable/);
  assert.equal((await w.owner("POST", "/api/tailscale/sync", {})).status, 202);
  await w.service.idle();
  assert.deepEqual(w.fake.family(), []);
  assert.equal(await w.access("alice"), "no-access");
  assert.equal(((await w.view())["sync"] as Json)["error"], null);
  await w.close();
});

await test("removing an admin's access says their admin role still reaches the tailnet", async () => {
  const w = await World.create();
  await w.member("alice");
  await w.link("alice", "u3");
  const profile = (await w.setAccess("alice", false)).body["profile"] as Json;
  assert.match(String(profile["adminNote"]), /Tailscale admin/);
  assert.equal(w.fake.state().users.find((u) => u.id === "u3")?.role, "owner");
  await w.close();
});

await test("deleting an account removes its access, and a recreated name starts unlinked", async () => {
  const w = await World.create();
  const token = await w.member("alice", ["lights"]);
  await w.link("alice", "u1");
  await w.setAccess("alice", true);
  assert.equal((await w.owner("DELETE", "/api/accounts/alice")).status, 200);
  assert.equal((await w.call("GET", "/api/targets", undefined, token)).status, 401);
  await w.service.idle();
  assert.deepEqual(w.fake.family(), []);
  assert.equal(w.rows("SELECT * FROM tailscale_links").length, 0);
  await w.member("alice");
  assert.equal(await w.access("alice"), "unlinked");
  assert.equal((await w.link("alice", "u1")).status, 200);
  await w.close();
});

await test("people Tailscale still lists without access are shown until the sync removes them", async () => {
  const w = await World.create();
  await w.member("alice");
  await w.link("alice", "u1");
  await w.setAccess("alice", true);
  w.fake.update((s) => {
    s.faults = { policyRead: ["unreachable"] };
  });
  await w.owner("DELETE", "/api/accounts/alice");
  await w.service.idle();
  assert.deepEqual((await w.view())["removing"], ["alice@example.com"]);
  w.service.sync();
  await w.service.idle();
  assert.deepEqual((await w.view())["removing"], []);
  assert.deepEqual(w.fake.family(), []);
  await w.close();
});

await test("a link that finishes after its account was deleted saves nothing", async () => {
  const w = await World.create();
  await w.member("alice");
  const gate: { release: (() => void) | null } = { release: null };
  const real = w.fake.gateway(w.database);
  await w.service.close();
  w.service = w.newService({
    observe: async (signal) => {
      await new Promise<void>((resolve) => (gate.release = resolve));
      return real.observe(signal);
    },
    sync: (signal) => real.sync(signal),
  });
  await w.listen();
  const linking = w.link("alice", "u1");
  while (gate.release === null) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((await w.owner("DELETE", "/api/accounts/alice")).status, 200);
  gate.release();
  assert.equal((await linking).status, 404);
  assert.equal(w.rows("SELECT * FROM tailscale_links").length, 0);
  await w.close();
});

await test("invalid steps are refused without changes", async () => {
  const w = await World.create();
  await w.member("alice");
  const before = w.snapshot();
  assert.equal((await w.setAccess("alice", true)).status, 409);
  assert.equal(
    (await w.owner("PUT", "/api/tailscale/profiles/alice/access", { access: true, done: true })).status,
    400,
  );
  assert.equal((await w.owner("PUT", "/api/tailscale/profiles/alice/step", { step: "device" })).status, 404);
  const onboarding = new TailscaleOnboarding(w.accounts, w.service);
  await assert.rejects(onboarding.advance("alice", { type: "grant" }), OnboardingError);
  await assert.rejects(onboarding.advance("nobody", { type: "unlink" }), OnboardingError);
  const accounts = new AccountOnboarding(new UserService(w.accounts, ownerPassword));
  await assert.rejects(accounts.advance("nobody", { type: "set-scopes", scopes: ["lights"] }), OnboardingError);
  assert.equal(accounts.status("alice").steps[1]?.state, "not-started");
  assert.equal(w.snapshot(), before);
  await w.close();
});

await test("Tailscale management is owner-only and checked before anything happens", async () => {
  const w = await World.create();
  await w.member("alice");
  await w.link("alice", "u1");
  const all = await w.member("bob", ["lights", "devices", "manage"]);
  const none = await w.member("carol");
  await w.service.idle();
  const before = w.snapshot();
  const reads = w.fake.state().reads;
  const routes: [string, string, unknown][] = [
    ["GET", "/api/tailscale", undefined],
    ["POST", "/api/tailscale/refresh", {}],
    ["POST", "/api/tailscale/sync", {}],
    ["POST", "/api/tailscale/enable", {}],
    ["PUT", "/api/tailscale/profiles/alice/link", { providerUserId: "u2" }],
    ["DELETE", "/api/tailscale/profiles/alice/link", undefined],
    ["PUT", "/api/tailscale/profiles/alice/access", { access: true }],
  ];
  for (const [method, path, body] of routes) {
    const signedOut = await w.call(method, path, body);
    assert.equal(signedOut.status, 401, `${method} ${path}`);
    assert.deepEqual(Object.keys(signedOut.body), ["error"]);
    for (const token of [all, none]) assert.equal((await w.call(method, path, body, token)).status, 403);
    assert.equal((await w.call(method, path, body, "device-credential")).status, 401);
  }
  const crossSite = await w.owner(
    "PUT",
    "/api/tailscale/profiles/alice/access",
    { access: true },
    { Origin: "https://evil.example" },
  );
  assert.equal(crossSite.status, 403);
  assert.equal(w.snapshot(), before);
  assert.equal(w.fake.state().reads, reads);
  await w.close();
});

await test("exit-node access and hub page scopes are independent", async () => {
  const w = await World.create();
  const token = await w.member("alice");
  await w.link("alice", "u1");
  await w.setAccess("alice", true);
  for (const path of ["/api/targets", "/api/manage", "/api/devices", "/api/accounts"])
    assert.equal((await w.call("GET", path, undefined, token)).status, 403, path);
  await w.owner("PUT", "/api/accounts/alice/scopes", { scopes: ["lights"] });
  assert.equal((await w.call("GET", "/api/targets", undefined, token)).status, 200);
  await w.owner("PUT", "/api/accounts/alice/scopes", { scopes: [] });
  assert.equal((await w.call("GET", "/api/targets", undefined, token)).status, 403);
  assert.deepEqual(w.fake.family(), ["alice@example.com"]);
  await w.close();
});

await test("each existing scope opens only its own feature", async () => {
  const w = await World.create();
  const paths: Record<string, string[]> = {
    lights: ["/api/targets"],
    devices: ["/api/devices", "/api/matter/nodes"],
    manage: ["/api/manage"],
  };
  for (const scope of Object.keys(paths)) {
    const token = await w.member(`only-${scope}`, [scope]);
    for (const [other, list] of Object.entries(paths))
      for (const path of list) {
        const status = (await w.call("GET", path, undefined, token)).status;
        if (other === scope) assert.notEqual(status, 403, `${scope} ${path}`);
        else assert.equal(status, 403, `${scope} ${path}`);
      }
    assert.equal((await w.call("GET", "/api/tailscale", undefined, token)).status, 403);
  }
  await w.close();
});

await test("joining creates an account with no access and no Tailscale change", async () => {
  const w = await World.create();
  const writes = w.fake.state().writes.length;
  await w.member("dave");
  assert.deepEqual(w.accounts.account("dave")?.scopes, []);
  assert.equal(w.rows("SELECT * FROM tailscale_links").length, 0);
  assert.equal(w.fake.state().writes.length, writes);
  await w.close();
});

await test("a provider outage leaves sign-in and lights working", async () => {
  const w = await World.create();
  w.fake.update((s) => {
    s.faults = {
      users: ["unreachable"],
      devices: ["unreachable"],
      policyRead: ["unreachable"],
      local: ["unreachable"],
    };
  });
  const token = await w.member("alice", ["lights"]);
  const view = await w.owner("POST", "/api/tailscale/refresh", {});
  assert.equal(view.status, 200);
  const observed = view.body["observed"] as Json;
  assert.match(String((observed["users"] as Json)["error"]), /unreachable/);
  assert.equal((observed["server"] as Json)["stale"], true);
  assert.equal((await w.call("GET", "/healthz")).status, 200);
  assert.equal((await w.call("POST", "/api/targets/room/command", { on: true }, token)).status, 200);
  assert.equal(w.lamp.commands.length, 1);
  const wrong = await w.call("POST", "/api/login", { username: "alice", password: "wrong password here" });
  assert.equal(wrong.body["error"], "wrong username or password");
  await w.close();
});

await test("observations go stale with age and after a failed check", async () => {
  const w = await World.create();
  await w.member("alice");
  await w.link("alice", "u1");
  assert.equal(((await w.profile("alice"))["devices"] as Json)["stale"], false);
  w.clock.now += (settings.tailscale.observationMaxAgeSeconds + 1) * 1000;
  w.fake.update((s) => {
    s.faults = { devices: ["unreachable"] };
  });
  const stale = (await w.profile("alice"))["devices"] as Json;
  assert.equal(stale["stale"], true);
  assert.match(String(stale["error"]), /unreachable/);
  assert.equal((stale["value"] as Json[]).length, 2, "the last devices seen are kept");
  await w.close();
});

await test("jerry's connection, advertised routes and approved routes stay separate", async () => {
  const w = await World.create();
  const value = (((await w.view())["observed"] as Json)["server"] as Json)["value"] as Json;
  assert.equal(value["backendState"], "Running");
  assert.deepEqual(value["advertisedRoutes"], ["0.0.0.0/0", "192.168.1.0/24", "::/0"]);
  assert.deepEqual(value["approvedRoutes"], ["192.168.1.0/24"]);
  assert.ok(Array.isArray(value["problems"]));
  await w.close();
});

await test("existing account rows survive the Tailscale tables being created", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "hub-accounts-")), "accounts.sqlite");
  const accounts = new Accounts(file);
  await accounts.join(accounts.createInvite().token, "olduser", "an old password here");
  accounts.setScopes("olduser", ["lights"]);
  const session = accounts.createSession("olduser");
  const dump = (db: DatabaseSync) =>
    JSON.stringify(
      ["accounts", "account_scopes", "sessions", "invites"].map((table) => db.prepare(`SELECT * FROM ${table}`).all()),
    );
  const before = dump(accounts.database);
  accounts.close();
  const reopened = new Accounts(file);
  new TailscaleStore(reopened.database, schemaText(), Date.now);
  assert.equal(dump(reopened.database), before);
  assert.ok(await reopened.verify("olduser", "an old password here"));
  const users = new UserService(reopened, ownerPassword);
  const request = (token: string) => ({ headers: { authorization: `Bearer ${token}` } }) as never;
  assert.ok(users.resolve(request(users.ownerSignIn(ownerPassword) ?? "")) instanceof OwnerPrincipal);
  const member = users.resolve(request(session));
  assert.ok(member instanceof MemberPrincipal);
  assert.equal(member.account.username, "olduser");
  assert.ok(member.has("lights") && !member.has("manage"));
  reopened.close();
});

await test("the hub syncs at startup and then every interval until it closes", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const accounts = new Accounts(join(mkdtempSync(join(tmpdir(), "hub-interval-")), "accounts.sqlite"));
    let syncs = 0;
    const gateway: TailscaleGateway = {
      observe: () => Promise.reject(new Error("not observed in this test")),
      sync: (): Promise<SyncOutcome> => {
        syncs++;
        return Promise.resolve({ status: "failed", message: "provider down" });
      },
    };
    const clock = { now: 1_000_000 };
    const service = new TailscaleService(
      new TailscaleStore(accounts.database, schemaText(), () => clock.now),
      gateway,
      accounts,
      settings.tailscale,
      silentLog,
      () => clock.now,
    );
    service.start();
    await service.idle();
    assert.equal(syncs, 1);
    const interval = settings.tailscale.syncIntervalSeconds * 1000;
    assert.equal(service.nextSyncAt, clock.now + interval);
    mock.timers.tick(interval);
    await service.idle();
    assert.equal(syncs, 2);
    service.sync();
    service.sync();
    service.sync();
    await service.idle();
    assert.equal(syncs, 4, "syncs requested during a sync run once more, not once each");
    await service.close();
    assert.equal(service.nextSyncAt, null);
    service.sync();
    mock.timers.tick(interval);
    assert.equal(syncs, 4);
    accounts.close();
  } finally {
    mock.timers.reset();
  }
});

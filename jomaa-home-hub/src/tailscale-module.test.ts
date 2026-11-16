// The /api/tailscale routes, dispatched straight to TailscaleModule with a
// stub service: no server, no rest of the API.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Accounts, scopes, type Account } from "./accounts.js";
import { HttpError } from "./http.js";
import { JsonShapeError } from "./json.js";
import { OnboardingError, TailscaleOnboarding, type TailscaleProfiles } from "./onboarding.js";
import { MemberPrincipal, OwnerPrincipal, type Principal } from "./principal.js";
import { settings } from "./settings.js";
import type { DeviceView, Observed, ProfileView } from "./tailscale.js";
import type { ProviderDevice, ProviderUser, ServerStatus } from "./tailscale-gateway.js";
import { TailscaleModule, type TailscaleOverview } from "./tailscale-module.js";
import type { Link, SyncState } from "./tailscale-store.js";
import { dispatch } from "./testing.js";

function observed<T>(value: T | null, observedAt: number | null): Observed<T> {
  return { value, observedAt, stale: observedAt === null, error: null };
}

function link(username: string, access: boolean): Link {
  return { username, providerUserId: "u1", login: "alice@example.com", displayName: "Alice", access, linkedAt: 1 };
}

/** A Tailscale service whose state the test sets; records every call the routes make. */
class StubTailscale implements TailscaleOverview, TailscaleProfiles {
  syncing = false;
  nextSyncAt: number | null = 9_000;
  links: Link[] = [];
  syncState: SyncState = { enabledAt: 1_000, syncedAt: 2_000, error: null, family: [], familyReadAt: 2_000 };
  family: string[] = [];
  removingLogins: string[] = [];
  calls: string[] = [];
  readonly store = { links: () => this.links };

  observed(): {
    users: Observed<ProviderUser[]>;
    devices: Observed<ProviderDevice[]>;
    policy: Observed<{ family: string[] }>;
    server: Observed<ServerStatus>;
  } {
    return {
      users: observed([], 3_000),
      devices: { ...observed([], 3_000), stale: true, error: "devices unavailable" },
      policy: observed({ family: this.family }, 3_000),
      server: observed<ServerStatus>(null, null),
    };
  }

  state(): SyncState {
    return this.syncState;
  }

  removing(): string[] {
    return this.removingLogins;
  }

  providerUsers(): { id: string; login: string; displayName: string; linkedTo: string | null }[] {
    return [{ id: "u1", login: "alice@example.com", displayName: "Alice", linkedTo: null }];
  }

  profile(account: Account): ProfileView {
    const saved = this.links.find((l) => l.username === account.username);
    return {
      username: account.username,
      link: saved
        ? {
            providerUserId: saved.providerUserId,
            login: saved.login,
            displayName: saved.displayName,
            role: "member",
            access: saved.access,
          }
        : null,
      access: saved ? (saved.access ? "giving" : "no-access") : "unlinked",
      adminNote: null,
      devices: observed<DeviceView[]>(null, null),
    };
  }

  profiles(): ProfileView[] {
    return [];
  }

  refresh(force: boolean): Promise<void> {
    this.calls.push(`refresh ${String(force)}`);
    return Promise.resolve();
  }

  sync(): void {
    this.calls.push("sync");
  }

  enable(): void {
    this.calls.push("enable");
  }

  link(account: Account, providerUserId: string): Promise<Link> {
    this.calls.push(`link ${account.username} ${providerUserId}`);
    const saved = link(account.username, false);
    this.links = [saved];
    return Promise.resolve(saved);
  }

  unlink(account: Account): void {
    this.calls.push(`unlink ${account.username}`);
    this.links = [];
  }

  setAccess(account: Account, access: boolean): Link {
    this.calls.push(`access ${account.username} ${String(access)}`);
    const saved = link(account.username, access);
    this.links = [saved];
    return saved;
  }
}

async function setup() {
  const accounts = new Accounts(":memory:", settings.accounts);
  await accounts.join(accounts.createInvite().token, "alice", "a long enough password");
  const member = new MemberPrincipal(
    accounts.setScopes(
      "alice",
      scopes.map((scope) => scope.id),
    ),
  );
  const tailscale = new StubTailscale();
  const module = new TailscaleModule(
    accounts,
    tailscale,
    new TailscaleOnboarding(accounts, tailscale),
    settings.tailscale,
  );
  const owner = new OwnerPrincipal();
  const call = (
    method: string,
    path: string,
    body: unknown = null,
    principal: Principal | null = owner,
    headers: Record<string, string> = {},
  ) => dispatch(module, { principal, method, path, body, headers });
  return { tailscale, member, call };
}

const routes: [string, string, unknown][] = [
  ["GET", "/api/tailscale", null],
  ["POST", "/api/tailscale/refresh", {}],
  ["POST", "/api/tailscale/sync", {}],
  ["POST", "/api/tailscale/enable", {}],
  ["PUT", "/api/tailscale/profiles/alice/link", { providerUserId: "u1" }],
  ["DELETE", "/api/tailscale/profiles/alice/link", null],
  ["PUT", "/api/tailscale/profiles/alice/access", { access: true }],
];

const status = (code: number) => (error: unknown) =>
  (error instanceof HttpError || error instanceof OnboardingError) && error.status === code;

await test("every route is owner-only: signed out is 401, an account with every scope is 403", async () => {
  const { tailscale, member, call } = await setup();
  for (const [method, path, body] of routes) {
    await assert.rejects(call(method, path, body, null), status(401), `${method} ${path}`);
    await assert.rejects(
      call(method, path, body, member),
      (error) => status(403)(error) && error instanceof Error && error.message === "Only the hub owner can do this.",
      `${method} ${path}`,
    );
  }
  assert.deepEqual(tailscale.calls, []);
});

await test("the overview refreshes old observations and reports sync, observations, people and setup links", async () => {
  const { tailscale, call } = await setup();
  tailscale.syncing = true;
  const reply = await call("GET", "/api/tailscale");
  assert.equal(reply.status, 200);
  assert.deepEqual(tailscale.calls, ["refresh false"]);
  assert.deepEqual(reply.body, {
    sync: { enabledAt: 1_000, syncedAt: 2_000, error: null, familyReadAt: 2_000, syncing: true, nextSyncAt: 9_000 },
    observed: {
      users: { observedAt: 3_000, stale: false, error: null },
      devices: { observedAt: 3_000, stale: true, error: "devices unavailable" },
      server: { value: null, observedAt: null, stale: true, error: null },
    },
    wouldLoseAccess: [],
    removing: [],
    providerUsers: [{ id: "u1", login: "alice@example.com", displayName: "Alice", linkedTo: null }],
    profiles: [],
    setup: { downloadUrl: settings.tailscale.downloadUrl, adminUsersUrl: settings.tailscale.adminUsersUrl },
  });
});

await test("before managed access is on, the overview lists who Tailscale's policy would drop", async () => {
  const { tailscale, call } = await setup();
  tailscale.syncState = { ...tailscale.syncState, enabledAt: null };
  tailscale.family = ["alice@example.com", "old@example.com"];
  tailscale.links = [link("alice", true)];
  tailscale.removingLogins = ["ignored@example.com"];
  const body = (await call("GET", "/api/tailscale")).body;
  assert.ok(body !== null && typeof body === "object");
  assert.deepEqual(Reflect.get(body, "wouldLoseAccess"), ["old@example.com"]);
  assert.deepEqual(Reflect.get(body, "removing"), []);
});

await test("once managed access is on, the overview lists who is being removed", async () => {
  const { tailscale, call } = await setup();
  tailscale.family = ["old@example.com"];
  tailscale.removingLogins = ["old@example.com"];
  const body = (await call("GET", "/api/tailscale")).body;
  assert.ok(body !== null && typeof body === "object");
  assert.deepEqual(Reflect.get(body, "wouldLoseAccess"), []);
  assert.deepEqual(Reflect.get(body, "removing"), ["old@example.com"]);
});

await test("refresh, sync and enable take an empty body and answer with the overview", async () => {
  const { tailscale, call } = await setup();
  assert.equal((await call("POST", "/api/tailscale/refresh", {})).status, 200);
  assert.equal((await call("POST", "/api/tailscale/sync", {})).status, 202);
  assert.equal((await call("POST", "/api/tailscale/enable", {})).status, 200);
  assert.deepEqual(tailscale.calls, ["refresh true", "sync", "enable"]);
  await assert.rejects(call("POST", "/api/tailscale/sync", { now: true }), JsonShapeError);
  assert.deepEqual(tailscale.calls, ["refresh true", "sync", "enable"]);
});

await test("changes from another site are refused before anything runs", async () => {
  const { tailscale, call } = await setup();
  for (const [method, path, body] of routes.filter(([method]) => method !== "GET"))
    await assert.rejects(
      call(method, path, body, new OwnerPrincipal(), { "Sec-Fetch-Site": "cross-site" }),
      status(403),
      `${method} ${path}`,
    );
  assert.deepEqual(tailscale.calls, []);
});

await test("linking checks the account and the Tailscale user ID, then answers with the profile", async () => {
  const { tailscale, call } = await setup();
  await assert.rejects(call("PUT", "/api/tailscale/profiles/nobody/link", { providerUserId: "u1" }), status(404));
  await assert.rejects(
    call("PUT", "/api/tailscale/profiles/alice/link", { providerUserId: "not valid!" }),
    status(400),
  );
  await assert.rejects(call("PUT", "/api/tailscale/profiles/alice/link", { providerUserId: null }), status(400));
  assert.deepEqual(tailscale.calls, []);
  const reply = await call("PUT", "/api/tailscale/profiles/%20Alice/link", { providerUserId: "u1" });
  assert.equal(reply.status, 200);
  assert.deepEqual(tailscale.calls, ["link alice u1"]);
  assert.ok(reply.body !== null && typeof reply.body === "object");
  const profile: unknown = Reflect.get(reply.body, "profile");
  assert.ok(profile !== null && typeof profile === "object");
  assert.equal(Reflect.get(profile, "username"), "alice");
  assert.equal(Reflect.get(profile, "access"), "no-access");
  const onboarding: unknown = Reflect.get(profile, "onboarding");
  assert.ok(onboarding !== null && typeof onboarding === "object");
  assert.ok(Array.isArray(Reflect.get(onboarding, "steps")));
});

await test("access needs true or false and a link, and unlinking answers with the unlinked profile", async () => {
  const { tailscale, call } = await setup();
  await assert.rejects(call("PUT", "/api/tailscale/profiles/alice/access", { access: null }), status(400));
  await assert.rejects(call("PUT", "/api/tailscale/profiles/alice/access", { access: true }), status(409));
  assert.deepEqual(tailscale.calls, []);
  tailscale.links = [link("alice", false)];
  assert.equal((await call("PUT", "/api/tailscale/profiles/alice/access", { access: true })).status, 200);
  const unlinked = await call("DELETE", "/api/tailscale/profiles/alice/link");
  assert.equal(unlinked.status, 200);
  assert.deepEqual(tailscale.calls, ["access alice true", "unlink alice"]);
  assert.ok(unlinked.body !== null && typeof unlinked.body === "object");
  const profile: unknown = Reflect.get(unlinked.body, "profile");
  assert.ok(profile !== null && typeof profile === "object");
  assert.equal(Reflect.get(profile, "link"), null);
});

await test("a path the module serves under another method is 405, and an unknown path is 404", async () => {
  const { call } = await setup();
  await assert.rejects(call("DELETE", "/api/tailscale"), status(405));
  await assert.rejects(call("GET", "/api/tailscale/unknown"), status(404));
});

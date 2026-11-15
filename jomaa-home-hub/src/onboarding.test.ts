// TailscaleOnboarding against a stub of the Tailscale service.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Accounts, type Account } from "./accounts.js";
import { OnboardingError, TailscaleOnboarding, type TailscaleProfiles } from "./onboarding.js";
import { settings } from "./settings.js";
import type { DeviceView, ProfileView } from "./tailscale.js";
import { TailscaleError, type Link } from "./tailscale-store.js";

const phone: DeviceView = {
  id: "d1",
  name: "alice-phone",
  os: "iOS",
  lastSeen: null,
  connected: true,
  expires: null,
  keyExpiryDisabled: false,
};

function link(username: string, access: boolean): Link {
  return { username, providerUserId: "u1", login: "alice@example.com", displayName: "Alice", access, linkedAt: 1 };
}

function unlinked(username: string): ProfileView {
  return {
    username,
    link: null,
    access: "unlinked",
    adminNote: null,
    devices: { value: null, observedAt: null, stale: true, error: null },
  };
}

function linked(username: string, change: Partial<ProfileView>): ProfileView {
  return {
    ...unlinked(username),
    link: { providerUserId: "u1", login: "alice@example.com", displayName: "Alice", role: "member", access: true },
    access: "access",
    devices: { value: [phone], observedAt: 1, stale: false, error: null },
    ...change,
  };
}

/** Profiles set by the test; records every change the onboarding asks for. */
class StubProfiles implements TailscaleProfiles {
  view: ProfileView | null = null;
  failure: TailscaleError | null = null;
  calls: string[] = [];

  profile(account: Account): ProfileView {
    return this.view ?? unlinked(account.username);
  }

  link(account: Account, providerUserId: string): Promise<Link> {
    this.calls.push(`link ${account.username} ${providerUserId}`);
    if (this.failure) return Promise.reject(this.failure);
    return Promise.resolve(link(account.username, false));
  }

  unlink(account: Account): void {
    this.calls.push(`unlink ${account.username}`);
  }

  setAccess(account: Account, access: boolean): Link {
    this.calls.push(`access ${account.username} ${String(access)}`);
    if (this.failure) throw this.failure;
    return link(account.username, access);
  }
}

async function setup() {
  const accounts = new Accounts(":memory:", settings.accounts);
  await accounts.join(accounts.createInvite().token, "alice", "a long enough password");
  const profiles = new StubProfiles();
  return { profiles, onboarding: new TailscaleOnboarding(accounts, profiles) };
}

const refused = (status: number) => (error: unknown) => error instanceof OnboardingError && error.status === status;

await test("an unknown account has no status and can't advance", async () => {
  const { onboarding, profiles } = await setup();
  assert.throws(() => onboarding.status("nobody"), refused(404));
  await assert.rejects(onboarding.advance("nobody", { type: "unlink" }), refused(404));
  assert.deepEqual(profiles.calls, []);
});

await test("an unlinked account's next step is linking its Tailscale user", async () => {
  const { onboarding } = await setup();
  const status = onboarding.status("alice");
  assert.deepEqual(
    status.steps.map((step) => [step.id, step.state]),
    [
      ["account", "complete"],
      ["identity", "not-started"],
      ["access", "not-started"],
      ["device", "unknown"],
      ["exit-node", "unknown"],
    ],
  );
  assert.equal(status.next, status.steps[1]?.detail);
  assert.match(status.steps[3]?.detail ?? "", /not read yet/);
});

await test("a linked account with access and a fresh device has nothing left that the hub can see", async () => {
  const { onboarding, profiles } = await setup();
  profiles.view = linked("alice", {});
  const status = onboarding.status("alice");
  assert.deepEqual(
    status.steps.map((step) => step.state),
    ["complete", "complete", "complete", "complete", "unknown"],
  );
  assert.equal(status.next, null);
  assert.match(status.steps[1]?.detail ?? "", /alice@example\.com/);
});

await test("the access and device steps follow the profile", async () => {
  const { onboarding, profiles } = await setup();
  const states = (view: ProfileView) => {
    profiles.view = view;
    const steps = onboarding.status("alice").steps;
    return [steps[2]?.state, steps[3]?.state];
  };
  assert.deepEqual(states(linked("alice", { access: "giving" })), ["pending", "complete"]);
  assert.deepEqual(states(linked("alice", { access: "removing" })), ["pending", "complete"]);
  assert.deepEqual(states(linked("alice", { access: "no-access" })), ["not-started", "complete"]);
  assert.deepEqual(states(linked("alice", { devices: { value: [], observedAt: 1, stale: false, error: null } })), [
    "complete",
    "not-started",
  ]);
  profiles.view = linked("alice", { devices: { value: [phone], observedAt: 1, stale: true, error: null } });
  const device = onboarding.status("alice").steps[3];
  assert.equal(device?.state, "unknown");
  assert.match(device.detail, /when last checked/);
  profiles.view = linked("alice", { devices: { value: null, observedAt: null, stale: true, error: "offline" } });
  assert.match(onboarding.status("alice").steps[3]?.detail ?? "", /offline/);
});

await test("giving access needs a link first", async () => {
  const { onboarding, profiles } = await setup();
  await assert.rejects(onboarding.advance("alice", { type: "grant" }), refused(409));
  assert.deepEqual(profiles.calls, []);
});

await test("an account linked to one user can't be linked to another until it is unlinked", async () => {
  const { onboarding, profiles } = await setup();
  profiles.view = linked("alice", {});
  await assert.rejects(onboarding.advance("alice", { type: "link", providerUserId: "u2" }), refused(409));
  assert.deepEqual(profiles.calls, []);
  await onboarding.advance("alice", { type: "link", providerUserId: "u1" });
  assert.deepEqual(profiles.calls, ["link alice u1"]);
});

await test("each action calls the service once", async () => {
  const { onboarding, profiles } = await setup();
  assert.deepEqual(await onboarding.advance("alice", { type: "link", providerUserId: "u1" }), link("alice", false));
  profiles.view = linked("alice", {});
  assert.deepEqual(await onboarding.advance("alice", { type: "grant" }), link("alice", true));
  assert.deepEqual(await onboarding.advance("alice", { type: "revoke" }), link("alice", false));
  assert.equal(await onboarding.advance("alice", { type: "unlink" }), null);
  assert.deepEqual(profiles.calls, ["link alice u1", "access alice true", "access alice false", "unlink alice"]);
});

await test("a refusal from the service becomes an onboarding refusal with its status", async () => {
  const { onboarding, profiles } = await setup();
  profiles.failure = new TailscaleError(502, "Couldn't read Tailscale users");
  await assert.rejects(onboarding.advance("alice", { type: "link", providerUserId: "u1" }), refused(502));
  profiles.view = linked("alice", {});
  profiles.failure = new TailscaleError(409, "Link alice to a Tailscale user first.");
  await assert.rejects(onboarding.advance("alice", { type: "grant" }), refused(409));
});

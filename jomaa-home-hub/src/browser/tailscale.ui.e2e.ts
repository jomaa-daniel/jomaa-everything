// Drives Tailscale and account setup through the built UI with a mocked hub API.
import assert from "node:assert/strict";
import { after, before, describe, test, type TestContext } from "node:test";
import { chromium, type Browser, type Page } from "playwright-core";
import type { Account } from "../accounts.js";
import type { OnboardingStatus, StepState } from "../onboarding.js";
import { settings } from "../settings.js";
import type { ServerStatus } from "../tailscale-gateway.js";
import type { SyncState } from "../tailscale-store.js";
import type { AccessState, Observed, ProfileView } from "../tailscale.js";
import { MockApi, serveUi } from "./ui-fixture.js";

type Profile = ProfileView & { onboarding: OnboardingStatus };
type Meta = Omit<Observed<unknown>, "value">;
interface View {
  sync: Omit<SyncState, "family"> & { syncing: boolean; nextSyncAt: number | null };
  observed: { users: Meta; devices: Meta; server: Observed<ServerStatus> };
  wouldLoseAccess: string[] | null;
  removing: string[];
  providerUsers: { id: string; login: string; displayName: string; linkedTo: string | null }[];
  profiles: Profile[];
  setup: { downloadUrl: string; adminUsersUrl: string };
}

const now = Date.now();
const ownerPassword = "owner password for the mocked UI";
const guestPassword = "guest password for the mocked UI";
const alice = { id: "u1", login: "alice@example.test", displayName: "Alice", linkedTo: null };
const bob = { id: "u2", login: "bob@example.test", displayName: "Bob", linkedTo: null };
const sarah: Account = { username: "sarah", createdAt: now, scopes: [] };

function observed<T>(value: T): Observed<T> {
  return { value, observedAt: now, stale: false, error: null };
}

function profile(access: AccessState = "unlinked"): Profile {
  const linked = access !== "unlinked";
  const stepStates: Record<AccessState, StepState> = {
    unlinked: "not-started",
    "no-access": "not-started",
    giving: "pending",
    removing: "pending",
    access: "complete",
  };
  return {
    username: sarah.username,
    access,
    link: linked
      ? {
          providerUserId: alice.id,
          login: alice.login,
          displayName: alice.displayName,
          role: "member",
          access: access === "access" || access === "giving",
        }
      : null,
    adminNote: null,
    devices: observed([]),
    onboarding: {
      steps: [
        { id: "account", title: "Account", state: "complete", detail: "Account created." },
        {
          id: "identity",
          title: "Tailscale user",
          state: linked ? "complete" : "not-started",
          detail: linked ? `Linked to ${alice.login}.` : "Link a Tailscale user.",
        },
        { id: "access", title: "Exit-node access", state: stepStates[access], detail: "Access reported by the API." },
        { id: "device", title: "Device", state: "not-started", detail: "No device signed in yet." },
        { id: "exit-node", title: "Exit node chosen", state: "unknown", detail: "Choose jerry under Exit node." },
      ],
      next: null,
    },
  };
}

function view(person = profile()): View {
  return {
    sync: { enabledAt: now, syncedAt: now, error: null, familyReadAt: now, syncing: false, nextSyncAt: null },
    observed: {
      users: { observedAt: now, stale: false, error: null },
      devices: { observedAt: now, stale: false, error: null },
      server: observed({
        hostname: "jerry",
        tag: "tag:jerry",
        tailnet: "example.test",
        backendState: "Running",
        online: true,
        tagged: true,
        advertisedRoutes: ["192.0.2.0/24"],
        approvedRoutes: ["192.0.2.0/24"],
        problems: [],
      }),
    },
    wouldLoseAccess: [],
    removing: [],
    providerUsers: [{ ...alice, linkedTo: person.link ? person.username : null }, bob],
    profiles: [person],
    setup: {
      downloadUrl: settings.tailscale.downloadUrl,
      adminUsersUrl: settings.tailscale.adminUsersUrl,
    },
  };
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("Tailscale UI with mocked backend services", () => {
  let browser: Browser | undefined;
  let pages: Awaited<ReturnType<typeof serveUi>>;

  before(async () => {
    pages = await serveUi();
    browser = await chromium.launch({ channel: "chrome", headless: true });
  });
  after(async () => {
    await browser?.close();
    await pages.close();
  });

  async function fixture(t: TestContext, initial = view(), session: "owner" | "member" | null = "owner") {
    assert.ok(browser);
    const context = await browser.newContext();
    const api = new MockApi(context, pages.origin);
    const state = { view: initial, session, accounts: [sarah] };
    api.on("GET", "/api/session", () =>
      state.session === null
        ? { status: 401, body: { error: "sign in first" } }
        : {
            body: {
              owner: state.session === "owner",
              username: state.session === "owner" ? null : "sarah",
              scopes: [],
            },
          },
    );
    api.on("GET", "/api/tailscale", () =>
      state.session === "owner" ? { body: state.view } : { status: 401, body: { error: "sign in first" } },
    );
    api.on("GET", "/api/accounts", () => ({
      body: {
        accounts: state.accounts,
        scopes: [
          { id: "lights", name: "Lights" },
          { id: "devices", name: "Device health" },
          { id: "manage", name: "Device organization" },
        ],
      },
    }));
    await api.install();
    t.after(async () => {
      await context.close();
      api.assertHealthy();
    });
    const page = await context.newPage();
    return {
      page,
      api,
      state,
      open: (path = "/tailscale") => page.goto(pages.origin + path),
    };
  }

  async function accessShown(page: Page, access: AccessState): Promise<void> {
    const labels: Record<AccessState, string> = {
      unlinked: "Not linked",
      "no-access": "No access",
      giving: "Giving access…",
      removing: "Removing access…",
      access: "Has access",
    };
    const chip = page.locator(`#profile-sarah .heading [data-state="${access}"]`);
    await chip.waitFor();
    assert.equal(await chip.innerText(), labels[access]);
  }

  test("owner sign-in handles a wrong password and sign-out hides the controls", async (t) => {
    const { page, api, state, open } = await fixture(t, view(), null);
    api.on("POST", "/api/login", (call) => {
      if ((call.body as { password: string }).password === "wrong") {
        assert.deepEqual(call.body, { password: "wrong" });
        return { status: 401, body: { error: "wrong password" } };
      }
      assert.deepEqual(call.body, { password: ownerPassword });
      state.session = "owner";
      return { body: { token: "mock-owner-session" } };
    });
    api.on("POST", "/api/logout", (call) => {
      assert.deepEqual(call.body, {});
      state.session = null;
      return { body: { ok: true } };
    });
    await open();
    await page.locator("#login-section").waitFor();
    assert.ok(await page.locator("#content").isHidden());
    await page.getByLabel("Hub password").fill("wrong");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.locator("#notice", { hasText: "wrong password" }).waitFor();
    assert.equal(await page.getByLabel("Hub password").inputValue(), "");
    await page.getByLabel("Hub password").fill(ownerPassword);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await accessShown(page, "unlinked");
    assert.equal(await page.title(), "Tailscale · Jomaa Home");
    assert.equal(page.url(), pages.origin + "/tailscale");
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.locator("#login-section").waitFor();
    assert.ok(await page.locator("#content").isHidden());
    assert.deepEqual(
      api.mutations().map((call) => call.path),
      ["/api/login", "/api/login", "/api/logout"],
    );
  });

  test("an account that is not the owner gets no Tailscale controls or data", async (t) => {
    const { page, api, open } = await fixture(t, view(), "member");
    await open();
    await page.locator("#not-owner").waitFor();
    assert.ok(await page.locator("#content").isHidden());
    assert.deepEqual(
      api.calls.map((call) => call.path),
      ["/api/session"],
    );
  });

  test("turning on lists lost access and requires confirmation before writing", async (t) => {
    const initial = view(profile("no-access"));
    initial.sync.enabledAt = null;
    initial.sync.syncedAt = null;
    initial.wouldLoseAccess = ["old@example.test"];
    const { page, api, state, open } = await fixture(t, initial);
    api.on("POST", "/api/tailscale/enable", (call) => {
      assert.deepEqual(call.body, {});
      state.view = view(profile("no-access"));
      return { body: state.view };
    });
    await open();
    await page.locator("#enable-loss", { hasText: "old@example.test" }).waitFor();
    assert.deepEqual(api.mutations(), []);
    page.once("dialog", (dialog) => void dialog.dismiss());
    await page.getByRole("button", { name: "Turn on", exact: true }).click();
    await page.locator("#notice", { hasText: "Nothing changed." }).waitFor();
    assert.deepEqual(api.mutations(), []);
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: "Turn on", exact: true }).click();
    await page.locator("#enable-panel").waitFor({ state: "hidden" });
    await page.locator("#notice.success", { hasText: "Managed access is on." }).waitFor();
    assert.deepEqual(api.mutations(), [{ method: "POST", path: "/api/tailscale/enable", body: {} }]);
  });

  test("an unknown policy warning and a failed refresh recover through Refresh", async (t) => {
    const initial = view();
    initial.sync.enabledAt = null;
    initial.wouldLoseAccess = null;
    const { page, api, state, open } = await fixture(t, initial);
    api.reply("POST", "/api/tailscale/refresh", { error: "Tailscale is unavailable" }, 503);
    await open();
    await page.locator("#enable-loss", { hasText: "who has access now is unknown" }).waitFor();
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await page.locator("#notice", { hasText: "Tailscale is unavailable" }).waitFor();
    await page.locator("#refresh:enabled").waitFor();
    assert.ok(await page.locator("#enable-panel").isVisible());
    api.on("POST", "/api/tailscale/refresh", (call) => {
      assert.deepEqual(call.body, {});
      state.view = { ...initial, wouldLoseAccess: [] };
      return { body: state.view };
    });
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await page.locator("#enable-loss", { hasText: "Nobody loses access." }).waitFor();
    assert.equal(api.mutations().length, 2);
  });

  test("an invite is shared, joined and opened from Permissions entirely through the UI", async (t) => {
    const owner = await fixture(t);
    owner.state.accounts = [];
    owner.state.view.profiles = [];
    const invite = { id: "invite-1", createdAt: now, expiresAt: now + 86_400_000 };
    const token = "mock-invite-token";
    owner.api.reply("GET", "/api/invites", { invites: [] });
    owner.api.on("POST", "/api/invites", (call) => {
      assert.deepEqual(call.body, {});
      owner.api.reply("GET", "/api/invites", { invites: [invite] });
      return { status: 201, body: { invite, token } };
    });
    await owner.open("/invite");
    await owner.page.getByRole("button", { name: "Create link", exact: true }).click();
    await owner.page.locator("#invites li").waitFor();
    const link = await owner.page.locator("#link").inputValue();
    assert.equal(link, `${pages.origin}/join#${token}`);
    const guest = await fixture(t, view(), null);
    guest.api.on("POST", "/api/invites/check", (call) => {
      assert.deepEqual(call.body, { token });
      return { body: { expiresAt: invite.expiresAt, passwordLength: settings.accounts.passwordLength } };
    });
    guest.api.on("POST", "/api/join", (call) => {
      assert.deepEqual(call.body, { token, username: "sarah", password: guestPassword });
      owner.state.accounts = [sarah];
      owner.state.view = view();
      guest.api.reply("POST", "/api/invites/check", { error: "Invite is invalid, used, or expired" }, 404);
      return { status: 201, body: { account: sarah } };
    });
    await guest.page.goto(link);
    await guest.page.locator("#join-form").waitFor();
    assert.equal(new URL(guest.page.url()).hash, "");
    await guest.page.getByLabel("Username", { exact: true }).fill("Sarah");
    await guest.page.locator("#password").fill(guestPassword);
    await guest.page.getByLabel("Confirm password").fill("different password");
    await guest.page.getByRole("button", { name: "Create account" }).click();
    assert.ok(guest.api.calls.every((call) => call.path !== "/api/join"));
    await guest.page.getByLabel("Confirm password").fill(guestPassword);
    await guest.page.getByRole("button", { name: "Create account" }).click();
    await guest.page.locator("#done-username", { hasText: "sarah" }).waitFor();
    await guest.page.goto(link);
    await guest.page.locator("#invalid").waitFor();
    assert.ok(await guest.page.locator("#join-form").isHidden());
    await owner.open("/permissions");
    await owner.page.getByRole("link", { name: "Tailscale setup for sarah" }).click();
    await owner.page.waitForURL(`${pages.origin}/tailscale?user=sarah`);
    await owner.page.locator("#profile-sarah.focused").waitFor();
    assert.equal(await owner.page.evaluate("document.activeElement?.textContent"), "sarah");
    await accessShown(owner.page, "unlinked");
  });

  test("linking requires a choice, omits linked users and displays a refused link", async (t) => {
    const initial = view();
    const other = profile("no-access");
    assert.ok(other.link);
    other.username = "bob";
    other.link = { ...other.link, providerUserId: bob.id, login: bob.login, displayName: bob.displayName };
    initial.profiles.push(other);
    initial.providerUsers[1] = { ...bob, linkedTo: "bob" };
    const { page, api, state, open } = await fixture(t, initial);
    await open();
    await accessShown(page, "unlinked");
    assert.deepEqual(await page.getByLabel("Tailscale user for sarah").locator("option").allTextContents(), [
      "Choose a Tailscale user",
      "Alice (alice@example.test)",
    ]);
    await page.getByRole("button", { name: "Link a Tailscale user to sarah" }).click();
    await page.locator("#notice", { hasText: "Choose a Tailscale user first." }).waitFor();
    assert.deepEqual(api.mutations(), []);
    api.on("PUT", "/api/tailscale/profiles/sarah/link", (call) => {
      assert.deepEqual(call.body, { providerUserId: alice.id });
      return { status: 409, body: { error: "This Tailscale user is already linked." } };
    });
    await page.getByLabel("Tailscale user for sarah").selectOption(alice.id);
    await page.getByRole("button", { name: "Link a Tailscale user to sarah" }).click();
    await page.locator("#notice", { hasText: "already linked" }).waitFor();
    await page.locator("#user-sarah:enabled").waitFor();
    await accessShown(page, "unlinked");
    api.on("PUT", "/api/tailscale/profiles/sarah/link", (call) => {
      assert.deepEqual(call.body, { providerUserId: alice.id });
      state.view = view(profile("no-access"));
      state.view.profiles.push(other);
      state.view.providerUsers[1] = { ...bob, linkedTo: "bob" };
      return { body: { profile: state.view.profiles[0] } };
    });
    await page.getByLabel("Tailscale user for sarah").selectOption(alice.id);
    await page.getByRole("button", { name: "Link a Tailscale user to sarah" }).click();
    await accessShown(page, "no-access");
    assert.match(await page.locator("#profile-sarah").innerText(), /Tailscale user: Alice \(alice@example\.test\)/);
    assert.deepEqual(
      api.mutations().map((call) => call.body),
      [{ providerUserId: alice.id }, { providerUserId: alice.id }],
    );
  });

  test("giving access disables controls while saving and stays pending until Sync now succeeds", async (t) => {
    const { page, api, state, open } = await fixture(t, view(profile("no-access")));
    const release = deferred();
    api.on("PUT", "/api/tailscale/profiles/sarah/access", async (call) => {
      assert.deepEqual(call.body, { access: true });
      await release.promise;
      state.view = view(profile("giving"));
      state.view.sync.error = "Tailscale write timed out";
      return { body: { profile: state.view.profiles[0] } };
    });
    api.on("POST", "/api/tailscale/sync", (call) => {
      assert.deepEqual(call.body, {});
      state.view = view(profile("access"));
      return { status: 202, body: state.view };
    });
    await open();
    const saving = page.waitForRequest(
      (request) =>
        request.method() === "PUT" && new URL(request.url()).pathname === "/api/tailscale/profiles/sarah/access",
    );
    try {
      await Promise.all([saving, page.getByRole("button", { name: "Give exit-node access to sarah" }).click()]);
      assert.ok(await page.getByRole("button", { name: "Refresh", exact: true }).isDisabled());
      assert.ok(await page.getByRole("button", { name: "Sync now" }).isDisabled());
      assert.ok(await page.getByRole("button", { name: "Unlink sarah from Tailscale" }).isDisabled());
      assert.equal(api.mutations().length, 1);
    } finally {
      release.resolve();
    }
    await accessShown(page, "giving");
    assert.match(await page.locator("#profile-sarah").innerText(), /Last sync failed: Tailscale write timed out/);
    assert.equal(await page.locator('#profile-sarah [data-step="access"] .state').innerText(), "Not applied yet");
    await page.getByRole("button", { name: "Sync now" }).click();
    await accessShown(page, "access");
    assert.equal(await page.locator('#profile-sarah [data-step="access"] .state').innerText(), "Done");
    assert.doesNotMatch(await page.locator("#profile-sarah").innerText(), /Last sync failed/);
    assert.deepEqual(
      api.mutations().map((call) => call.body),
      [{ access: true }, {}],
    );
  });

  test("removing access shows the sync error and people still listed until sync confirms removal", async (t) => {
    const { page, api, state, open } = await fixture(t, view(profile("access")));
    api.on("PUT", "/api/tailscale/profiles/sarah/access", (call) => {
      assert.deepEqual(call.body, { access: false });
      state.view = view(profile("removing"));
      state.view.sync.error = "Tailscale is unreachable";
      state.view.removing = [alice.login, "orphan@example.test"];
      return { body: { profile: state.view.profiles[0] } };
    });
    api.on("POST", "/api/tailscale/sync", (call) => {
      assert.deepEqual(call.body, {});
      state.view = view(profile("no-access"));
      return { status: 202, body: state.view };
    });
    await open();
    await page.getByRole("button", { name: "Remove exit-node access from sarah" }).click();
    await accessShown(page, "removing");
    assert.match(await page.locator("#profile-sarah").innerText(), /Removing access…/);
    assert.match(await page.locator("#profile-sarah").innerText(), /Last sync failed: Tailscale is unreachable/);
    assert.deepEqual(await page.locator("#removing li").allTextContents(), [alice.login, "orphan@example.test"]);
    await page.getByRole("button", { name: "Sync now" }).click();
    await accessShown(page, "no-access");
    assert.ok(await page.locator("#removing-section").isHidden());
    assert.deepEqual(
      api.mutations().map((call) => call.body),
      [{ access: false }, {}],
    );
  });

  test("unlinking requires confirmation and permits linking a different stable user ID", async (t) => {
    const { page, api, state, open } = await fixture(t, view(profile("access")));
    api.on("DELETE", "/api/tailscale/profiles/sarah/link", (call) => {
      assert.equal(call.body, undefined);
      state.view = view();
      state.view.removing = [alice.login];
      return { body: { profile: state.view.profiles[0] } };
    });
    api.on("PUT", "/api/tailscale/profiles/sarah/link", (call) => {
      assert.deepEqual(call.body, { providerUserId: bob.id });
      const linked = profile("no-access");
      assert.ok(linked.link);
      linked.link = { ...linked.link, providerUserId: bob.id, login: bob.login, displayName: bob.displayName };
      state.view = view(linked);
      state.view.providerUsers = [alice, { ...bob, linkedTo: "sarah" }];
      return { body: { profile: linked } };
    });
    await open();
    page.once("dialog", (dialog) => void dialog.dismiss());
    await page.getByRole("button", { name: "Unlink sarah from Tailscale" }).click();
    await page.locator("#notice", { hasText: "Nothing changed." }).waitFor();
    assert.deepEqual(api.mutations(), []);
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: "Unlink sarah from Tailscale" }).click();
    await accessShown(page, "unlinked");
    assert.deepEqual(await page.locator("#removing li").allTextContents(), [alice.login]);
    await page.getByLabel("Tailscale user for sarah").selectOption(bob.id);
    await page.getByRole("button", { name: "Link a Tailscale user to sarah" }).click();
    await accessShown(page, "no-access");
    assert.match(await page.locator("#profile-sarah").innerText(), /Bob \(bob@example\.test\)/);
    assert.deepEqual(
      api.mutations().map((call) => call.method),
      ["DELETE", "PUT"],
    );
  });

  test("stale devices, unknown routes and admin access are displayed without guessing", async (t) => {
    const person = profile("access");
    assert.ok(person.link);
    person.link.role = "admin";
    person.adminNote = "This person is a Tailscale admin; their role still grants access.";
    person.devices = {
      ...observed([
        {
          id: "phone",
          name: "Alice phone",
          os: "iOS",
          connected: true,
          lastSeen: null,
          expires: null,
          keyExpiryDisabled: true,
        },
      ]),
      stale: true,
      error: "The device check failed",
    };
    const initial = view(person);
    assert.ok(initial.observed.server.value);
    initial.observed.server.value.approvedRoutes = null;
    const { page, open } = await fixture(t, initial);
    await open();
    await accessShown(page, "access");
    const text = await page.locator("#profile-sarah").innerText();
    assert.match(text, /Alice phone \(iOS\): connection unknown, last seen unknown, key doesn't expire/);
    assert.match(text, /latest check failed: The device check failed/);
    assert.match(text, /Tailscale admin; their role still grants access/);
    assert.match(text, /Exit node chosen: Unknown/);
    assert.match(await page.locator("#server").innerText(), /Approved routes\s+Unknown/);
    assert.match(await page.locator("#server").innerText(), /Exit node in use\s+Not reported by Tailscale/);
  });

  test("Permissions saves pages and deleting an account leaves access visible until sync", async (t) => {
    const { page, api, state, open } = await fixture(t, view(profile("access")));
    api.on("PUT", "/api/accounts/sarah/scopes", (call) => {
      assert.deepEqual(call.body, { scopes: ["lights"] });
      state.accounts = [{ ...sarah, scopes: ["lights"] }];
      return { body: { account: state.accounts[0] } };
    });
    api.on("DELETE", "/api/accounts/sarah", (call) => {
      assert.equal(call.body, undefined);
      state.accounts = [];
      state.view = { ...view(), profiles: [], removing: [alice.login] };
      return { body: { ok: true } };
    });
    api.on("POST", "/api/tailscale/sync", (call) => {
      assert.deepEqual(call.body, {});
      state.view = { ...state.view, removing: [] };
      return { status: 202, body: state.view };
    });
    await open("/permissions");
    await page.getByLabel("sarah can open Lights").check();
    await page.locator("#notice.success", { hasText: "Saved sarah." }).waitFor();
    await page.reload();
    assert.ok(await page.getByLabel("sarah can open Lights").isChecked());
    page.once("dialog", (dialog) => void dialog.dismiss());
    await page.getByRole("button", { name: "Delete account sarah" }).click();
    assert.equal(api.mutations().length, 1);
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: "Delete account sarah" }).click();
    await page.locator("#accounts-empty").waitFor();
    await page.getByRole("link", { name: "Jomaa Home", exact: true }).click();
    await page.getByRole("link", { name: "Tailscale", exact: true }).click();
    await page.locator("#profiles-empty").waitFor();
    assert.deepEqual(await page.locator("#removing li").allTextContents(), [alice.login]);
    await page.getByRole("button", { name: "Sync now" }).click();
    await page.locator("#removing-section").waitFor({ state: "hidden" });
    assert.deepEqual(
      api.mutations().map((call) => call.path),
      ["/api/accounts/sarah/scopes", "/api/accounts/sarah", "/api/tailscale/sync"],
    );
  });

  test("an expired session hides data on the next action and supports signing in again", async (t) => {
    const { page, api, state, open } = await fixture(t, view(profile("access")));
    api.on("POST", "/api/tailscale/refresh", (call) => {
      assert.deepEqual(call.body, {});
      state.session = null;
      return { status: 401, body: { error: "sign in first" } };
    });
    api.on("POST", "/api/login", (call) => {
      assert.deepEqual(call.body, { password: ownerPassword });
      state.session = "owner";
      return { body: { token: "mock-owner-session" } };
    });
    await open();
    await accessShown(page, "access");
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await page.locator("#login-section").waitFor();
    assert.ok(await page.locator("#content").isHidden());
    await page.getByLabel("Hub password").fill(ownerPassword);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await accessShown(page, "access");
    assert.ok(await page.locator("#login-section").isHidden());
  });

  test("empty accounts, setup links and a focused profile work at phone width", async (t) => {
    const initial = { ...view(), profiles: [] };
    const { page, api, state, open } = await fixture(t, initial);
    await page.setViewportSize({ width: 375, height: 800 });
    await open();
    await page.locator("#profiles-empty").waitFor();
    assert.equal(await page.locator("#admin-users").getAttribute("href"), settings.tailscale.adminUsersUrl);
    assert.equal(await page.locator("#download").getAttribute("href"), settings.tailscale.downloadUrl);
    state.view = view();
    api.on("POST", "/api/tailscale/refresh", (call) => {
      assert.deepEqual(call.body, {});
      return { body: state.view };
    });
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await accessShown(page, "unlinked");
    await open("/tailscale?user=sarah");
    await page.locator("#profile-sarah.focused").waitFor();
    assert.equal(await page.evaluate("document.activeElement?.textContent"), "sarah");
    assert.ok(await page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"));
    assert.equal(await page.locator("#notice").getAttribute("aria-live"), "polite");
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await page.locator("#refresh:enabled").waitFor();
    assert.equal(await page.evaluate("document.activeElement?.id"), "refresh");
  });
});

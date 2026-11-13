// Exit-node access for accounts: links to Tailscale users, who has access,
// what Tailscale enforces, and the sync that makes them match. Changes are
// saved first; the sync (tailnet.py) then writes the tailnet policy. It runs
// after every change, every tailscale.syncIntervalSeconds, and at startup.
import type { Account, Accounts } from "./accounts.js";
import type { Log } from "./log.js";
import type { TailscaleSettings } from "./settings.js";
import type {
  Observation,
  ProviderDevice,
  ProviderUser,
  Section,
  ServerStatus,
  SyncOutcome,
  TailscaleGateway,
} from "./tailscale-gateway.js";
import { TailscaleError, type Link, type SyncState, type TailscaleStore } from "./tailscale-store.js";

/** Provider roles that reach the whole tailnet through their role, whatever the family group says. */
const adminRoles = new Set(["owner", "admin", "it-admin", "network-admin"]);

/**
 * An account's access: saved access compared with group:family as last read
 * back from Tailscale. "giving" and "removing" mean they don't match yet.
 */
export type AccessState = "unlinked" | "access" | "no-access" | "giving" | "removing";

/** The last good value of one observation, its age, and the latest failure. */
export interface Observed<T> {
  value: T | null;
  observedAt: number | null;
  stale: boolean;
  error: string | null;
}

export interface DeviceView {
  id: string;
  name: string;
  os: string | null;
  lastSeen: string | null;
  connected: boolean | null;
  expires: string | null;
  keyExpiryDisabled: boolean | null;
}

export interface ProfileView {
  username: string;
  link: { providerUserId: string; login: string; displayName: string; role: string | null; access: boolean } | null;
  access: AccessState;
  adminNote: string | null;
  devices: Observed<DeviceView[]>;
}

const adminNote =
  "This person is a Tailscale admin, so they reach the whole tailnet through their role, which this page doesn't change.";

function emptyObserved<T>(): Observed<T> {
  return { value: null, observedAt: null, stale: true, error: null };
}

export class TailscaleService {
  readonly #abort = new AbortController();
  #users: Observed<ProviderUser[]> = emptyObserved();
  #devices: Observed<ProviderDevice[]> = emptyObserved();
  #policy: Observed<{ family: string[] }> = emptyObserved();
  #server: Observed<ServerStatus> = emptyObserved();
  #observing: Promise<Observation | null> | null = null;
  #running: Promise<void> | null = null;
  #again = false;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #nextSyncAt: number | null = null;
  #closed = false;

  constructor(
    readonly store: TailscaleStore,
    private readonly gateway: TailscaleGateway,
    private readonly accounts: Accounts,
    private readonly settings: TailscaleSettings,
    private readonly log: Log,
    private readonly now: () => number = Date.now,
  ) {}

  /** Syncs now and then every syncIntervalSeconds. */
  start(): void {
    this.sync();
  }

  /** Stops the timer and any running command, and waits for them. */
  async close(): Promise<void> {
    this.#closed = true;
    this.#clearTimer();
    this.#abort.abort();
    await Promise.allSettled([this.#running, this.#observing]);
  }

  /** Resolves when no sync is running. */
  async idle(): Promise<void> {
    while (this.#running) await this.#running;
  }

  get syncing(): boolean {
    return this.#running !== null;
  }

  get nextSyncAt(): number | null {
    return this.#nextSyncAt;
  }

  /** Syncs now; a sync already running runs once more after it. */
  sync(): void {
    if (this.#closed) return;
    this.#clearTimer();
    if (this.#running) {
      this.#again = true;
      return;
    }
    this.#running = this.#loop().finally(() => {
      this.#running = null;
    });
  }

  state(): SyncState {
    return this.store.state();
  }

  /** Observes the provider and jerry again; with force false, only when the last observation is too old. */
  async refresh(force: boolean): Promise<void> {
    const age = this.#users.observedAt === null ? Infinity : this.now() - this.#users.observedAt;
    if (!force && age <= this.settings.observationMaxAgeSeconds * 1000) return;
    await this.#observe();
  }

  observed(): {
    users: Observed<ProviderUser[]>;
    devices: Observed<ProviderDevice[]>;
    policy: Observed<{ family: string[] }>;
    server: Observed<ServerStatus>;
  } {
    return {
      users: this.#fresh(this.#users),
      devices: this.#fresh(this.#devices),
      policy: this.#fresh(this.#policy),
      server: this.#fresh(this.#server),
    };
  }

  /** This tailnet's users, with the account each is linked to. */
  providerUsers(): { id: string; login: string; displayName: string; linkedTo: string | null }[] {
    const linked = new Map(this.store.links().map((l) => [l.providerUserId, l.username]));
    return (this.#users.value ?? [])
      .filter((u) => u.type === "member")
      .map((u) => ({ id: u.id, login: u.loginName, displayName: u.displayName, linkedTo: linked.get(u.id) ?? null }));
  }

  profile(account: Account): ProfileView {
    const link = this.store.linkOf(account.username);
    const user = link ? (this.#users.value ?? []).find((u) => u.id === link.providerUserId) : undefined;
    const devices = this.#fresh(this.#devices);
    return {
      username: account.username,
      link: link && {
        providerUserId: link.providerUserId,
        login: link.login,
        displayName: link.displayName,
        role: user?.role ?? null,
        access: link.access,
      },
      access: accessState(link, this.store.state().family),
      adminNote: user && adminRoles.has(user.role) ? adminNote : null,
      devices: {
        ...devices,
        value: link && devices.value ? devices.value.filter((d) => ownedBy(d, link)).map(deviceView) : null,
      },
    };
  }

  profiles(): ProfileView[] {
    return this.accounts.accounts().map((account) => this.profile(account));
  }

  /** Logins Tailscale still lists in group:family without a linked account that has access. */
  removing(): string[] {
    const family = this.store.state().family ?? [];
    const kept = new Set(
      this.store
        .links()
        .filter((l) => l.access)
        .map((l) => l.login),
    );
    return family.filter((login) => !kept.has(login));
  }

  /** Links an account to a Tailscale user read fresh from the provider; the client sends only its ID. */
  async link(account: Account, providerUserId: string): Promise<Link> {
    const observation = await this.#observe();
    if (observation === null || !observation.users.ok)
      throw new TailscaleError(502, `Couldn't read Tailscale users, so nothing was linked: ${this.#users.error ?? ""}`);
    const found = observation.users.value.find((u) => u.id === providerUserId);
    if (!found) throw new TailscaleError(404, "That Tailscale user isn't in this tailnet. Refresh and pick again.");
    if (found.type !== "member")
      throw new TailscaleError(409, `${found.loginName} is shared in from another tailnet and can't be linked.`);
    const link = this.store.link(account.username, {
      providerUserId: found.id,
      login: found.loginName,
      displayName: found.displayName,
    });
    this.log.info("tailscale link saved", { username: account.username });
    this.sync();
    return link;
  }

  unlink(account: Account): void {
    if (this.store.unlink(account.username)) {
      this.log.info("tailscale link removed", { username: account.username });
      this.sync();
    }
  }

  setAccess(account: Account, access: boolean): Link {
    const link = this.store.setAccess(account.username, access);
    this.log.info("tailscale access saved", { username: account.username, access });
    this.sync();
    return link;
  }

  /** Turns on managed access; the next sync writes group:family from the links. */
  enable(): void {
    this.store.enable();
    this.log.info("tailscale managed access turned on", {});
    this.sync();
  }

  async #loop(): Promise<void> {
    do {
      this.#again = false;
      let outcome: SyncOutcome;
      try {
        outcome = await this.gateway.sync(this.#abort.signal);
      } catch (error) {
        if (this.#closed) return;
        outcome = { status: "failed", message: error instanceof Error ? error.message : String(error) };
      }
      if (outcome.status === "failed") this.log.warn("tailscale sync failed", { message: outcome.message });
    } while (this.#rerun());
    this.#schedule();
  }

  /** Whether a change arrived during the last sync, which then runs again. */
  #rerun(): boolean {
    return this.#again && !this.#closed;
  }

  #schedule(): void {
    if (this.#closed) return;
    const delay = this.settings.syncIntervalSeconds * 1000;
    this.#nextSyncAt = this.now() + delay;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.sync();
    }, delay);
    this.#timer.unref();
  }

  #clearTimer(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#nextSyncAt = null;
  }

  #observe(): Promise<Observation | null> {
    if (this.#observing) return this.#observing;
    this.#observing = this.gateway
      .observe(this.#abort.signal)
      .then(
        (observation) => {
          const at = this.now();
          this.#users = merge(this.#users, observation.users, at);
          this.#devices = merge(this.#devices, observation.devices, at);
          this.#policy = merge(this.#policy, observation.policy, at);
          this.#server = merge(this.#server, observation.server, at);
          return observation;
        },
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          const failed = <T>(current: Observed<T>): Observed<T> => ({ ...current, error: message });
          this.#users = failed(this.#users);
          this.#devices = failed(this.#devices);
          this.#policy = failed(this.#policy);
          this.#server = failed(this.#server);
          if (!this.#closed) this.log.warn("tailscale observation failed", { message });
          return null;
        },
      )
      .finally(() => {
        this.#observing = null;
      });
    return this.#observing;
  }

  #fresh<T>(current: Observed<T>): Observed<T> {
    const tooOld =
      current.observedAt === null || this.now() - current.observedAt > this.settings.observationMaxAgeSeconds * 1000;
    return { ...current, stale: tooOld || current.error !== null };
  }
}

/** Saved access compared with what Tailscale enforces; before the first read, saved access is not yet confirmed. */
export function accessState(link: Link | null, family: string[] | null): AccessState {
  if (link === null) return "unlinked";
  const listed = family?.includes(link.login) ?? false;
  if (link.access) return listed ? "access" : "giving";
  return listed ? "removing" : "no-access";
}

function merge<T>(current: Observed<T>, section: Section<T>, observedAt: number): Observed<T> {
  return section.ok
    ? { value: section.value, observedAt, stale: false, error: null }
    : { ...current, error: section.error };
}

/** A personal device of the linked user: owned by its login and not a tagged server. */
function ownedBy(device: ProviderDevice, link: Link): boolean {
  return device.tags.length === 0 && device.user === link.login;
}

function deviceView(device: ProviderDevice): DeviceView {
  return {
    id: device.id,
    name: device.name,
    os: device.os,
    lastSeen: device.lastSeen,
    connected: device.connectedToControl,
    expires: device.expires,
    keyExpiryDisabled: device.keyExpiryDisabled,
  };
}

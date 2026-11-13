// The /tailscale page's API. Every route is owner-only, and links and access
// are validated on the server before anything is saved.
import type { Account, Accounts } from "./accounts.js";
import {
  HttpError,
  readBody,
  requireSameOrigin,
  route,
  writeJSON,
  type FeatureModule,
  type RequestContext,
  type Route,
} from "./http.js";
import type { TailscaleOnboarding } from "./onboarding.js";
import type { TailscaleSettings } from "./settings.js";
import type { TailscaleService } from "./tailscale.js";

const providerIdPattern = /^[A-Za-z0-9._:-]{1,128}$/;

export class TailscaleModule implements FeatureModule {
  constructor(
    private readonly accounts: Accounts,
    private readonly tailscale: TailscaleService,
    private readonly onboarding: TailscaleOnboarding,
    private readonly settings: TailscaleSettings,
  ) {}

  routes(): Route[] {
    return [
      route("GET", "/api/tailscale", "owner", (ctx) => this.#overview(ctx)),
      route("POST", "/api/tailscale/refresh", "owner", (ctx) => this.#refresh(ctx)),
      route("POST", "/api/tailscale/sync", "owner", (ctx) => this.#sync(ctx)),
      route("POST", "/api/tailscale/enable", "owner", (ctx) => this.#enable(ctx)),
      route("PUT", "/api/tailscale/profiles/{username}/link", "owner", (ctx) => this.#link(ctx)),
      route("DELETE", "/api/tailscale/profiles/{username}/link", "owner", (ctx) => this.#unlink(ctx)),
      route("PUT", "/api/tailscale/profiles/{username}/access", "owner", (ctx) => this.#access(ctx)),
    ];
  }

  #account(raw: string): Account {
    const account = this.accounts.account(raw.trim().toLowerCase());
    if (!account) throw new HttpError(404, "Account not found");
    return account;
  }

  #payload() {
    const observed = this.tailscale.observed();
    const meta = (o: { observedAt: number | null; stale: boolean; error: string | null }) => ({
      observedAt: o.observedAt,
      stale: o.stale,
      error: o.error,
    });
    const state = this.tailscale.state();
    const linkedWithAccess = new Set(
      this.tailscale.store
        .links()
        .filter((l) => l.access)
        .map((l) => l.login),
    );
    return {
      sync: {
        enabledAt: state.enabledAt,
        syncedAt: state.syncedAt,
        error: state.error,
        familyReadAt: state.familyReadAt,
        syncing: this.tailscale.syncing,
        nextSyncAt: this.tailscale.nextSyncAt,
      },
      observed: {
        users: meta(observed.users),
        devices: meta(observed.devices),
        server: observed.server,
      },
      // Before managed access is on: people Tailscale's policy lists who would lose access.
      wouldLoseAccess:
        state.enabledAt === null
          ? (observed.policy.value?.family.filter((login) => !linkedWithAccess.has(login)) ?? null)
          : [],
      removing: state.enabledAt === null ? [] : this.tailscale.removing(),
      providerUsers: this.tailscale.providerUsers(),
      profiles: this.tailscale
        .profiles()
        .map((profile) => ({ ...profile, onboarding: this.onboarding.status(profile.username) })),
      setup: { downloadUrl: this.settings.downloadUrl, adminUsersUrl: this.settings.adminUsersUrl },
    };
  }

  async #overview({ res }: RequestContext): Promise<void> {
    await this.tailscale.refresh(false);
    writeJSON(res, 200, this.#payload());
  }

  async #refresh({ req, res }: RequestContext): Promise<void> {
    requireSameOrigin(req);
    (await readBody(req)).only();
    await this.tailscale.refresh(true);
    writeJSON(res, 200, this.#payload());
  }

  async #sync({ req, res }: RequestContext): Promise<void> {
    requireSameOrigin(req);
    (await readBody(req)).only();
    this.tailscale.sync();
    writeJSON(res, 202, this.#payload());
  }

  async #enable({ req, res }: RequestContext): Promise<void> {
    requireSameOrigin(req);
    (await readBody(req)).only();
    this.tailscale.enable();
    writeJSON(res, 200, this.#payload());
  }

  async #link({ req, res, params }: RequestContext): Promise<void> {
    requireSameOrigin(req);
    const account = this.#account(params[0] ?? "");
    const providerUserId = (await readBody(req))
      .only("providerUserId")
      .required("providerUserId")
      .string("providerUserId");
    if (providerUserId === null || !providerIdPattern.test(providerUserId))
      throw new HttpError(400, "invalid Tailscale user ID");
    await this.onboarding.advance(account.username, { type: "link", providerUserId });
    writeJSON(res, 200, { profile: this.#profile(account) });
  }

  async #unlink({ req, res, params }: RequestContext): Promise<void> {
    requireSameOrigin(req);
    const account = this.#account(params[0] ?? "");
    await this.onboarding.advance(account.username, { type: "unlink" });
    writeJSON(res, 200, { profile: this.#profile(account) });
  }

  async #access({ req, res, params }: RequestContext): Promise<void> {
    requireSameOrigin(req);
    const account = this.#account(params[0] ?? "");
    const access = (await readBody(req)).only("access").required("access").bool("access");
    if (access === null) throw new HttpError(400, "access must be true or false");
    await this.onboarding.advance(account.username, { type: access ? "grant" : "revoke" });
    writeJSON(res, 200, { profile: this.#profile(account) });
  }

  #profile(account: Account) {
    return { ...this.tailscale.profile(account), onboarding: this.onboarding.status(account.username) };
  }
}

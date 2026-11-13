// The hub's HTTP interface. Every client (the phone apps, a web panel,
// scripts) uses the same endpoints regardless of device brand. Each feature
// module lists its routes; the API resolves the caller once and checks every
// route's requirement through the authorization service before it runs.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Hub } from "./hub.js";
import { JsonShapeError } from "./json.js";
import type { Log } from "./log.js";
import { HealthHttp } from "./health/http.js";
import { HealthError, type HealthStore } from "./health/store.js";
import type { MatterAdmin } from "./matter/nodes.js";
import { serveWeb } from "./web.js";
import type { Organization } from "./organization.js";
import { AccountError, type Accounts } from "./accounts.js";
import { AuthorizationService } from "./authorization.js";
import { decodeParam, HttpError, route, writeError, writeJSON, type RequestContext, type Route } from "./http.js";
import type { Principal } from "./principal.js";
import { UserService } from "./users.js";
import { UsersModule } from "./users-module.js";
import { LightsModule } from "./lights-module.js";
import { DevicesModule } from "./devices-module.js";
import { OrganizationModule } from "./organization-module.js";
import { TailscaleModule } from "./tailscale-module.js";
import { LayoutChanges } from "./layout-changes.js";
import { AccountOnboarding, OnboardingError, TailscaleOnboarding } from "./onboarding.js";
import type { TailscaleService } from "./tailscale.js";
import { settings } from "./settings.js";

export { sessionToken } from "./users.js";

/** Serves the hub API. */
export class Api {
  readonly #authorization = new AuthorizationService();
  readonly #users: UserService;
  readonly #public: Route[];
  readonly #authed: Route[];
  readonly #healthHttp: HealthHttp | undefined;

  /**
   * password must be non-empty; the owner exchanges it for a session token at
   * POST /api/login. Invited accounts sign in with a username and password.
   */
  constructor(
    hub: Hub,
    private readonly matter: MatterAdmin,
    password: string,
    accounts: Accounts,
    private readonly log: Log,
    health?: HealthStore,
    layoutPath?: string,
    organization?: Organization,
    tailscale?: TailscaleService,
  ) {
    // An account's link is deleted with it; the sync then removes its access.
    this.#users = new UserService(accounts, password, () => tailscale?.sync());
    this.#healthHttp = health
      ? new HealthHttp(health, log.with({ component: "device-health" }), matter, hub, organization)
      : undefined;
    const layout = new LayoutChanges(hub, log);
    const users = new UsersModule(this.#users, new AccountOnboarding(this.#users), log);
    const modules = [
      users,
      new LightsModule(hub, log),
      new DevicesModule(hub, matter, layout, log, layoutPath, organization),
      new OrganizationModule(hub, matter, layout, log, health, layoutPath, organization),
      ...(tailscale
        ? [new TailscaleModule(accounts, tailscale, new TailscaleOnboarding(accounts, tailscale), settings.tailscale)]
        : []),
    ];
    this.#public = [route("GET", "/healthz", null, (ctx) => this.#health(ctx)), ...users.publicRoutes()];
    this.#authed = modules.flatMap((module) => module.routes());
  }

  /** Handles one request; pass it to http.createServer. Everything under /api/ except login needs auth. */
  readonly handle = (req: IncomingMessage, res: ServerResponse): void => {
    const gone = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) {
        gone.abort();
      }
    });
    this.#dispatch(req, res, gone.signal).catch((err: unknown) => {
      if (
        err instanceof HttpError ||
        err instanceof HealthError ||
        err instanceof AccountError ||
        err instanceof OnboardingError
      ) {
        if (err instanceof HealthError && err.status === 429) res.setHeader("Retry-After", "15");
        writeError(res, err.status, err.message);
        return;
      }
      if (err instanceof JsonShapeError) {
        writeError(res, 400, `bad request body: ${err.message}`);
        return;
      }
      this.log.error("request failed", { method: req.method, path: req.url, err });
      writeError(res, 500, err instanceof Error ? err.message : String(err));
    });
  };

  async #dispatch(req: IncomingMessage, res: ServerResponse, signal: AbortSignal): Promise<void> {
    const path = new URL(req.url ?? "/", "http://hub").pathname;
    if (serveWeb(req, res)) return;
    const principal = this.#users.resolve(req);
    if (await this.#healthHttp?.handle(req, res, this.#authorization.access(principal, "devices"))) return;
    if (await this.#serve(this.#public, req, res, path, signal, false, principal)) {
      return;
    }
    if (!path.startsWith("/api/")) {
      throw new HttpError(404, "not found");
    }
    if (principal === null) {
      throw new HttpError(401, "sign in first");
    }
    if (!(await this.#serve(this.#authed, req, res, path, signal, true, principal))) {
      throw new HttpError(404, "not found");
    }
  }

  /**
   * Runs the matching route once the principal meets its requirement. A path
   * served under another method is a 405 when strict.
   */
  async #serve(
    routes: Route[],
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    signal: AbortSignal,
    strict: boolean,
    principal: Principal | null,
  ): Promise<boolean> {
    let pathMatched = false;
    for (const r of routes) {
      const m = r.pattern.exec(path);
      if (!m) {
        continue;
      }
      pathMatched = true;
      if (r.method === req.method) {
        this.#authorization.require(principal, r.requires);
        await r.handler({ req, res, params: m.slice(1).map(decodeParam), signal, principal });
        return true;
      }
    }
    if (strict && pathMatched) {
      throw new HttpError(405, "method not allowed");
    }
    return false;
  }

  async #health({ res }: RequestContext): Promise<void> {
    writeJSON(res, 200, { ok: true, matterConnected: this.matter.ready });
    return Promise.resolve();
  }
}

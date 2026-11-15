// The hub's HTTP interface. Every client (the phone apps, a web panel,
// scripts) uses the same endpoints regardless of device brand. Each feature
// module lists its routes; the API resolves the caller once and checks every
// route's requirement through the authorization service before it runs.
import type { IncomingMessage, ServerResponse } from "node:http";
import { JsonShapeError } from "./json.js";
import type { Log } from "./log.js";
import type { HealthHttp } from "./health/http.js";
import { HealthError } from "./health/store.js";
import type { MatterAdmin } from "./matter/nodes.js";
import { serveWeb } from "./web.js";
import { AccountError } from "./accounts.js";
import { AuthorizationService } from "./authorization.js";
import {
  HttpError,
  route,
  serveRoutes,
  writeError,
  writeJSON,
  type FeatureModule,
  type RequestContext,
  type Route,
} from "./http.js";
import { OnboardingError } from "./onboarding.js";
import { SecretsError } from "./secrets.js";
import type { UserService } from "./users.js";

export { sessionToken } from "./users.js";

/** What the API serves; the caller builds each part. */
export interface ApiParts {
  /** Resolves the caller of each request. */
  users: UserService;
  /** Routes that need no session, such as signing in. */
  publicRoutes: Route[];
  /** Feature modules; their routes need a session and each route's own requirement. */
  modules: FeatureModule[];
  /** Device health and device pings, or null when the hub keeps no health store. */
  health: HealthHttp | null;
  /** Whether Matter is connected, reported at /healthz. */
  matter: Pick<MatterAdmin, "ready">;
  log: Log;
}

/** Serves the hub API. */
export class Api {
  readonly #authorization = new AuthorizationService();
  readonly #users: UserService;
  readonly #public: Route[];
  readonly #authed: Route[];
  readonly #healthHttp: HealthHttp | null;
  readonly #matter: Pick<MatterAdmin, "ready">;
  readonly #log: Log;

  constructor(parts: ApiParts) {
    this.#users = parts.users;
    this.#healthHttp = parts.health;
    this.#matter = parts.matter;
    this.#log = parts.log;
    this.#public = [route("GET", "/healthz", null, (ctx) => this.#health(ctx)), ...parts.publicRoutes];
    this.#authed = parts.modules.flatMap((module) => module.routes());
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
        err instanceof OnboardingError ||
        err instanceof SecretsError
      ) {
        if (err instanceof HealthError && err.status === 429) res.setHeader("Retry-After", "15");
        writeError(res, err.status, err.message);
        return;
      }
      if (err instanceof JsonShapeError) {
        writeError(res, 400, `bad request body: ${err.message}`);
        return;
      }
      this.#log.error("request failed", { method: req.method, path: req.url, err });
      writeError(res, 500, err instanceof Error ? err.message : String(err));
    });
  };

  async #dispatch(req: IncomingMessage, res: ServerResponse, signal: AbortSignal): Promise<void> {
    const path = new URL(req.url ?? "/", "http://hub").pathname;
    if (serveWeb(req, res)) return;
    const principal = this.#users.resolve(req);
    if (
      await this.#healthHttp?.handle(req, res, this.#authorization.access(principal, "devices"), () =>
        this.#authorization.access(this.#users.resolve(req), "devices"),
      )
    )
      return;
    const request = { req, res, path, signal, principal };
    if (await serveRoutes(this.#public, this.#authorization, request, false)) {
      return;
    }
    if (!path.startsWith("/api/")) {
      throw new HttpError(404, "not found");
    }
    if (principal === null) {
      throw new HttpError(401, "sign in first");
    }
    if (!(await serveRoutes(this.#authed, this.#authorization, request, true))) {
      throw new HttpError(404, "not found");
    }
  }

  async #health({ res }: RequestContext): Promise<void> {
    writeJSON(res, 200, { ok: true, matterConnected: this.#matter.ready });
    return Promise.resolve();
  }
}

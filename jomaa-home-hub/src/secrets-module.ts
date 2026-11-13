// The Secrets page's API: environment files and redeploying. Owner-only; each
// change also needs the hub password, checked under the owner sign-in limit.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { EnvChange } from "./envfile.js";
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
import { Fields } from "./json.js";
import { clientIP, type LoginLimiter } from "./limiter.js";
import type { Log } from "./log.js";
import type { DeployWorkflow, GitHubCli } from "./redeploy.js";
import type { EnvFiles } from "./secrets.js";
import { settings } from "./settings.js";
import type { UserService } from "./users.js";

/** What the Secrets page edits and reruns. */
export interface SecretsAdmin {
  files: EnvFiles;
  workflow: DeployWorkflow;
  /** The source of the token that reruns the workflow. */
  cli: GitHubCli;
}

export class SecretsModule implements FeatureModule {
  constructor(
    private readonly users: UserService,
    private readonly ownerLimiter: LoginLimiter,
    private readonly log: Log,
    private readonly secrets?: SecretsAdmin,
  ) {}

  routes(): Route[] {
    return [
      route("GET", "/api/secrets", "owner", (ctx) => this.#secretsList(ctx)),
      route("PUT", "/api/secrets", "owner", (ctx) => this.#secretsSave(ctx)),
      route("POST", "/api/secrets/reveal", "owner", (ctx) => this.#secretsReveal(ctx)),
      route("POST", "/api/secrets/redeploy", "owner", (ctx) => this.#redeploy(ctx)),
      route("GET", "/api/secrets/redeploy/{runId}", "owner", (ctx) => this.#redeployStatus(ctx)),
    ];
  }

  #secretsAdmin(): SecretsAdmin {
    if (!this.secrets) throw new HttpError(503, "Secrets are unavailable");
    return this.secrets;
  }

  /**
   * Checks the hub password sent with a Secrets request, in constant time and
   * under the owner sign-in rate limit.
   */
  #confirmOwner(req: IncomingMessage, res: ServerResponse, password: string): void {
    const client = clientIP(req);
    const { ok, waitMs } = this.ownerLimiter.allow(client);
    if (!ok) {
      res.setHeader("Retry-After", String(Math.trunc(waitMs / 1000) + 1));
      throw new HttpError(429, "too many wrong passwords; try again later");
    }
    if (this.users.ownerSignIn(password) === null) {
      this.ownerLimiter.fail(client);
      this.log.warn("wrong hub password on the Secrets page", { client });
      throw new HttpError(403, "wrong password");
    }
    this.ownerLimiter.succeed(client);
  }

  async #secretsList({ res }: RequestContext): Promise<void> {
    const { files, cli } = this.#secretsAdmin();
    const [listed, token] = await Promise.all([files.list(), cli.token()]);
    writeJSON(res, 200, {
      files: listed,
      redeploy: {
        available: "token" in token,
        unavailable: "unavailable" in token ? token.unavailable : null,
        pollSeconds: settings.secrets.redeployPollSeconds,
      },
    });
  }

  async #secretsReveal({ req, res }: RequestContext): Promise<void> {
    requireSameOrigin(req);
    const { files } = this.#secretsAdmin();
    const body = (await readBody(req)).only("file", "key", "password").required("file", "key", "password");
    this.#confirmOwner(req, res, body.string("password") ?? "");
    const file = body.string("file") ?? "";
    const key = body.string("key") ?? "";
    const value = await files.reveal(file, key);
    this.log.info("secret revealed", { file, key });
    writeJSON(res, 200, { value });
  }

  async #secretsSave({ req, res }: RequestContext): Promise<void> {
    requireSameOrigin(req);
    const { files } = this.#secretsAdmin();
    const body = (await readBody(req)).only("file", "changes", "password").required("file", "changes", "password");
    if (!Array.isArray(body.value("changes"))) throw new HttpError(400, "changes must be a list");
    const changes = body.list("changes").map((item, index): EnvChange => {
      const change = new Fields(item, `changes[${index}]`).only("key", "value", "delete").required("key");
      const key = change.string("key") ?? "";
      if (change.has("delete")) {
        if (change.bool("delete") !== true || change.has("value"))
          throw new HttpError(400, `changes[${index}] must be {key, value} or {key, delete: true}`);
        return { key, delete: true };
      }
      const value = change.required("value").string("value");
      if (value === null) throw new HttpError(400, `changes[${index}] value must be a string`);
      return { key, value };
    });
    this.#confirmOwner(req, res, body.string("password") ?? "");
    const file = body.string("file") ?? "";
    await files.save(file, changes);
    this.log.info("secrets saved", { file, keys: changes.map((change) => change.key) });
    writeJSON(res, 200, { files: await files.list() });
  }

  async #redeployToken(): Promise<{ token: string; workflow: DeployWorkflow }> {
    const { cli, workflow } = this.#secretsAdmin();
    const token = await cli.token();
    if ("unavailable" in token) {
      this.log.warn("redeploy unavailable", { reason: token.unavailable });
      throw new HttpError(409, `redeploy is unavailable: ${token.unavailable}`);
    }
    return { token: token.token, workflow };
  }

  async #redeploy({ req, res }: RequestContext): Promise<void> {
    requireSameOrigin(req);
    const body = (await readBody(req)).only("password").required("password");
    this.#confirmOwner(req, res, body.string("password") ?? "");
    const { token, workflow } = await this.#redeployToken();
    const run = await workflow.rerunLatest(token);
    this.log.info("redeploy requested", { run: run.id, attempt: run.attempt });
    writeJSON(res, 202, run);
  }

  async #redeployStatus({ res, params }: RequestContext): Promise<void> {
    const raw = params[0] ?? "";
    const id = Number(raw);
    if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(id)) throw new HttpError(400, "invalid run ID");
    const { token, workflow } = await this.#redeployToken();
    writeJSON(res, 200, await workflow.run(token, id));
  }
}

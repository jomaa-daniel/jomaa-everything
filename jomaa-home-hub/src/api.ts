// The hub's HTTP interface. Every client (the phone apps, a web panel,
// scripts) uses the same endpoints regardless of device brand.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { InvalidCommandError, noChange, RGB, type Command } from "./device.js";
import { NotFoundError, type Desired, type Hub } from "./hub.js";
import { Fields, JsonShapeError, parseJson } from "./json.js";
import { clientIP, isHTTPS, LoginLimiter } from "./limiter.js";
import type { Log } from "./log.js";
import { HealthHttp } from "./health/http.js";
import { HealthError, type HealthStore } from "./health/store.js";
import { MatterError, MatterNotReadyError, type MatterAdmin } from "./matter/nodes.js";
import { serveWeb } from "./web.js";
import { assignMatterGroup, editLayout } from "./group-assignment.js";
import { OrganizationError, type Organization } from "./organization.js";
import type { EnvChange } from "./envfile.js";
import { SecretsError, tokenKey, type EnvFiles } from "./secrets.js";
import type { DeployWorkflow } from "./redeploy.js";
import { settings } from "./settings.js";
import {
  AccountError,
  isScope,
  passwordLength,
  refusal,
  scopes,
  sessionLifetimeMs,
  type Access,
  type Account,
  type Accounts,
  type Scope,
} from "./accounts.js";

const authCookie = "hub_auth";
const commandTimeoutMs = 15_000;
const pairingTimeoutMs = 5 * 60_000;
const maxBodyBytes = 64 << 10;

/** A request the API refuses with a status and message. */
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The session token is derived from the password, so the password itself is
 * never stored in a cookie and changing it signs everyone out.
 */
export function sessionToken(password: string): string {
  return createHmac("sha256", password).update("jomaa-home-hub session v1").digest("hex");
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

type Handler = (ctx: RequestContext) => Promise<void>;

/** Who sent a request: the owner signed in with the hub password, or an invited account. */
type Principal = { kind: "owner" } | { kind: "account"; account: Account };

/**
 * What a route needs: a scope, the owner, or nothing beyond what its route
 * list needs (public routes need nothing; authed routes need a session).
 */
type Requirement = Scope | "owner" | null;

/** What the Secrets page edits and reruns. */
export interface SecretsAdmin {
  files: EnvFiles;
  workflow: DeployWorkflow;
}

interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  params: string[];
  /** Aborted when the client goes away. */
  signal: AbortSignal;
  principal: Principal | null;
}

interface Route {
  method: string;
  pattern: RegExp;
  handler: Handler;
  requires: Requirement;
}

function access(principal: Principal | null, requires: Requirement): Access {
  if (requires === null) return "allowed";
  if (principal === null) return "signed-out";
  if (principal.kind === "owner") return "allowed";
  return requires !== "owner" && principal.account.scopes.includes(requires) ? "allowed" : "forbidden";
}

function requireAccess(principal: Principal | null, requires: Requirement): void {
  const result = access(principal, requires);
  if (result === "allowed" || requires === null) return;
  if (result === "signed-out") throw new HttpError(401, "sign in first");
  if (requires === "owner") throw new HttpError(403, "Only the hub owner can manage accounts and invites");
  throw new HttpError(403, refusal(requires));
}

/** Serves the hub API. */
export class Api {
  readonly #token: string;
  /** Counts failed owner and account sign-ins separately. */
  readonly #ownerLimiter = new LoginLimiter();
  readonly #accountLimiter = new LoginLimiter();
  readonly #public: Route[];
  readonly #authed: Route[];
  readonly #healthHttp: HealthHttp | undefined;
  #groupChange: Promise<void> = Promise.resolve();

  /**
   * password must be non-empty; the owner exchanges it for a session token at
   * POST /api/login. Invited accounts sign in with a username and password.
   */
  constructor(
    private readonly hub: Hub,
    private readonly matter: MatterAdmin,
    password: string,
    private readonly accounts: Accounts,
    private readonly log: Log,
    private readonly health?: HealthStore,
    private readonly layoutPath?: string,
    private readonly organization?: Organization,
    private readonly secrets?: SecretsAdmin,
  ) {
    this.#token = sessionToken(password);
    this.#healthHttp = health
      ? new HealthHttp(health, log.with({ component: "device-health" }), matter, hub, organization)
      : undefined;
    const route = (method: string, path: string, requires: Requirement, handler: Handler): Route => ({
      method,
      pattern: new RegExp("^" + path.replace(/\{\w+\}/g, "([^/]+)") + "$"),
      handler: handler.bind(this),
      requires,
    });
    this.#public = [
      route("GET", "/healthz", null, this.#health),
      route("POST", "/api/login", null, this.#login),
      route("POST", "/api/logout", null, this.#logout),
      route("POST", "/api/invites/check", null, this.#inviteCheck),
      route("POST", "/api/join", null, this.#join),
    ];
    this.#authed = [
      route("GET", "/api/session", null, this.#session),
      route("GET", "/api/invites", "owner", this.#inviteList),
      route("POST", "/api/invites", "owner", this.#inviteCreate),
      route("DELETE", "/api/invites/{id}", "owner", this.#inviteRevoke),
      route("GET", "/api/accounts", "owner", this.#accountList),
      route("PUT", "/api/accounts/{username}/scopes", "owner", this.#accountScopes),
      route("DELETE", "/api/accounts/{username}", "owner", this.#accountDelete),
      route("GET", "/api/secrets", "owner", this.#secretsList),
      route("PUT", "/api/secrets", "owner", this.#secretsSave),
      route("POST", "/api/secrets/reveal", "owner", this.#secretsReveal),
      route("POST", "/api/secrets/redeploy", "owner", this.#redeploy),
      route("GET", "/api/secrets/redeploy/{runId}", "owner", this.#redeployStatus),
      route("GET", "/api/targets", "lights", this.#listTargets),
      route("GET", "/api/manage", "manage", this.#manageRead),
      route("POST", "/api/manage", "manage", this.#manageWrite),
      route("GET", "/api/targets/{id}/state", "lights", this.#targetState),
      route("POST", "/api/targets/{id}/command", "lights", this.#command),
      route("POST", "/api/targets/{id}/sync", "lights", this.#sync),
      route("GET", "/api/matter/nodes", "devices", this.#matterNodes),
      route("GET", "/api/matter/discover", "devices", this.#matterDiscover),
      route("POST", "/api/matter/register", "devices", this.#matterRegister),
      route("PATCH", "/api/matter/nodes/{nodeId}/name", "devices", this.#matterRename),
      route("PATCH", "/api/matter/nodes/{nodeId}/group", "devices", this.#matterGroup),
      route("DELETE", "/api/matter/nodes/{nodeId}", "devices", this.#matterRemove),
      route("POST", "/api/matter/commission", "devices", this.#matterCommission),
      route("POST", "/api/matter/wifi", "devices", this.#matterWiFi),
      route("POST", "/api/matter/thread", "devices", this.#matterThread),
    ];
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
      this.log.error("request failed", { method: req.method, path: req.url, err });
      writeError(res, 500, err instanceof Error ? err.message : String(err));
    });
  };

  async #dispatch(req: IncomingMessage, res: ServerResponse, signal: AbortSignal): Promise<void> {
    const path = new URL(req.url ?? "/", "http://hub").pathname;
    if (serveWeb(req, res)) return;
    const principal = this.#principal(req);
    if (await this.#healthHttp?.handle(req, res, access(principal, "devices"))) return;
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
        requireAccess(principal, r.requires);
        await r.handler({ req, res, params: m.slice(1).map(decodeParam), signal, principal });
        return true;
      }
    }
    if (strict && pathMatched) {
      throw new HttpError(405, "method not allowed");
    }
    return false;
  }

  #principal(req: IncomingMessage): Principal | null {
    const token = requestToken(req);
    if (token === "") return null;
    if (sameSecret(token, this.#token)) return { kind: "owner" };
    const account = this.accounts.session(token);
    return account ? { kind: "account", account } : null;
  }

  async #health({ res }: RequestContext): Promise<void> {
    writeJSON(res, 200, { ok: true, matterConnected: this.matter.ready });
    return Promise.resolve();
  }

  /**
   * Without a username the password is the hub password; with one it is that
   * account's password. A previous account session on the request ends.
   */
  async #login({ req, res }: RequestContext): Promise<void> {
    requireSameOrigin(req);
    const body = (await readBody(req)).only("username", "password");
    const username = body.string("username");
    const password = body.string("password") ?? "";
    const client = clientIP(req);
    const limiter = username === null ? this.#ownerLimiter : this.#accountLimiter;
    const { ok, waitMs } = limiter.allow(client);
    if (!ok) {
      res.setHeader("Retry-After", String(Math.trunc(waitMs / 1000) + 1));
      throw new HttpError(429, "too many failed sign-ins; try again later");
    }
    let token: string | null = null;
    if (username === null) {
      if (sameSecret(sessionToken(password), this.#token)) token = this.#token;
    } else {
      const account = await this.accounts.verify(username, password);
      if (account) token = this.accounts.createSession(account.username);
    }
    if (token === null) {
      limiter.fail(client);
      this.log.warn("failed sign-in", { client, account: username !== null });
      throw new HttpError(401, username === null ? "wrong password" : "wrong username or password");
    }
    limiter.succeed(client);
    this.#endAccountSession(req);
    signIn(req, res, token);
    writeJSON(res, 200, { token });
  }

  async #logout({ req, res }: RequestContext): Promise<void> {
    requireSameOrigin(req);
    this.#endAccountSession(req);
    res.setHeader("Set-Cookie", cookie("", 0, isHTTPS(req)));
    writeJSON(res, 200, { ok: true });
    return Promise.resolve();
  }

  #endAccountSession(req: IncomingMessage): void {
    const token = requestToken(req);
    if (token !== "" && !sameSecret(token, this.#token)) this.accounts.endSession(token);
  }

  async #session({ res, principal }: RequestContext): Promise<void> {
    if (principal === null) throw new HttpError(401, "sign in first");
    writeJSON(
      res,
      200,
      principal.kind === "owner"
        ? { owner: true, username: null, scopes: scopes.map((scope) => scope.id) }
        : { owner: false, username: principal.account.username, scopes: principal.account.scopes },
    );
    return Promise.resolve();
  }

  async #inviteCheck({ req, res }: RequestContext): Promise<void> {
    const token = (await readBody(req)).only("token").string("token") ?? "";
    writeJSON(res, 200, { expiresAt: this.accounts.checkInvite(token).expiresAt, passwordLength });
  }

  /** Creates an account from an invite; the caller's session is unchanged. */
  async #join({ req, res }: RequestContext): Promise<void> {
    requireSameOrigin(req);
    const body = (await readBody(req)).only("token", "username", "password");
    const account = await this.accounts.join(
      body.string("token") ?? "",
      body.string("username") ?? "",
      body.string("password") ?? "",
    );
    this.log.info("account created", { username: account.username });
    writeJSON(res, 201, { account });
  }

  async #inviteList({ res }: RequestContext): Promise<void> {
    writeJSON(res, 200, { invites: this.accounts.invites() });
    return Promise.resolve();
  }

  /** Returns the invite's token once; the page turns it into a share link. */
  async #inviteCreate({ req, res }: RequestContext): Promise<void> {
    requireSameOrigin(req);
    (await readBody(req)).only();
    writeJSON(res, 201, this.accounts.createInvite());
  }

  async #inviteRevoke({ req, res, params }: RequestContext): Promise<void> {
    requireSameOrigin(req);
    this.accounts.revokeInvite(params[0] ?? "");
    writeJSON(res, 200, { ok: true });
    return Promise.resolve();
  }

  async #accountList({ res }: RequestContext): Promise<void> {
    writeJSON(res, 200, { accounts: this.accounts.accounts(), scopes });
    return Promise.resolve();
  }

  async #accountScopes({ req, res, params }: RequestContext): Promise<void> {
    requireSameOrigin(req);
    const body = (await readBody(req)).only("scopes").required("scopes");
    if (!Array.isArray(body.value("scopes"))) throw new HttpError(400, "scopes must be a list");
    const granted = body.list("scopes").map((value) => {
      if (!isScope(value)) throw new HttpError(400, `unknown scope ${JSON.stringify(value)}`);
      return value;
    });
    const account = this.accounts.setScopes(params[0] ?? "", granted);
    this.log.info("account scopes changed", { username: account.username, scopes: account.scopes });
    writeJSON(res, 200, { account });
  }

  async #accountDelete({ req, res, params }: RequestContext): Promise<void> {
    requireSameOrigin(req);
    const username = params[0] ?? "";
    this.accounts.deleteAccount(username);
    this.log.info("account deleted", { username });
    writeJSON(res, 200, { ok: true });
    return Promise.resolve();
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
    const { ok, waitMs } = this.#ownerLimiter.allow(client);
    if (!ok) {
      res.setHeader("Retry-After", String(Math.trunc(waitMs / 1000) + 1));
      throw new HttpError(429, "too many wrong passwords; try again later");
    }
    if (!sameSecret(sessionToken(password), this.#token)) {
      this.#ownerLimiter.fail(client);
      this.log.warn("wrong hub password on the Secrets page", { client });
      throw new HttpError(403, "wrong password");
    }
    this.#ownerLimiter.succeed(client);
  }

  async #secretsList({ res }: RequestContext): Promise<void> {
    const { files } = this.#secretsAdmin();
    writeJSON(res, 200, {
      files: await files.list(),
      redeploy: {
        available: (await files.token()) !== null,
        tokenFile: files.tokenFile,
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
    const { files, workflow } = this.#secretsAdmin();
    const token = await files.token();
    if (token === null) throw new HttpError(409, `${tokenKey} is not set in ${files.tokenFile}`);
    return { token, workflow };
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

  async #listTargets({ res }: RequestContext): Promise<void> {
    writeJSON(res, 200, { targets: this.hub.list() });
    return Promise.resolve();
  }

  #managementDevices() {
    const organization = this.organization;
    const targets = this.hub.list();
    const lights = targets
      .filter((target) => target.kind === "govee")
      .map((target) => ({
        key: `target:${target.id}`,
        name: target.name,
        source: "govee",
        reportedType: "Light",
        capabilities: [
          "Power",
          ...(target.features.brightness ? ["Brightness"] : []),
          ...(target.features.color ? ["Color"] : []),
          ...(target.features.colorTemperature ? ["White temperature"] : []),
        ],
        typeId: organization?.assignedType(`target:${target.id}`)?.id ?? null,
        groupIds: this.hub.directGroupsForTarget(target.id),
      }));
    const nodes = (this.matter.ready ? this.matter.nodes() : []).map((node) => ({
      key: `matter:${node.nodeId}`,
      name: node.label || node.product || `Matter device ${node.nodeId}`,
      source: "matter",
      reportedType: node.type,
      capabilities: node.capabilities,
      typeId: organization?.assignedType(`matter:${node.nodeId}`)?.id ?? null,
      groupIds: node.lightEndpoints.length
        ? this.hub.directGroupsForMatter(node.nodeId)
        : (organization?.groups(`matter:${node.nodeId}`) ?? []),
    }));
    const reporters = (this.health?.list() ?? []).map((device) => ({
      key: `health:${device.id}`,
      name: device.name,
      source: "health",
      reportedType: "Health reporter",
      capabilities: ["Health reporting"],
      typeId: organization?.assignedType(`health:${device.id}`)?.id ?? null,
      groupIds: organization?.groups(`health:${device.id}`) ?? [],
    }));
    return [...lights, ...nodes, ...reporters];
  }

  async #manageRead({ res }: RequestContext): Promise<void> {
    if (!this.organization) throw new HttpError(503, "Management is unavailable");
    writeJSON(res, 200, {
      types: this.organization.types(),
      matterConnected: this.matter.ready,
      groups: this.hub.list().filter((target) => target.kind === "room"),
      devices: this.#managementDevices(),
    });
    return Promise.resolve();
  }

  async #manageWrite({ req, res }: RequestContext): Promise<void> {
    requireSameOrigin(req);
    const organization = this.organization;
    const path = this.layoutPath;
    if (!organization || !path) throw new HttpError(503, "Management is unavailable");
    const fields = await readBody(req);
    const change = this.#groupChange.then(async () => {
      await this.#manageAction(fields, organization, path);
    });
    this.#groupChange = change.catch(() => {});
    await change;
    writeJSON(res, 200, { ok: true });
  }

  async #manageAction(fields: Fields, organization: Organization, path: string): Promise<void> {
    const action = fields.string("action") ?? "";
    try {
      if (action === "type.create") organization.createType(fields.only("action", "name").string("name") ?? "");
      else if (action === "type.rename")
        organization.renameType(fields.only("action", "id", "name").string("id") ?? "", fields.string("name") ?? "");
      else if (action === "type.delete") organization.deleteType(fields.only("action", "id").string("id") ?? "");
      else if (["group.create", "group.rename", "group.delete"].includes(action)) {
        fields.only("action", "id", "name");
        const id = fields.string("id");
        const name = (fields.string("name") ?? "").trim();
        if (action !== "group.delete" && (!name || name.length > 80))
          throw new HttpError(400, "Name must contain 1 to 80 characters");
        await this.#applyLayout(path, { action, id, name });
        if (action === "group.delete" && id) organization.removeGroup(id);
      } else if (action === "device.assign") {
        fields.only("action", "key", "typeId", "groupIds").required("key");
        if (!fields.has("typeId") && !fields.has("groupIds"))
          throw new HttpError(400, "No assignment changes supplied");
        const key = fields.string("key") ?? "";
        const device = this.#managementDevices().find((device) => device.key === key);
        if (!device) throw new HttpError(400, "Device not found");
        const typeId = fields.string("typeId");
        if (fields.has("groupIds") && !Array.isArray(fields.value("groupIds")))
          throw new HttpError(400, "groupIds must be a list");
        if (fields.has("typeId") && typeId !== null && !organization.types().some((type) => type.id === typeId))
          throw new HttpError(400, "Type not found");
        const groupIds = fields.list("groupIds").map((value) => {
          if (typeof value !== "string") throw new HttpError(400, "Invalid group");
          return value;
        });
        const available = this.hub
          .list()
          .filter((target) => target.kind === "room")
          .map((group) => group.id);
        if (groupIds.some((id) => !available.includes(id))) throw new HttpError(400, "Group not found");
        const node =
          device.source === "matter" ? this.matter.nodes().find((node) => `matter:${node.nodeId}` === key) : undefined;
        if (fields.has("groupIds") && (device.source === "govee" || node?.lightEndpoints.length)) {
          await this.#applyLayout(path, {
            action: "assign",
            nodeId: node?.nodeId ?? null,
            endpoints: node?.lightEndpoints ?? [],
            name: device.name,
            groupIds,
            targetIds: device.source === "govee" ? [key.slice(7)] : [],
          });
        } else if (fields.has("groupIds")) organization.assignGroups(key, groupIds);
        if (fields.has("typeId")) organization.assign(key, typeId);
      } else throw new HttpError(400, "Unknown management action");
    } catch (error) {
      if (error instanceof JsonShapeError || error instanceof HttpError) throw error;
      if (error instanceof OrganizationError) throw new HttpError(400, error.message);
      this.log.error("management update failed", { action, error });
      throw new HttpError(500, "Management update failed. Refresh and try again.");
    }
  }

  async #applyLayout(path: string, operation: Record<string, unknown>): Promise<void> {
    try {
      this.hub.reload(await editLayout(path, operation));
    } catch (error) {
      this.log.warn("layout update failed", { operation: operation["action"], error });
      throw new HttpError(409, "Group changes could not be saved. Refresh and try again.");
    }
  }

  async #targetState({ res, params, signal }: RequestContext): Promise<void> {
    const result = await this.#hubCall(() => this.hub.state(params[0] ?? "", withTimeout(signal, commandTimeoutMs)));
    writeJSON(res, 200, result);
  }

  /**
   * Answers 200 with the devices that didn't take the command, by id; the map
   * is empty when every device took it.
   */
  async #command({ req, res, params, signal }: RequestContext): Promise<void> {
    const body = (await readBody(req)).only("on", "brightness", "colorTemperaturePct", "color", "clientId", "revision");
    const color = body.string("color");
    const id = params[0] ?? "";
    const failed = await this.#hubCall(() => {
      const cmd: Command = {
        ...noChange,
        on: body.bool("on"),
        brightness: body.int("brightness"),
        colorTemperaturePct: body.int("colorTemperaturePct"),
        color: color === null ? null : RGB.parse(color),
      };
      return this.hub.command(
        id,
        cmd,
        body.string("clientId") ?? "",
        body.int("revision"),
        withTimeout(signal, commandTimeoutMs),
      );
    });
    if (Object.keys(failed).length > 0) this.log.warn("command partly failed", { target: id, failed });
    writeJSON(res, 200, { failed });
  }

  async #sync({ req, res, params, signal }: RequestContext): Promise<void> {
    const body = (await readBody(req)).only("clientId", "revision", "on", "brightness", "colorTemperaturePct");
    const want: Desired = {
      clientId: body.string("clientId") ?? "",
      revision: body.int("revision"),
      on: body.bool("on"),
      brightness: body.int("brightness"),
      colorTemperaturePct: body.int("colorTemperaturePct"),
    };
    const result = await this.#hubCall(() =>
      this.hub.sync(params[0] ?? "", want, withTimeout(signal, commandTimeoutMs)),
    );
    writeJSON(res, 200, result);
  }

  async #matterNodes({ res }: RequestContext): Promise<void> {
    const nodes = await this.#matterCall(() => Promise.resolve(this.matter.nodes()));
    writeJSON(res, 200, { nodes });
  }

  async #matterDiscover({ res, signal }: RequestContext): Promise<void> {
    const devices = await this.#matterCall(() => this.matter.discover(withTimeout(signal, commandTimeoutMs)));
    writeJSON(res, 200, { devices });
  }

  async #matterRegister({ req, res, signal }: RequestContext): Promise<void> {
    requireSameOrigin(req);
    const body = (await readBody(req)).only("code", "instanceName");
    const raw = (body.string("code") ?? "").trim();
    const code = raw.startsWith("MT:") ? raw : raw.replace(/[\s-]/g, "");
    const instanceName = body.string("instanceName") ?? "";
    if (code === "" || instanceName === "") throw new HttpError(400, "setup code and selected device are required");
    if (!code.startsWith("MT:") && !/^(?:\d{11}|\d{21})$/.test(code)) {
      throw new HttpError(400, "use an 11- or 21-digit Matter setup code or an MT: QR payload");
    }
    try {
      const node = await this.#matterCall(() =>
        this.matter.register(code, instanceName, withTimeout(signal, pairingTimeoutMs)),
      );
      writeJSON(res, 201, { node });
    } catch (err) {
      if (err instanceof HttpError) {
        throw new HttpError(err.status, err.message.replaceAll(code, "[redacted]").replaceAll(raw, "[redacted]"));
      }
      throw new HttpError(500, "Matter registration failed. Refresh the inventory before trying again.");
    }
  }

  async #matterRename({ req, res, params }: RequestContext): Promise<void> {
    requireSameOrigin(req);
    const raw = params[0] ?? "";
    const nodeId = Number(raw);
    if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(nodeId)) throw new HttpError(400, "invalid Matter node ID");
    const name = ((await readBody(req)).only("name").string("name") ?? "").trim();
    if (name.length < 1 || name.length > 80) throw new HttpError(400, "name must contain 1 to 80 characters");
    const node = await this.#matterCall(async () => {
      if (!this.matter.nodes().some((candidate) => candidate.nodeId === nodeId))
        throw new HttpError(404, "Matter node not found");
      return this.matter.rename(nodeId, name);
    });
    writeJSON(res, 200, { node });
  }

  async #matterGroup({ req, res, params }: RequestContext): Promise<void> {
    requireSameOrigin(req);
    if (this.layoutPath === undefined) throw new HttpError(503, "group editing is unavailable");
    const raw = params[0] ?? "";
    const nodeId = Number(raw);
    if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(nodeId)) throw new HttpError(400, "invalid Matter node ID");
    const groupId = (await readBody(req)).only("groupId").required("groupId").string("groupId");
    if (groupId !== null && !this.hub.list().some((target) => target.kind === "room" && target.id === groupId)) {
      throw new HttpError(400, "selected group does not exist");
    }
    const node = await this.#matterCall(() => {
      const value = this.matter.nodes().find((candidate) => candidate.nodeId === nodeId);
      if (!value) throw new HttpError(404, "Matter node not found");
      return Promise.resolve(value);
    });
    const path = this.layoutPath;
    if (groupId !== null && !node.lightEndpoints.length)
      throw new HttpError(400, "this device has no light or plug endpoints");
    const change = this.#groupChange.then(async () => {
      const config = await assignMatterGroup(path, node, groupId);
      this.hub.reload(config);
    });
    this.#groupChange = change.catch(() => {});
    try {
      await change;
    } catch (err) {
      this.log.warn("matter group assignment failed", { nodeId, err });
      throw new HttpError(409, "Group could not be saved. Refresh and try again.");
    }
    writeJSON(res, 200, {
      node: { nodeId, groups: this.hub.groupsForMatter(nodeId), groupIds: this.hub.directGroupsForMatter(nodeId) },
    });
  }

  async #matterRemove({ res, params, signal }: RequestContext): Promise<void> {
    const raw = params[0] ?? "";
    const id = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(id)) {
      throw new HttpError(400, "nodeId must be a number");
    }
    await this.#matterCall(() => this.matter.removeNode(id, withTimeout(signal, commandTimeoutMs)));
    this.organization?.removeDevice(`matter:${id}`);
    writeJSON(res, 200, { ok: true });
  }

  async #matterCommission({ req, res, signal }: RequestContext): Promise<void> {
    const body = (await readBody(req)).only("code", "networkOnly");
    const code = body.string("code") ?? "";
    if (code === "") {
      throw new HttpError(400, "code is required");
    }
    const networkOnly = body.bool("networkOnly") ?? false;
    const node = await this.#matterCall(() =>
      this.matter.commission(code, networkOnly, withTimeout(signal, pairingTimeoutMs)),
    );
    writeJSON(res, 200, { node });
  }

  async #matterWiFi({ req, res }: RequestContext): Promise<void> {
    const body = (await readBody(req)).only("ssid", "password");
    const ssid = body.string("ssid") ?? "";
    if (ssid === "") {
      throw new HttpError(400, "ssid is required");
    }
    await this.#matterCall(() => this.matter.setWiFiCredentials(ssid, body.string("password") ?? ""));
    writeJSON(res, 200, { ok: true });
  }

  async #matterThread({ req, res }: RequestContext): Promise<void> {
    const dataset = (await readBody(req)).only("dataset").string("dataset") ?? "";
    if (dataset === "") {
      throw new HttpError(400, "dataset is required");
    }
    await this.#matterCall(() => this.matter.setThreadDataset(dataset));
    writeJSON(res, 200, { ok: true });
  }

  async #hubCall<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof NotFoundError) throw new HttpError(404, err.message);
      if (err instanceof InvalidCommandError) throw new HttpError(400, err.message);
      throw err;
    }
  }

  async #matterCall<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.matter.ready) {
      throw new HttpError(503, new MatterNotReadyError().message);
    }
    try {
      return await fn();
    } catch (err) {
      if (err instanceof MatterNotReadyError) throw new HttpError(503, err.message);
      if (err instanceof MatterError) throw new HttpError(502, err.message);
      if (err instanceof DOMException) throw new HttpError(504, err.message);
      throw err;
    }
  }
}

function requireSameOrigin(req: IncomingMessage): void {
  if (req.headers["sec-fetch-site"] === "cross-site") throw new HttpError(403, "cross-site request refused");
  const origin = req.headers.origin;
  if (origin === undefined) return;
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    throw new HttpError(403, "cross-site request refused");
  }
  if (host !== req.headers.host) throw new HttpError(403, "cross-site request refused");
}

/** Decodes one path segment; a malformed escape like %E0%A4 is the client's mistake. */
function decodeParam(param: string): string {
  try {
    return decodeURIComponent(param);
  } catch {
    throw new HttpError(400, "malformed path");
  }
}

/** The request's signal, also aborted after ms. */
function withTimeout(signal: AbortSignal, ms: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(ms)]);
}

function requestToken(req: IncomingMessage): string {
  const header = req.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : (cookies(req).get(authCookie) ?? "");
}

/**
 * Sets the session cookie. It is Secure only over HTTPS (directly or through
 * the tunnel): on the home network the hub is often plain HTTP, and a Secure
 * cookie would never be sent back.
 */
function signIn(req: IncomingMessage, res: ServerResponse, token: string): void {
  res.setHeader("Set-Cookie", cookie(token, sessionLifetimeMs / 1000, isHTTPS(req)));
}

function cookie(value: string, maxAge: number, secure: boolean): string {
  return `${authCookie}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

function cookies(req: IncomingMessage): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) {
      out.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
    }
  }
  return out;
}

/** Reads a JSON object body of at most 64 KiB. */
async function readBody(req: IncomingMessage): Promise<Fields> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      throw new JsonShapeError("too large");
    }
    chunks.push(chunk);
  }
  return new Fields(parseJson(Buffer.concat(chunks).toString("utf8")), "body");
}

function writeJSON(res: ServerResponse, status: number, v: unknown): void {
  if (res.headersSent) {
    return;
  }
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(v) + "\n");
}

function writeError(res: ServerResponse, status: number, msg: string): void {
  writeJSON(res, status, { error: msg });
}

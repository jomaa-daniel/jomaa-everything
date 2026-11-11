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

interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  params: string[];
  /** Aborted when the client goes away. */
  signal: AbortSignal;
}

interface Route {
  method: string;
  pattern: RegExp;
  handler: Handler;
}

/** Serves the hub API. */
export class Api {
  readonly #token: string;
  readonly #limiter = new LoginLimiter();
  readonly #public: Route[];
  readonly #authed: Route[];
  readonly #healthHttp: HealthHttp | undefined;

  /** password must be non-empty; clients exchange it for a session token at POST /api/login. */
  constructor(
    private readonly hub: Hub,
    private readonly matter: MatterAdmin,
    password: string,
    private readonly log: Log,
    health?: HealthStore,
  ) {
    this.#token = sessionToken(password);
    this.#healthHttp = health
      ? new HealthHttp(health, log.with({ component: "device-health" }), matter, hub)
      : undefined;
    const route = (method: string, path: string, handler: Handler): Route => ({
      method,
      pattern: new RegExp("^" + path.replace(/\{\w+\}/g, "([^/]+)") + "$"),
      handler: handler.bind(this),
    });
    this.#public = [
      route("GET", "/healthz", this.#health),
      route("POST", "/api/login", this.#login),
      route("POST", "/api/logout", this.#logout),
    ];
    this.#authed = [
      route("GET", "/api/targets", this.#listTargets),
      route("GET", "/api/targets/{id}/state", this.#targetState),
      route("POST", "/api/targets/{id}/command", this.#command),
      route("POST", "/api/targets/{id}/sync", this.#sync),
      route("GET", "/api/matter/nodes", this.#matterNodes),
      route("GET", "/api/matter/discover", this.#matterDiscover),
      route("POST", "/api/matter/register", this.#matterRegister),
      route("PATCH", "/api/matter/nodes/{nodeId}/name", this.#matterRename),
      route("DELETE", "/api/matter/nodes/{nodeId}", this.#matterRemove),
      route("POST", "/api/matter/commission", this.#matterCommission),
      route("POST", "/api/matter/wifi", this.#matterWiFi),
      route("POST", "/api/matter/thread", this.#matterThread),
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
      if (err instanceof HttpError || err instanceof HealthError) {
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
    if (await this.#healthHttp?.handle(req, res, this.#authedRequest(req))) return;
    if (await this.#serve(this.#public, req, res, path, signal, false)) {
      return;
    }
    if (!path.startsWith("/api/")) {
      throw new HttpError(404, "not found");
    }
    if (!this.#authedRequest(req)) {
      throw new HttpError(401, "sign in first");
    }
    if (!(await this.#serve(this.#authed, req, res, path, signal, true))) {
      throw new HttpError(404, "not found");
    }
  }

  /** Runs the matching route. A path served under another method is a 405 when strict. */
  async #serve(
    routes: Route[],
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    signal: AbortSignal,
    strict: boolean,
  ): Promise<boolean> {
    let pathMatched = false;
    for (const r of routes) {
      const m = r.pattern.exec(path);
      if (!m) {
        continue;
      }
      pathMatched = true;
      if (r.method === req.method) {
        await r.handler({ req, res, params: m.slice(1).map(decodeParam), signal });
        return true;
      }
    }
    if (strict && pathMatched) {
      throw new HttpError(405, "method not allowed");
    }
    return false;
  }

  #authedRequest(req: IncomingMessage): boolean {
    const header = req.headers.authorization ?? "";
    const got = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : (cookies(req).get(authCookie) ?? "");
    return got !== "" && sameSecret(got, this.#token);
  }

  async #health({ res }: RequestContext): Promise<void> {
    writeJSON(res, 200, { ok: true, matterConnected: this.matter.ready });
    return Promise.resolve();
  }

  async #login({ req, res }: RequestContext): Promise<void> {
    const password = (await readBody(req)).only("password").string("password") ?? "";
    const client = clientIP(req);
    const { ok, waitMs } = this.#limiter.allow(client);
    if (!ok) {
      res.setHeader("Retry-After", String(Math.trunc(waitMs / 1000) + 1));
      throw new HttpError(429, "too many failed sign-ins; try again later");
    }
    if (!sameSecret(sessionToken(password), this.#token)) {
      this.#limiter.fail(client);
      this.log.warn("failed sign-in", { client });
      throw new HttpError(401, "wrong password");
    }
    this.#limiter.succeed(client);
    // Secure only over HTTPS (directly or through the tunnel): on the home
    // network the hub is often plain HTTP, and a Secure cookie would never be
    // sent back.
    res.setHeader("Set-Cookie", cookie(this.#token, 30 * 24 * 60 * 60, isHTTPS(req)));
    writeJSON(res, 200, { token: this.#token });
  }

  async #logout({ req, res }: RequestContext): Promise<void> {
    res.setHeader("Set-Cookie", cookie("", 0, isHTTPS(req)));
    writeJSON(res, 200, { ok: true });
    return Promise.resolve();
  }

  async #listTargets({ res }: RequestContext): Promise<void> {
    writeJSON(res, 200, { targets: this.hub.list() });
    return Promise.resolve();
  }

  async #targetState({ res, params, signal }: RequestContext): Promise<void> {
    const result = await this.#hubCall(() => this.hub.state(params[0] ?? "", withTimeout(signal, commandTimeoutMs)));
    writeJSON(res, 200, result);
  }

  /**
   * Answers 200 when every device took the command, and 502 with the failures
   * otherwise, so a client can roll back its optimistic update.
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
    if (Object.keys(failed).length > 0) {
      this.log.warn("command partly failed", { target: id, failed });
      writeJSON(res, 502, { ok: false, failed });
      return;
    }
    writeJSON(res, 200, { ok: true });
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

  async #matterRemove({ res, params, signal }: RequestContext): Promise<void> {
    const raw = params[0] ?? "";
    const id = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(id)) {
      throw new HttpError(400, "nodeId must be a number");
    }
    await this.#matterCall(() => this.matter.removeNode(id, withTimeout(signal, commandTimeoutMs)));
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

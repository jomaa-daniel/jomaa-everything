import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isHTTPS, LoginLimiter, clientIP } from "../limiter.js";
import type { Log } from "../log.js";
import { HealthError, type HealthStore } from "./store.js";

const files: Record<string, [string, string]> = {
  "/devices": ["devices.html", "text/html; charset=utf-8"],
  "/devices/": ["devices.html", "text/html; charset=utf-8"],
  "/devices/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/devices/style.css": ["style.css", "text/css; charset=utf-8"],
};

/** Shares the hub's administrator session, while pings use only device credentials. */
export class HealthHttp {
  readonly #limiter = new LoginLimiter();
  constructor(
    private readonly store: HealthStore,
    private readonly log: Log,
  ) {}

  async handle(req: IncomingMessage, res: ServerResponse, authed: boolean): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://hub");
    if (url.pathname === "/" && (req.method === "GET" || req.method === "HEAD")) {
      res.writeHead(302, { Location: "/devices", "Cache-Control": "no-store" });
      res.end();
      return true;
    }
    const file = files[url.pathname];
    if (file) {
      if (req.method !== "GET") throw new HealthError(405, "method not allowed");
      res.writeHead(200, {
        "Content-Type": file[1],
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "same-origin",
        "Content-Security-Policy":
          "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      });
      res.end(readFileSync(new URL("../web/" + file[0], import.meta.url)));
      return true;
    }
    if (url.pathname !== "/api/devices" && !url.pathname.startsWith("/api/devices/")) return false;
    res.setHeader("Cache-Control", "no-store");
    const ping = /^\/api\/devices\/([^/]+)\/health$/.exec(url.pathname);
    if (ping) {
      if (req.method !== "POST") throw new HealthError(405, "method not allowed");
      // Forwarded HTTPS is trusted only from the existing local tunnel (limiter.ts).
      if (!isHTTPS(req)) throw new HealthError(426, "device health reports require HTTPS");
      const client = clientIP(req);
      if (!this.#limiter.allow(client).ok) throw new HealthError(429, "too many invalid device credentials");
      const id = decodeURIComponent(ping[1] ?? "");
      try {
        const authorization = req.headers.authorization;
        this.store.authenticate(id, authorization?.startsWith("Bearer ") ? authorization.slice(7) : "");
      } catch (err) {
        this.#limiter.fail(client);
        throw err;
      }
      const result = this.store.record(id, await body(req));
      if (result.registered) this.log.info("health device registered", { deviceId: id });
      json(res, result.registered ? 201 : 200, { ok: true, ...result });
      return true;
    }
    if (!authed) throw new HealthError(401, "sign in first");
    // Browser mutations must be same-origin; scripts use the Authorization header.
    if (!["GET", "HEAD"].includes(req.method ?? "")) {
      if (req.headers["sec-fetch-site"] === "cross-site") throw new HealthError(403, "cross-site request refused");
      const origin = req.headers.origin;
      if (origin) {
        let originHost: string;
        try {
          originHost = new URL(origin).host;
        } catch {
          throw new HealthError(403, "cross-site request refused");
        }
        if (originHost !== req.headers.host) throw new HealthError(403, "cross-site request refused");
      }
    }
    if (url.pathname === "/api/devices") {
      if (req.method !== "GET") throw new HealthError(405, "method not allowed");
      json(res, 200, { devices: this.store.list(), retentionDays: this.store.retentionDays });
      return true;
    }
    if (url.pathname === "/api/devices/enroll" && req.method === "POST") {
      requireSecureCredential(req);
      json(res, 201, this.store.enroll(await body(req)));
      return true;
    }
    const match = /^\/api\/devices\/([^/]+)(?:\/(logs|revoke|credential))?$/.exec(url.pathname);
    if (!match) throw new HealthError(404, "not found");
    const id = decodeURIComponent(match[1] ?? "");
    const action = match[2];
    if (!action && req.method === "GET") json(res, 200, { device: this.store.get(id) });
    else if (!action && req.method === "PATCH") json(res, 200, { device: this.store.update(id, await body(req)) });
    else if (action === "logs" && req.method === "GET") {
      json(
        res,
        200,
        this.store.logs(
          id,
          Number(url.searchParams.get("limit") ?? 100),
          url.searchParams.has("before") ? Number(url.searchParams.get("before")) : undefined,
        ),
      );
    } else if (action === "revoke" && req.method === "POST") {
      json(res, 200, { device: this.store.revoke(id) });
      this.log.info("health device revoked", { deviceId: id });
    } else if (action === "credential" && req.method === "POST") {
      requireSecureCredential(req);
      json(res, 200, this.store.rotate(id));
    } else throw new HealthError(405, "method not allowed");
    return true;
  }
}

function requireSecureCredential(req: IncomingMessage): void {
  const address = req.socket.remoteAddress;
  if (!isHTTPS(req) && address !== "::1" && address !== "127.0.0.1" && address !== "::ffff:127.0.0.1") {
    throw new HealthError(426, "credential issuance requires HTTPS or local access");
  }
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.headers["content-type"]?.split(";")[0]?.trim() !== "application/json")
    throw new HealthError(415, "use application/json");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = chunk as Buffer;
    size += bytes.length;
    if (size > 4096) throw new HealthError(413, "health request too large");
    chunks.push(bytes);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HealthError(400, "invalid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HealthError(400, "body must be a JSON object");
  return value as Record<string, unknown>;
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify(value) + "\n");
}

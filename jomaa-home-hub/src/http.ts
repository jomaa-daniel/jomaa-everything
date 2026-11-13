// Request plumbing shared by the API and its feature modules.
import type { IncomingMessage, ServerResponse } from "node:http";
import { Fields, JsonShapeError, parseJson } from "./json.js";
import type { Principal } from "./principal.js";
import type { Requirement } from "./authorization.js";

const maxBodyBytes = 64 << 10;

/** A request the API refuses with a status and message. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  params: string[];
  /** Aborted when the client goes away. */
  signal: AbortSignal;
  principal: Principal | null;
}

export type Handler = (ctx: RequestContext) => Promise<void>;

export interface Route {
  method: string;
  pattern: RegExp;
  handler: Handler;
  requires: Requirement;
}

/** A feature's routes; the API checks each route's requirement before running it. */
export interface FeatureModule {
  routes(): Route[];
}

/** A route whose {name} path segments become params. */
export function route(method: string, path: string, requires: Requirement, handler: Handler): Route {
  return { method, pattern: new RegExp("^" + path.replace(/\{\w+\}/g, "([^/]+)") + "$"), handler, requires };
}

/** Refuses browser requests from another site; scripts with an Authorization header send no Origin. */
export function requireSameOrigin(req: IncomingMessage): void {
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
export function decodeParam(param: string): string {
  try {
    return decodeURIComponent(param);
  } catch {
    throw new HttpError(400, "malformed path");
  }
}

/** The request's signal, also aborted after ms. */
export function withTimeout(signal: AbortSignal, ms: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(ms)]);
}

/** Reads a JSON object body of at most 64 KiB. */
export async function readBody(req: IncomingMessage): Promise<Fields> {
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

export function writeJSON(res: ServerResponse, status: number, v: unknown): void {
  if (res.headersSent) {
    return;
  }
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(v) + "\n");
}

export function writeError(res: ServerResponse, status: number, msg: string): void {
  writeJSON(res, status, { error: msg });
}

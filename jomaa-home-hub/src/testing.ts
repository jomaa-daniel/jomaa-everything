// Helpers shared by the tests.
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { Socket, type AddressInfo } from "node:net";
import { AuthorizationService } from "./authorization.js";
import { HttpError, serveRoutes, type FeatureModule } from "./http.js";
import type { Principal } from "./principal.js";

/** Starts an HTTP server on a free loopback port. It doesn't keep the test process alive. */
export async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  server.unref();
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Reads a request body as JSON. */
export async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString() || "null");
}

/** A response that keeps the text a route ends it with. */
class RecordedResponse extends ServerResponse {
  text = "";

  override end(chunk?: unknown): this {
    if (typeof chunk === "string") this.text += chunk;
    return super.end();
  }
}

/** A feature module's answer to one dispatched request. */
export interface ModuleReply {
  status: number;
  /** The parsed JSON body, or null when the route wrote none. */
  body: unknown;
}

/** One request to a feature module. body is sent as JSON; null sends no body. */
export interface ModuleRequest {
  principal: Principal | null;
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

/**
 * Runs one request through a single feature module's routes with the API's
 * route matching and authorization check, without a server or the rest of
 * the API. A refusal rejects with the error the API turns into a status: a
 * path no route serves is an HttpError 404.
 */
export async function dispatch(module: FeatureModule, request: ModuleRequest): Promise<ModuleReply> {
  const req = new IncomingMessage(new Socket());
  req.method = request.method;
  req.url = request.path;
  req.headers = { host: "hub" };
  for (const [name, value] of Object.entries(request.headers)) req.headers[name.toLowerCase()] = value;
  if (request.body !== null) req.push(JSON.stringify(request.body));
  req.push(null);
  const res = new RecordedResponse(req);
  const path = new URL(request.path, "http://hub").pathname;
  const signal = new AbortController().signal;
  const routed = { req, res, path, signal, principal: request.principal };
  if (!(await serveRoutes(module.routes(), new AuthorizationService(), routed, true)))
    throw new HttpError(404, "not found");
  return { status: res.statusCode, body: res.text === "" ? null : JSON.parse(res.text) };
}

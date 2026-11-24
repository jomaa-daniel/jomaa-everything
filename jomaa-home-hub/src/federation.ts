import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Grant, Scope } from "./accounts.js";
import { catalog, type NodeCatalog, type NodeConfig } from "./nodes.js";
import { BodyLimitError, requestBody } from "./request-body.js";

export const nodeQuery = "node";
export const delegationHeader = "x-jomaa-delegation";
const signatureDomain = "jomaa-node-request-v1:";

export class NodeError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface Authorization {
  issuer: string;
  node: string;
  scope: Scope;
  method: string;
  url: string;
  contentType: string;
  body: string;
  expires: number;
  nonce: string;
}

function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function mac(key: string, claims: string): Buffer {
  return createHmac("sha256", key)
    .update(signatureDomain + claims)
    .digest();
}

/** Capability-based request delegation to an installation from the shared catalog. */
export class Federation {
  readonly local: NodeConfig;
  readonly #used = new Map<string, number>();
  now: () => number = Date.now;

  constructor(
    readonly config: NodeCatalog = catalog,
    node = config.defaultNode,
    private readonly keys: NodeJS.ProcessEnv = process.env,
    private readonly transport: typeof fetch = fetch,
  ) {
    const local = config.nodes.find((candidate) => candidate.id === node);
    if (!local) throw new Error(`unknown node: ${node}`);
    this.local = local;
    if (local.mode === "node" && local.enabled) this.#key(local);
  }

  available(grants: Grant[] | null, scope?: Scope): { id: string; name: string; scopes: Scope[] }[] {
    return this.config.nodes
      .filter((node) => node.enabled)
      .map((node) => ({
        id: node.id,
        name: node.name,
        scopes: node.scopes.filter(
          (capability) =>
            grants === null || grants.some((grant) => grant.node === node.id && grant.scopes.includes(capability)),
        ),
      }))
      .filter((node) => grants === null || (scope ? node.scopes.includes(scope) : node.scopes.length > 0));
  }

  target(grants: Grant[] | null, scope: Scope, requested: string | null): NodeConfig {
    let id: string | undefined;
    if (this.config.routing[scope] === "account") {
      if (requested !== null) throw new NodeError(400, "This capability uses the account's assigned node");
      const assigned = this.available(grants, scope);
      if (grants !== null && assigned.length !== 1)
        throw new NodeError(
          403,
          "This account needs one assigned node for this capability. Ask the hub owner to set it.",
        );
      id = grants === null ? this.config.defaultNode : assigned[0]?.id;
    } else {
      id = requested ?? this.available(grants, scope)[0]?.id;
    }
    const node = this.config.nodes.find((candidate) => candidate.id === id);
    if (
      !node ||
      !node.enabled ||
      !node.scopes.includes(scope) ||
      (grants !== null && !grants.some((grant) => grant.node === id && grant.scopes.includes(scope)))
    )
      throw new NodeError(403, "Your account does not have access to this capability on this node.");
    return node;
  }

  validateGrants(grants: Grant[]): void {
    const seen = new Set<string>();
    const assignments = new Set<Scope>();
    for (const grant of grants) {
      const node = this.config.nodes.find((candidate) => candidate.id === grant.node);
      if (!node || !node.enabled || seen.has(grant.node) || grant.scopes.some((scope) => !node.scopes.includes(scope)))
        throw new NodeError(400, "Grants must name unique enabled nodes and their allowed capabilities");
      seen.add(grant.node);
      for (const scope of grant.scopes) {
        if (this.config.routing[scope] !== "account") continue;
        if (assignments.has(scope)) throw new NodeError(400, "Assign only one node to each account-routed capability");
        assignments.add(scope);
      }
    }
  }

  publicRequest(req: IncomingMessage): boolean {
    const path = new URL(req.url ?? "/", "http://hub").pathname;
    return this.local.publicRoutes.some(([method, route]) => method === req.method && route === path);
  }

  async authenticate(req: IncomingMessage, scope: Scope): Promise<void> {
    if (!this.local.enabled || !this.local.scopes.includes(scope))
      throw new NodeError(403, "This node does not allow this capability");
    const header = req.headers[delegationHeader];
    if (typeof header !== "string") throw new NodeError(403, "A delegated request is required");
    const parts = header.split(".");
    const encoded = parts[0] ?? "";
    const signature = Buffer.from(parts[1] ?? "", "base64url");
    const expected = mac(this.#key(this.local), encoded);
    if (parts.length !== 2 || signature.length !== expected.length || !timingSafeEqual(signature, expected))
      throw new NodeError(403, "Invalid delegated request");
    let claims: Authorization | null;
    try {
      claims = JSON.parse(Buffer.from(encoded, "base64url").toString()) as Authorization | null;
    } catch {
      throw new NodeError(403, "Invalid delegated request");
    }
    const now = this.now();
    if (
      claims === null ||
      claims.issuer !== this.config.defaultNode ||
      claims.node !== this.local.id ||
      claims.scope !== scope ||
      claims.method !== req.method ||
      claims.url !== req.url ||
      claims.contentType !== (req.headers["content-type"] ?? "") ||
      !Number.isSafeInteger(claims.expires) ||
      claims.expires <= now ||
      claims.expires > now + this.config.transport.delegationLifetimeSeconds * 1000 ||
      typeof claims.nonce !== "string" ||
      !/^[a-f0-9]{32}$/.test(claims.nonce)
    )
      throw new NodeError(403, "Invalid or expired delegated request");
    const body = await requestBody(req, this.config.transport.maxRequestBytes);
    if (claims.body !== hash(body)) throw new NodeError(403, "Invalid delegated request body");
    for (const [nonce, expiry] of this.#used) if (expiry <= now) this.#used.delete(nonce);
    if (this.#used.has(claims.nonce)) throw new NodeError(403, "Delegated request already used");
    if (this.#used.size >= this.config.transport.replayLimit)
      throw new NodeError(503, "Node authorization capacity reached");
    this.#used.set(claims.nonce, claims.expires);
  }

  async forward(
    req: IncomingMessage,
    res: ServerResponse,
    node: NodeConfig,
    scope: Scope,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.local.mode !== "gateway" || node.mode !== "node" || !node.hostname)
      throw new NodeError(403, "This node cannot forward requests");
    const key = this.#key(node);
    const body = await requestBody(req, this.config.transport.maxRequestBytes);
    const url = new URL(req.url ?? "/", "http://hub");
    url.searchParams.delete(nodeQuery);
    const path = url.pathname + url.search;
    const contentType = req.headers["content-type"] ?? "";
    const claims: Authorization = {
      issuer: this.local.id,
      node: node.id,
      scope,
      method: req.method ?? "GET",
      url: path,
      contentType,
      body: hash(body),
      expires: this.now() + this.config.transport.delegationLifetimeSeconds * 1000,
      nonce: randomBytes(16).toString("hex"),
    };
    const encoded = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const headers: Record<string, string> = {
      [delegationHeader]: `${encoded}.${mac(key, encoded).toString("base64url")}`,
    };
    if (contentType) headers["content-type"] = contentType;
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(this.config.transport.requestTimeoutSeconds * 1000)]);
    let response: Response;
    try {
      response = await this.transport(`https://${node.hostname}${path}`, {
        method: claims.method,
        headers,
        ...(body.length ? { body: new Uint8Array(body) } : {}),
        redirect: "manual",
        signal: deadline,
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new NodeError(502, "Node returned a redirect");
      }
      res.statusCode = response.status;
      for (const name of ["content-type", "retry-after"]) {
        const value = response.headers.get(name);
        if (value !== null) res.setHeader(name, value);
      }
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("X-Jomaa-Node", node.id);
      let size = 0;
      if (response.body) {
        const reader = (response.body as ReadableStream<Uint8Array>).getReader();
        for (;;) {
          const { done, value: chunk } = await reader.read();
          if (done) break;
          size += chunk.length;
          if (size > this.config.transport.maxResponseBytes) throw new NodeError(502, "Node response too large");
          if (!res.write(chunk)) await once(res, "drain", { signal: deadline });
        }
      }
      res.end();
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof NodeError || error instanceof BodyLimitError) throw error;
      throw new NodeError(deadline.aborted ? 504 : 502, "Node request failed");
    }
  }

  #key(node: NodeConfig): string {
    const key = node.secretEnv ? this.keys[node.secretEnv] : undefined;
    if (!key || key.length < this.config.transport.secretMinLength)
      throw new NodeError(503, "Node key is not provisioned");
    return key;
  }
}

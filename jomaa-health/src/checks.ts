import config from "../config.json" with { type: "json" };

/** ok: working. warn: the server works but a device it manages is not answering. fail: broken. */
export type Status = "ok" | "warn" | "fail";

export interface Result {
  group: string;
  name: string;
  url: string;
  status: Status;
  detail: string;
  ms: number;
}

export interface Report {
  checkedAt: number;
  status: Status;
  results: Result[];
}

/** A public route of a deployed service. */
export interface Route {
  hostname: string;
  service: string;
  path: string | null;
  probes: string[] | null;
}

/** A service's health check: its URL and the JSON fields its answer must contain. */
export interface Health {
  url: string;
  json: Record<string, unknown>;
}

/** The live services and routes that jomaa-deploy writes to inventory.json before deploying the Worker. */
export interface Inventory {
  webhook: string;
  services: Map<string, Health | null>;
  routes: Route[];
}

/** Network access used by the checks. */
export interface Probe {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** Resolves with the first line the SSH server sends through the tunnel. */
  sshBanner: (url: string, signal: AbortSignal) => Promise<string>;
  password: string;
  now: () => number;
}

const requestTimeoutMs = config.requestTimeoutSeconds * 1000;
const discoverTimeoutMs = config.discoveryTimeoutSeconds * 1000;

/** The hub's answer to an unauthenticated API request. */
const signInRefusal = "sign in first";
/** Where the hub's whole-host route redirects its root. */
const inventoryPath = "/devices";
/** The deployment receiver's path, WEBHOOK_PATH in jomaa-deploy/settings.py. */
const receiverPath = "/deploy";

class CheckError extends Error {
  readonly status: Status;

  constructor(message: string, status: Status = "fail") {
    super(message);
    this.status = status;
  }
}

interface Check {
  group: string;
  name: string;
  url: string;
  run: (signal: AbortSignal) => Promise<string>;
  timeoutMs: number;
}

function check(group: string, name: string, url: string, run: Check["run"], timeoutMs = requestTimeoutMs): Check {
  return { group, name, url, run, timeoutMs };
}

async function execute(c: Check, now: () => number): Promise<Result> {
  const started = now();
  const done = (status: Status, detail: string): Result => ({
    group: c.group,
    name: c.name,
    url: c.url,
    status,
    detail,
    ms: Math.round(now() - started),
  });
  try {
    return done("ok", await c.run(AbortSignal.timeout(c.timeoutMs)));
  } catch (err) {
    if (err instanceof CheckError) return done(err.status, err.message);
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      return done("fail", `no answer within ${c.timeoutMs / 1000} s`);
    }
    return done("fail", err instanceof Error ? err.message : String(err));
  }
}

function object(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new CheckError(`${what} is not an object`);
  const fields: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) fields[key] = field;
  return fields;
}

function list(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new CheckError(`${what} is not a list`);
  return value;
}

function text(value: unknown, what: string): string {
  if (typeof value !== "string") throw new CheckError(`${what} is not a string`);
  return value;
}

/** Validates the inventory written by jomaa-deploy. */
export function parseInventory(value: unknown): Inventory {
  const fields = object(value, "inventory");
  const services = new Map<string, Health | null>();
  for (const [name, entry] of Object.entries(object(fields["services"], "services"))) {
    const health = object(entry, `service ${name}`)["health"];
    if (health === null) {
      services.set(name, null);
      continue;
    }
    const check = object(health, `${name} health`);
    services.set(name, { url: text(check["url"], `${name} health url`), json: object(check["json"], `${name} health json`) });
  }
  const routes = list(fields["routes"], "routes").map((entry): Route => {
    const route = object(entry, "route");
    const hostname = text(route["hostname"], "route hostname");
    const probes = route["probes"] === null ? null : list(route["probes"], `${hostname} probes`).map((p) => text(p, "probe"));
    return {
      hostname,
      service: text(route["service"], `${hostname} service`),
      path: route["path"] === null ? null : text(route["path"], `${hostname} path`),
      probes,
    };
  });
  return { webhook: text(fields["webhook"], "webhook"), services, routes };
}

async function readJSON(res: Response, what: string): Promise<Record<string, unknown>> {
  if (!(res.headers.get("content-type") ?? "").startsWith("application/json")) {
    throw new CheckError(`${what}: expected JSON, got HTTP ${res.status} ${res.headers.get("content-type") ?? "without a type"}`);
  }
  return object(await res.json(), what);
}

function expectStatus(res: Response, want: number): void {
  if (res.status !== want) throw new CheckError(`HTTP ${res.status}, expected ${want}`);
}

/** A GET probe through a jomaa.org route must reach the hub: a page, a redirect, or the hub's sign-in refusal. */
async function hubRoute(probe: Probe, url: string, signal: AbortSignal): Promise<string> {
  const res = await probe.fetch(url, { redirect: "manual", signal });
  if (res.status === 200 || res.status === 302) {
    await res.body?.cancel();
    const type = res.headers.get("content-type");
    return res.status === 302 ? `redirects to ${new URL(res.headers.get("location") ?? "", url).pathname}` : `HTTP 200 ${type ?? ""}`.trim();
  }
  if (res.status === 401) {
    const body = await readJSON(res, "refusal");
    if (body["error"] !== signInRefusal) throw new CheckError(`HTTP 401 without the hub's sign-in refusal`);
    return "reaches the hub API (sign-in required)";
  }
  await res.body?.cancel();
  throw new CheckError(`HTTP ${res.status}: not answered by the hub`);
}

function hostChecks(probe: Probe, inventory: Inventory): Check[] {
  const checks: Check[] = [];
  for (const route of inventory.routes) {
    const base = `https://${route.hostname}`;
    if (route.probes !== null) {
      for (const path of route.probes) {
        checks.push(check(route.hostname, path, base + path, (signal) => hubRoute(probe, base + path, signal)));
      }
      continue;
    }
    const health = inventory.services.get(route.service);
    if (health !== undefined && health !== null) {
      const url = base + new URL(health.url).pathname;
      checks.push(
        check(route.hostname, `${route.service} health`, url, async (signal) => {
          const res = await probe.fetch(url, { signal });
          expectStatus(res, 200);
          const body = await readJSON(res, "health");
          const expected = Object.entries(health.json);
          for (const [field, value] of expected) {
            if (body[field] !== value) throw new CheckError(`${field} is ${JSON.stringify(body[field])}, expected ${JSON.stringify(value)}`);
          }
          return expected.map(([field, value]) => `${field}: ${JSON.stringify(value)}`).join(", ");
        }),
      );
    }
    if (route.service === "hub") {
      checks.push(
        check(route.hostname, "Device inventory page", `${base}/`, async (signal) => {
          const res = await probe.fetch(`${base}/`, { redirect: "manual", signal });
          expectStatus(res, 302);
          const location = new URL(res.headers.get("location") ?? "", base).pathname;
          if (location !== inventoryPath) throw new CheckError(`redirects to ${location}, expected ${inventoryPath}`);
          return `redirects to ${inventoryPath}`;
        }),
      );
      if (inventory.webhook === route.hostname) {
        checks.push(
          check(route.hostname, "Deployment receiver", base + receiverPath, async (signal) => {
            const res = await probe.fetch(base + receiverPath, { method: "POST", signal });
            expectStatus(res, 403);
            const body = await readJSON(res, "receiver");
            if (body["error"] !== "unauthorized") throw new CheckError("unexpected receiver answer");
            return "rejects unsigned deployments";
          }),
        );
      }
      continue;
    }
    if (route.service === "ssh") {
      checks.push(
        check(route.hostname, "SSH through the tunnel", base, async (signal) => {
          const banner = await probe.sshBanner(base, signal);
          if (!banner.startsWith("SSH-2.0-")) throw new CheckError(`unexpected greeting: ${banner.slice(0, 40)}`);
          return banner.trim();
        }),
      );
    }
  }
  for (const site of config.staticSites) {
    const url = `https://${site}/`;
    checks.push(
      check(site, "Static site", url, async (signal) => {
        const res = await probe.fetch(url, { signal });
        expectStatus(res, 200);
        const html = await res.text();
        if (!(res.headers.get("content-type") ?? "").startsWith("text/html") || !/<html/i.test(html)) {
          throw new CheckError("index is not an HTML page");
        }
        return `${html.length} bytes of HTML`;
      }),
    );
  }
  return checks;
}

/**
 * Signs in through the hub's path route, reads every room, device inventory, and Matter, then signs out.
 * Matter nodes are read through the hub's whole-host route, which serves every API path.
 */
async function apiChecks(probe: Probe, inventory: Inventory): Promise<Result[]> {
  const group = "Hub API";
  const hubRoutes = inventory.routes.filter((route) => route.service === "hub");
  const pathRoute = hubRoutes.find((route) => route.path !== null);
  const hostRoute = hubRoutes.find((route) => route.path === null);
  if (pathRoute === undefined || hostRoute === undefined) {
    const missing = "the inventory needs a hub path route and a hub whole-host route";
    return [{ group, name: "Hub routes", url: "", status: "fail", detail: missing, ms: 0 }];
  }
  const site = `https://${pathRoute.hostname}`;
  const hub = `https://${hostRoute.hostname}`;
  let token = "";
  const authed = (url: string, signal: AbortSignal, method = "GET") =>
    probe.fetch(url, { method, headers: { Authorization: `Bearer ${token}` }, signal });

  const login = await execute(
    check(group, "Sign in", `${site}/api/login`, async (signal) => {
      if (probe.password === "") throw new CheckError("HUB_PASSWORD is not configured for the health page");
      const res = await probe.fetch(`${site}/api/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: probe.password }),
        signal,
      });
      expectStatus(res, 200);
      token = text((await readJSON(res, "sign-in"))["token"], "session token");
      return "administrator session issued";
    }),
    probe.now,
  );
  if (login.status !== "ok") return [login];

  let read: { id: string; name: string }[] = [];
  const targetList = await execute(
    check(group, "Targets", `${site}/api/targets`, async (signal) => {
      const res = await authed(`${site}/api/targets`, signal);
      expectStatus(res, 200);
      const targets = list((await readJSON(res, "targets"))["targets"], "targets").map((t) => {
        const target = object(t, "target");
        return {
          id: text(target["id"], "target id"),
          name: text(target["name"], "target name"),
          members: target["kind"] === "room" ? list(target["members"], "room members") : null,
        };
      });
      const inRoom = new Set(targets.flatMap((t) => t.members ?? []));
      const rooms = targets.filter((t) => t.members !== null);
      read = [...rooms, ...targets.filter((t) => t.members === null && !inRoom.has(t.id))];
      return `${targets.length} targets, ${rooms.length} rooms`;
    }),
    probe.now,
  );

  const checks: Check[] = read.map(({ id, name }) => {
    const url = `${site}/api/targets/${encodeURIComponent(id)}/state`;
    return check(group, `State: ${name}`, url, async (signal) => {
      const res = await authed(url, signal);
      expectStatus(res, 200);
      const body = await readJSON(res, "state");
      const answered = Object.keys(object(body["devices"], "devices")).length;
      const failed = Object.keys(object(body["failed"], "failed")).length;
      const summary = `${answered} of ${answered + failed} devices answering`;
      if (failed > 0) throw new CheckError(summary, answered > 0 ? "warn" : "fail");
      return summary;
    });
  });

  checks.push(
    check(group, "Device management", `${site}/api/manage`, async (signal) => {
      const res = await authed(`${site}/api/manage`, signal);
      expectStatus(res, 200);
      const body = await readJSON(res, "management");
      return `${list(body["devices"], "devices").length} devices, ${list(body["groups"], "groups").length} groups`;
    }),
    check(group, "Health reporters", `${site}/api/devices`, async (signal) => {
      const res = await authed(`${site}/api/devices`, signal);
      expectStatus(res, 200);
      const body = await readJSON(res, "inventory");
      const reporters = list(body["devices"], "devices").map((d) => object(d, "device"));
      const active = reporters.filter((d) => d["status"] !== "revoked" && d["status"] !== "pending");
      const online = active.filter((d) => d["status"] === "online").length;
      const summary = `${online} of ${active.length} reporters online`;
      if (online < active.length) throw new CheckError(summary, "warn");
      return summary;
    }),
    check(group, "Matter nodes", `${hub}/api/matter/nodes`, async (signal) => {
      const res = await authed(`${hub}/api/matter/nodes`, signal);
      expectStatus(res, 200);
      const nodes = list((await readJSON(res, "nodes"))["nodes"], "nodes").map((n) => object(n, "node"));
      const available = nodes.filter((n) => n["available"] === true).length;
      const summary = `${available} of ${nodes.length} nodes available`;
      if (available < nodes.length) throw new CheckError(summary, "warn");
      return summary;
    }),
    check(
      group,
      "Matter discovery",
      `${site}/api/matter/discover`,
      async (signal) => {
        const res = await authed(`${site}/api/matter/discover`, signal);
        expectStatus(res, 200);
        const devices = list((await readJSON(res, "discovery"))["devices"], "devices");
        return `scan finished, ${devices.length} devices advertising`;
      },
      discoverTimeoutMs,
    ),
  );

  const reads = await Promise.all(checks.map((c) => execute(c, probe.now)));
  const logout = await execute(
    check(group, "Sign out", `${site}/api/logout`, async (signal) => {
      const res = await authed(`${site}/api/logout`, signal, "POST");
      expectStatus(res, 200);
      const body = await readJSON(res, "sign-out");
      if (body["ok"] !== true) throw new CheckError("sign-out did not answer ok");
      return "session cookie cleared";
    }),
    probe.now,
  );
  return [login, targetList, ...reads, logout];
}

function worst(results: Result[]): Status {
  if (results.some((r) => r.status === "fail")) return "fail";
  if (results.some((r) => r.status === "warn")) return "warn";
  return "ok";
}

/** Runs every check concurrently. */
export async function runChecks(probe: Probe, inventory: Inventory): Promise<Report> {
  const checkedAt = probe.now();
  const [hosts, api] = await Promise.all([
    Promise.all(hostChecks(probe, inventory).map((c) => execute(c, probe.now))),
    apiChecks(probe, inventory),
  ]);
  const results = [...hosts, ...api];
  return { checkedAt, status: worst(results), results };
}

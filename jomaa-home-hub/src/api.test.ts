import assert from "node:assert/strict";
import { before, test } from "node:test";
import { Api } from "./api.js";
import { allFeatures, type Command, type Device, type Features, type State } from "./device.js";
import { Group } from "./group.js";
import { Hub } from "./hub.js";
import { Accounts } from "./accounts.js";
import { silentLog } from "./log.js";
import {
  MatterError,
  type CommissionableDevice,
  type CommissionedNode,
  type MatterAdmin,
  type NodeSummary,
} from "./matter/nodes.js";
import { serve } from "./testing.js";

class Light implements Device {
  readonly name: string;
  s: State = { on: false, brightness: 0, colorTemperaturePct: 0 };
  err: Error | null = null;

  constructor(readonly id: string) {
    this.name = id;
  }

  apply(c: Command): Promise<void> {
    if (this.err !== null) return Promise.reject(this.err);
    this.s.on = c.on ?? this.s.on;
    this.s.brightness = c.brightness ?? this.s.brightness;
    return Promise.resolve();
  }

  state(): Promise<State> {
    return this.err !== null ? Promise.reject(this.err) : Promise.resolve({ ...this.s });
  }

  features(): Features {
    return allFeatures;
  }
}

class FakeMatter implements MatterAdmin {
  ready = true;
  code = "";
  err: Error | null = null;
  instanceName = "";
  registered = false;
  names = new Map<number, string>();

  nodes(): NodeSummary[] {
    return [
      { nodeId: 1, available: true, isBridge: false, lightEndpoints: [1], vendor: "Acme", product: null, label: null },
      ...(this.registered
        ? [
            {
              nodeId: 5,
              available: true,
              isBridge: false,
              lightEndpoints: [1],
              vendor: "Acme",
              product: "Lamp",
              label: "Desk",
            },
          ]
        : []),
    ].map((node) => ({
      ...node,
      label: this.names.get(node.nodeId) ?? node.label,
      lastSeen: null,
      uptimeSeconds: null,
      uptimeObservedAt: null,
      type: "Unknown",
      capabilities: ["Power"],
    }));
  }
  rename(nodeId: number, name: string): Promise<NodeSummary> {
    if (this.err) return Promise.reject(this.err);
    this.names.set(nodeId, name);
    const node = this.nodes().find((candidate) => candidate.nodeId === nodeId);
    return node ? Promise.resolve(node) : Promise.reject(new MatterError("unknown node"));
  }
  async register(code: string, instanceName: string): Promise<CommissionedNode> {
    this.instanceName = instanceName;
    const result = await this.commission(code);
    this.registered = true;
    return result;
  }
  discover(): Promise<CommissionableDevice[]> {
    return this.err !== null
      ? Promise.reject(this.err)
      : Promise.resolve([
          {
            instanceName: "lamp",
            deviceName: "Desk",
            vendorId: 1,
            productId: 2,
            deviceType: 256,
            longDiscriminator: 1234,
            commissioningMode: 2,
            addresses: ["fd00::1"],
            port: 5540,
          },
        ]);
  }
  commission(code: string): Promise<CommissionedNode> {
    this.code = code;
    return this.err !== null
      ? Promise.reject(this.err)
      : Promise.resolve({ node_id: 5, available: true, is_bridge: false });
  }
  setWiFiCredentials(): Promise<void> {
    return this.err !== null ? Promise.reject(this.err) : Promise.resolve();
  }
  setThreadDataset(): Promise<void> {
    return this.err !== null ? Promise.reject(this.err) : Promise.resolve();
  }
  removeNode(): Promise<void> {
    return this.err !== null ? Promise.reject(this.err) : Promise.resolve();
  }
}

interface Env {
  url: string;
  token: string;
  a: Light;
  b: Light;
  matter: FakeMatter;
  accounts: Accounts;
}

type Json = Record<string, unknown>;

async function setup(): Promise<Env> {
  const a = new Light("a");
  const b = new Light("b");
  const matter = new FakeMatter();
  const accounts = new Accounts(":memory:");
  const hub = new Hub();
  hub.addDevice("test", a);
  hub.addDevice("test", b);
  hub.addRoom(new Group("room", "Room", [a, b]));
  const url = await serve(new Api(hub, matter, "hunter2", accounts, silentLog).handle);
  const { status, body } = await call({ url, token: "" }, "POST", "/api/login", '{"password":"hunter2"}');
  assert.equal(status, 200);
  return { url, token: body["token"] as string, a, b, matter, accounts };
}

await test("light controller assets are public without a health store, while commands require sign-in", async () => {
  const env = await setup();
  for (const [path, contentType] of [
    ["/lights", "text/html"],
    ["/lights/", "text/html"],
    ["/lights/app.js", "text/javascript"],
    ["/lights/style.css", "text/css"],
  ] as const) {
    const response = await fetch(env.url + path);
    assert.equal(response.status, 200);
    assert.ok(response.headers.get("content-type")?.startsWith(contentType));
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.ok(response.headers.get("content-security-policy")?.includes("script-src 'self'"));
    assert.ok((await response.text()).length > 0);
  }
  const head = await fetch(env.url + "/lights", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  const post = await fetch(env.url + "/lights", { method: "POST" });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET, HEAD");
  const denied = await fetch(env.url + "/api/targets/room/command", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ on: true }),
  });
  assert.equal(denied.status, 401);
});

async function call(
  e: Pick<Env, "url" | "token">,
  method: string,
  path: string,
  body?: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Json; res: Response }> {
  const res = await fetch(e.url + path, {
    method,
    ...(body !== undefined && { body }),
    headers: { ...(e.token && { Authorization: `Bearer ${e.token}` }), ...headers },
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Json) : {}, res };
}

let e: Env;
before(async () => {
  e = await setup();
});

test("auth", async () => {
  const anon = { url: e.url, token: "" };
  assert.equal((await call(anon, "GET", "/api/targets")).status, 401);
  assert.equal(
    (await call({ url: e.url, token: "hunter2" }, "GET", "/api/targets")).status,
    401,
    "raw password accepted",
  );
  assert.equal((await call(anon, "POST", "/api/login", '{"password":"wrong"}')).status, 401);
  assert.equal((await call(anon, "GET", "/healthz")).status, 200, "health needs no auth");
  assert.equal((await call(anon, "GET", "/api/nope")).status, 401, "unknown API paths need auth too");
});

test("the login cookie works", async () => {
  const fresh = await setup();
  const login = await call({ url: fresh.url, token: "" }, "POST", "/api/login", '{"password":"hunter2"}');
  const cookie = login.res.headers.get("set-cookie") ?? "";
  assert.match(cookie, /^hub_auth=[0-9a-f]{64}; Path=\/; Max-Age=2592000; HttpOnly; SameSite=Lax$/);
  const got = await call({ url: fresh.url, token: "" }, "GET", "/api/targets", undefined, {
    Cookie: cookie.split(";")[0] ?? "",
  });
  assert.equal(got.status, 200);
});

test("the token is derived from the password", async () => {
  const { body } = await call({ url: e.url, token: "" }, "POST", "/api/login", '{"password":"hunter2"}');
  assert.equal(body["token"], "2c21a219a581f92d5b4355f1c4a02542d0655fedca18b08c5f21bfdb3e94a50f");
});

test("a command fans out to the room", async () => {
  const cmd = await call(
    e,
    "POST",
    "/api/targets/room/command",
    '{"on":true,"brightness":60,"clientId":"phone","revision":3}',
  );
  assert.deepEqual([cmd.status, cmd.body], [200, { failed: {} }]);
  for (const l of [e.a, e.b]) {
    assert.deepEqual(l.s, { on: true, brightness: 60, colorTemperaturePct: 0 });
  }
  const st = await call(e, "GET", "/api/targets/room/state");
  assert.equal(st.status, 200);
  assert.equal((st.body["state"] as State).brightness, 60);
  assert.equal(Object.keys(st.body["devices"] as Json).length, 2);
  assert.deepEqual(st.body["failed"], {});
});

test("targets list each device and room", async () => {
  const { body } = await call(e, "GET", "/api/targets");
  assert.deepEqual(body["targets"], [
    { id: "a", name: "a", kind: "test", features: { brightness: true, colorTemperature: true, color: true } },
    { id: "b", name: "b", kind: "test", features: { brightness: true, colorTemperature: true, color: true } },
    {
      id: "room",
      name: "Room",
      kind: "room",
      features: { brightness: true, colorTemperature: true, color: true },
      members: ["a", "b"],
    },
  ]);
});

test("partial failure is a 200 that names the failed devices", async () => {
  const fresh = await setup();
  fresh.b.err = new Error("govee: HTTP 401");
  const { status, body } = await call(fresh, "POST", "/api/targets/room/command", '{"on":true}');
  assert.equal(status, 200);
  assert.deepEqual(body, { failed: { b: "govee: HTTP 401" } });
});

test("bad requests", async () => {
  const cases: [string, string, number][] = [
    ["/api/targets/room/command", '{"brightnes":50}', 400],
    ["/api/targets/room/command", '{"on":1}', 400],
    ["/api/targets/room/command", '{"brightness":0}', 400],
    ["/api/targets/room/command", '{"brightness":50.5}', 400],
    ["/api/targets/room/command", '{"color":"red"}', 400],
    ["/api/targets/room/command", "{}", 400],
    ["/api/targets/room/command", "[]", 400],
    ["/api/targets/room/command", "{", 400],
    ["/api/targets/nope/command", '{"on":true}', 404],
    ["/api/matter/commission", "{}", 400],
  ];
  for (const [path, body, want] of cases) {
    const got = await call(e, "POST", path, body);
    assert.equal(got.status, want, `${path} ${body}: ${JSON.stringify(got.body)}`);
    assert.equal(typeof got.body["error"], "string");
  }
  assert.equal((await call(e, "GET", "/api/targets/room/command")).status, 405);
  assert.equal((await call(e, "GET", "/api/targets/%E0%A4%A/state")).status, 400);
});

test("sync", async () => {
  const fresh = await setup();
  fresh.a.s = { on: true, brightness: 40, colorTemperaturePct: 0 };
  fresh.b.s = { on: false, brightness: 0, colorTemperaturePct: 0 };
  const body = '{"clientId":"phone","revision":1,"on":true,"brightness":40}';
  let res = await call(fresh, "POST", "/api/targets/room/sync", body);
  assert.equal(res.status, 200);
  assert.equal(res.body["synchronized"], false);
  assert.deepEqual((res.body["corrected"] as Json)["b"], ["on", "brightness"]);
  res = await call(fresh, "POST", "/api/targets/room/sync", body);
  assert.deepEqual(res.body, {
    synchronized: true,
    stale: false,
    corrected: {},
    failed: {},
    observed: {
      a: { on: true, brightness: 40, colorTemperaturePct: 0 },
      b: { on: true, brightness: 40, colorTemperaturePct: 0 },
    },
  });
});

test("matter endpoints", async () => {
  const fresh = await setup();
  let res = await call(fresh, "POST", "/api/matter/commission", '{"code":"MT:Y.K90AFN00KA0648G00","networkOnly":true}');
  assert.equal(res.status, 200);
  assert.equal(fresh.matter.code, "MT:Y.K90AFN00KA0648G00");
  // The phone apps read node.node_id.
  assert.equal((res.body["node"] as Json)["node_id"], 5);
  res = await call(fresh, "GET", "/api/matter/nodes");
  assert.deepEqual(res.body, {
    nodes: [
      {
        nodeId: 1,
        available: true,
        isBridge: false,
        lightEndpoints: [1],
        vendor: "Acme",
        product: null,
        label: null,
        lastSeen: null,
        uptimeSeconds: null,
        uptimeObservedAt: null,
        type: "Unknown",
        capabilities: ["Power"],
      },
    ],
  });
  res = await call(fresh, "GET", "/api/matter/discover");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body["devices"], await fresh.matter.discover());
  assert.equal((await call({ url: fresh.url, token: "" }, "GET", "/api/matter/discover")).status, 401);
  assert.equal((await call(fresh, "DELETE", "/api/matter/nodes/abc")).status, 400);
  assert.equal((await call(fresh, "DELETE", "/api/matter/nodes/7")).status, 200);
  fresh.matter.err = new MatterError("pairing failed");
  assert.equal((await call(fresh, "GET", "/api/matter/discover")).status, 502);
  assert.equal((await call(fresh, "POST", "/api/matter/thread", '{"dataset":"0e08"}')).status, 502);
  fresh.matter.err = new DOMException("timed out", "TimeoutError");
  assert.equal((await call(fresh, "POST", "/api/matter/commission", '{"code":"1"}')).status, 504);
  fresh.matter.ready = false;
  assert.equal((await call(fresh, "GET", "/api/matter/discover")).status, 503);
  res = await call(fresh, "POST", "/api/matter/wifi", '{"ssid":"home","password":"x"}');
  assert.equal(res.status, 503);
  assert.equal(res.body["error"], "Matter controller is not running");
  res = await call(fresh, "GET", "/healthz");
  assert.deepEqual(res.body, { ok: true, matterConnected: false });
});

test("Matter renaming returns the saved name and leaves contact timestamps unchanged", async () => {
  const fresh = await setup();
  const result = await call(fresh, "PATCH", "/api/matter/nodes/1/name", '{"name":" coffee-table "}');
  assert.equal(result.status, 200);
  const node = result.body["node"] as NodeSummary;
  assert.equal(node.label, "coffee-table");
  assert.equal(node.lastSeen, null);
  const listing = await call(fresh, "GET", "/api/matter/nodes");
  assert.equal((listing.body["nodes"] as NodeSummary[])[0]?.label, "coffee-table");
});

test("Matter rename validates the name and node and rejects cross-site requests", async () => {
  const fresh = await setup();
  assert.equal((await call(fresh, "PATCH", "/api/matter/nodes/999/name", '{"name":"Desk"}')).status, 404);
  for (const name of ["", "   ", "x".repeat(81)]) {
    assert.equal((await call(fresh, "PATCH", "/api/matter/nodes/1/name", JSON.stringify({ name }))).status, 400);
  }
  assert.equal(
    (await call({ url: fresh.url, token: "" }, "PATCH", "/api/matter/nodes/1/name", '{"name":"Desk"}')).status,
    401,
  );
  assert.equal(
    (await call(fresh, "PATCH", "/api/matter/nodes/1/name", '{"name":"Desk"}', { Origin: "https://other.example" }))
      .status,
    403,
  );
  assert.equal(fresh.matter.names.size, 0);
});

test("selected-device registration normalizes the code and lists the paired node", async () => {
  const fresh = await setup();
  const response = await call(
    fresh,
    "POST",
    "/api/matter/register",
    JSON.stringify({ code: "1234-567-8901", instanceName: "lamp" }),
  );
  assert.equal(response.status, 201);
  assert.equal(fresh.matter.code, "12345678901");
  assert.equal(fresh.matter.instanceName, "lamp");
  assert.equal((response.body["node"] as Json)["node_id"], 5);
  const listing = await call(fresh, "GET", "/api/matter/nodes");
  assert.ok((listing.body["nodes"] as NodeSummary[]).some((node) => node.nodeId === 5));
});

test("registration requires authentication, a selected device, and same-origin browser requests", async () => {
  const fresh = await setup();
  const body = JSON.stringify({ code: "private-code", instanceName: "lamp" });
  assert.equal((await call({ url: fresh.url, token: "" }, "POST", "/api/matter/register", body)).status, 401);
  assert.equal((await call(fresh, "POST", "/api/matter/register", '{"code":"private-code"}')).status, 400);
  assert.equal(
    (await call(fresh, "POST", "/api/matter/register", body, { "Sec-Fetch-Site": "cross-site" })).status,
    403,
  );
  assert.equal(
    (await call(fresh, "POST", "/api/matter/register", body, { Origin: "https://other.example" })).status,
    403,
  );
  assert.equal(fresh.matter.code, "");
});

test("registration failures redact setup codes and keep the error status", async () => {
  const fresh = await setup();
  fresh.matter.err = new MatterError("cannot pair with 12345678901 or 1234-567-8901");
  const result = await call(
    fresh,
    "POST",
    "/api/matter/register",
    JSON.stringify({ code: "1234-567-8901", instanceName: "lamp" }),
  );
  assert.equal(result.status, 502);
  assert.equal(JSON.stringify(result.body).includes("12345678901"), false);
  assert.equal(JSON.stringify(result.body).includes("1234-567-8901"), false);
  assert.match(String(result.body["error"]), /redacted/);
});

test("login is rate limited", async () => {
  const fresh = await setup();
  const anon = { url: fresh.url, token: "" };
  for (let i = 0; i < 5; i++) {
    assert.equal((await call(anon, "POST", "/api/login", '{"password":"guess"}')).status, 401);
  }
  // Even the right password is refused while locked out.
  const res = await call(anon, "POST", "/api/login", '{"password":"hunter2"}');
  assert.equal(res.status, 429);
  assert.ok(["900", "901"].includes(res.res.headers.get("retry-after") ?? ""), "Retry-After is the rest of 15 minutes");
  // Signed-in clients keep working.
  assert.equal((await call(fresh, "GET", "/api/targets")).status, 200);
});

test("tunnel clients are limited separately", async () => {
  const fresh = await setup();
  const login = async (ip: string, password: string) =>
    (
      await call({ url: fresh.url, token: "" }, "POST", "/api/login", JSON.stringify({ password }), {
        "CF-Connecting-IP": ip,
      })
    ).status;
  for (let i = 0; i < 5; i++) {
    await login("203.0.113.1", "guess");
  }
  assert.equal(await login("203.0.113.1", "hunter2"), 429, "attacker not blocked");
  assert.equal(await login("198.51.100.7", "hunter2"), 200, "another tunnel client blocked");
});

const accountPassword = "correct horse battery";

/** Creates an invite as the owner, joins with it, and signs in, returning the new account's session token. */
async function joinAs(env: Env, username: string): Promise<string> {
  const invite = await call(env, "POST", "/api/invites", "{}");
  assert.equal(invite.status, 201);
  const token = invite.body["token"] as string;
  const anon = { url: env.url, token: "" };
  assert.equal((await call(anon, "POST", "/api/invites/check", JSON.stringify({ token }))).status, 200);
  const joined = await call(anon, "POST", "/api/join", JSON.stringify({ token, username, password: accountPassword }));
  assert.equal(joined.status, 201);
  const account = joined.body["account"] as Json;
  assert.equal(account["username"], username);
  assert.deepEqual(account["scopes"], []);
  assert.equal(joined.res.headers.get("set-cookie"), null, "joining leaves the browser's session alone");
  const login = await call(anon, "POST", "/api/login", JSON.stringify({ username, password: accountPassword }));
  const cookie = login.res.headers.get("set-cookie") ?? "";
  assert.match(cookie, /^hub_auth=[\w-]{43}; Path=\/; Max-Age=2592000; HttpOnly; SameSite=Lax$/);
  return login.body["token"] as string;
}

test("accounts with every scope still can't manage accounts or invites", async () => {
  const env = await setup();
  const session = { url: env.url, token: await joinAs(env, "trusted") };
  const all = JSON.stringify({ scopes: ["lights", "devices", "manage"] });
  assert.equal(
    (await call(env, "PUT", "/api/accounts/TRUSTED/scopes", all)).status,
    200,
    "usernames in paths ignore case",
  );
  for (const [method, path, body] of [
    ["PUT", "/api/accounts/trusted/scopes", all],
    ["GET", "/api/accounts", undefined],
    ["POST", "/api/invites", "{}"],
    ["GET", "/api/invites", undefined],
  ] as const) {
    assert.equal((await call(session, method, path, body)).status, 403, `${method} ${path}`);
  }
  assert.equal((await call(session, "GET", "/api/targets")).status, 200);
});

test("sign-in refuses cross-site requests and ends the session it replaces", async () => {
  const env = await setup();
  const first = { url: env.url, token: await joinAs(env, "switcher") };
  const anon = { url: env.url, token: "" };
  const body = JSON.stringify({ username: "switcher", password: accountPassword });
  const crossSite = await call(anon, "POST", "/api/login", body, { Origin: "https://evil.example" });
  assert.equal(crossSite.status, 403);
  assert.equal((await call(first, "POST", "/api/logout", "{}", { Origin: "https://evil.example" })).status, 403);
  assert.equal((await call(first, "POST", "/api/login", body)).status, 200);
  assert.equal((await call(first, "GET", "/api/session")).status, 401, "the replaced session ended");
});

test("an account's sign-in does not clear failed hub password guesses", async () => {
  const env = await setup();
  await joinAs(env, "guesser");
  const anon = { url: env.url, token: "" };
  const guess = () => call(anon, "POST", "/api/login", JSON.stringify({ password: "guess" }));
  for (let i = 0; i < 4; i++) assert.equal((await guess()).status, 401);
  const own = await call(
    anon,
    "POST",
    "/api/login",
    JSON.stringify({ username: "guesser", password: accountPassword }),
  );
  assert.equal(own.status, 200);
  assert.equal((await guess()).status, 401);
  assert.equal((await guess()).status, 429, "five failed guesses block the next one");
});

test("invited accounts start with no access and gain only granted scopes", async () => {
  const env = await setup();
  const session = { url: env.url, token: await joinAs(env, "guest") };
  assert.deepEqual((await call(session, "GET", "/api/session")).body, { owner: false, username: "guest", scopes: [] });
  for (const [method, path] of [
    ["GET", "/api/targets"],
    ["POST", "/api/targets/room/command"],
    ["GET", "/api/manage"],
    ["GET", "/api/matter/nodes"],
    ["GET", "/api/accounts"],
    ["POST", "/api/invites"],
  ] as const) {
    const result = await call(session, method, path, method === "POST" ? "{}" : undefined);
    assert.equal(result.status, 403, `${method} ${path}`);
  }
  assert.match((await call(session, "GET", "/api/targets")).body["error"] as string, /does not have access to Lights/);

  const granted = await call(env, "PUT", "/api/accounts/guest/scopes", JSON.stringify({ scopes: ["lights"] }));
  assert.equal(granted.status, 200);
  assert.deepEqual((granted.body["account"] as Json)["scopes"], ["lights"]);
  assert.equal((await call(session, "GET", "/api/targets")).status, 200, "grant applies to the open session");
  assert.equal((await call(session, "POST", "/api/targets/room/command", JSON.stringify({ on: true }))).status, 200);
  assert.equal((await call(session, "GET", "/api/manage")).status, 403);

  const unknown = await call(env, "PUT", "/api/accounts/guest/scopes", JSON.stringify({ scopes: ["admin"] }));
  assert.equal(unknown.status, 400, "unknown scopes are refused");
  assert.equal((await call(env, "PUT", "/api/accounts/guest/scopes", '{"scopes":[]}')).status, 200);
  assert.equal((await call(session, "GET", "/api/targets")).status, 403, "revoking applies immediately");
});

test("accounts sign in with a username, sign out, and lose their sessions when deleted", async () => {
  const env = await setup();
  await joinAs(env, "visitor");
  const anon = { url: env.url, token: "" };
  const login = (body: Json) => call(anon, "POST", "/api/login", JSON.stringify(body));
  assert.equal((await login({ username: "visitor", password: "wrong password!" })).status, 401);
  assert.equal((await login({ password: accountPassword })).status, 401, "an account password is not the hub password");
  const signedIn = await login({ username: "Visitor", password: accountPassword });
  assert.equal(signedIn.status, 200, "usernames are case-insensitive");
  const session = { url: env.url, token: signedIn.body["token"] as string };
  assert.equal((await call(session, "GET", "/api/session")).status, 200);
  assert.equal((await call(session, "POST", "/api/logout", "{}")).status, 200);
  assert.equal((await call(session, "GET", "/api/session")).status, 401, "sign-out ends the session");

  const other = {
    url: env.url,
    token: (await login({ username: "visitor", password: accountPassword })).body["token"] as string,
  };
  const listed = (await call(env, "GET", "/api/accounts")).body["accounts"] as Json[];
  assert.deepEqual(
    listed.map((account) => [account["username"], account["scopes"]]),
    [["visitor", []]],
  );
  assert.equal((await call(env, "DELETE", "/api/accounts/visitor")).status, 200);
  assert.equal((await call(other, "GET", "/api/session")).status, 401, "deleting signs the account out");
  assert.equal((await call(env, "DELETE", "/api/accounts/visitor")).status, 404);
});

test("invites are single-use, revocable, and owner-only", async () => {
  const env = await setup();
  const anon = { url: env.url, token: "" };
  assert.equal((await call(anon, "POST", "/api/invites", "{}")).status, 401);
  const created = await call(env, "POST", "/api/invites", "{}");
  const token = created.body["token"] as string;
  const id = (created.body["invite"] as Json)["id"] as string;
  const pending = (await call(env, "GET", "/api/invites")).body["invites"] as Json[];
  assert.deepEqual(
    pending.map((invite) => invite["id"]),
    [id],
  );
  const join = (username: string, password = accountPassword, headers: Record<string, string> = {}) =>
    call(anon, "POST", "/api/join", JSON.stringify({ token, username, password }), headers);
  assert.equal((await join("x")).status, 400, "short usernames are refused");
  assert.equal((await join("valid-name", "short")).status, 400, "short passwords are refused");
  assert.equal(
    (await join("first", accountPassword, { Origin: "https://evil.example" })).status,
    403,
    "cross-site joins are refused",
  );
  assert.equal((await join("first")).status, 201);
  assert.equal((await join("second")).status, 404, "an invite works once");
  assert.equal((await call(anon, "POST", "/api/invites/check", JSON.stringify({ token }))).status, 404);
  assert.deepEqual((await call(env, "GET", "/api/invites")).body["invites"], []);

  const taken = (await call(env, "POST", "/api/invites", "{}")).body["token"] as string;
  const duplicate = await call(
    anon,
    "POST",
    "/api/join",
    JSON.stringify({ token: taken, username: "FIRST", password: accountPassword }),
  );
  assert.equal(duplicate.status, 409, "usernames are unique regardless of case");
  const kept = await call(anon, "POST", "/api/invites/check", JSON.stringify({ token: taken }));
  assert.equal(kept.status, 200, "a failed join keeps the invite");

  const revoked = await call(env, "POST", "/api/invites", "{}");
  const revokedId = (revoked.body["invite"] as Json)["id"] as string;
  assert.equal((await call(env, "DELETE", `/api/invites/${revokedId}`)).status, 200);
  const check = await call(anon, "POST", "/api/invites/check", JSON.stringify({ token: revoked.body["token"] }));
  assert.equal(check.status, 404);
});

test("the owner session reports every scope", async () => {
  const body = (await call(e, "GET", "/api/session")).body;
  assert.deepEqual(body, { owner: true, username: null, scopes: ["lights", "devices", "manage"] });
});

test("account pages are public", async () => {
  for (const path of ["/invite", "/invite/app.js", "/join", "/join/app.js", "/permissions", "/permissions/app.js"]) {
    assert.equal((await fetch(e.url + path)).status, 200, path);
  }
  for (const path of ["/home/accounts.js", "/home/accounts.css"]) {
    assert.equal((await fetch(e.url + path)).status, 200, path);
  }
});

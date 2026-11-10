import assert from "node:assert/strict";
import { before, test } from "node:test";
import { Api } from "./api.js";
import { allFeatures, type Command, type Device, type Features, type State } from "./device.js";
import { Group } from "./group.js";
import { Hub } from "./hub.js";
import { silentLog } from "./log.js";
import { MatterError, type CommissionedNode, type MatterAdmin, type NodeSummary } from "./matter/nodes.js";
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

  nodes(): NodeSummary[] {
    return [
      { nodeId: 1, available: true, isBridge: false, lightEndpoints: [1], vendor: "Acme", product: null, label: null },
    ];
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
}

type Json = Record<string, unknown>;

async function setup(): Promise<Env> {
  const a = new Light("a");
  const b = new Light("b");
  const matter = new FakeMatter();
  const hub = new Hub();
  hub.addDevice("test", a);
  hub.addDevice("test", b);
  hub.addRoom(new Group("room", "Room", [a, b]));
  const url = await serve(new Api(hub, matter, "hunter2", silentLog).handle);
  const { status, body } = await call({ url, token: "" }, "POST", "/api/login", '{"password":"hunter2"}');
  assert.equal(status, 200);
  return { url, token: body["token"] as string, a, b, matter };
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
  assert.deepEqual([cmd.status, cmd.body], [200, { ok: true }]);
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

test("partial failure is a 502 with details", async () => {
  const fresh = await setup();
  fresh.b.err = new Error("govee: HTTP 401");
  const { status, body } = await call(fresh, "POST", "/api/targets/room/command", '{"on":true}');
  assert.equal(status, 502);
  assert.deepEqual(body, { ok: false, failed: { b: "govee: HTTP 401" } });
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
      { nodeId: 1, available: true, isBridge: false, lightEndpoints: [1], vendor: "Acme", product: null, label: null },
    ],
  });
  assert.equal((await call(fresh, "DELETE", "/api/matter/nodes/abc")).status, 400);
  assert.equal((await call(fresh, "DELETE", "/api/matter/nodes/7")).status, 200);
  fresh.matter.err = new MatterError("pairing failed");
  assert.equal((await call(fresh, "POST", "/api/matter/thread", '{"dataset":"0e08"}')).status, 502);
  fresh.matter.err = new DOMException("timed out", "TimeoutError");
  assert.equal((await call(fresh, "POST", "/api/matter/commission", '{"code":"1"}')).status, 504);
  fresh.matter.ready = false;
  res = await call(fresh, "POST", "/api/matter/wifi", '{"ssid":"home","password":"x"}');
  assert.equal(res.status, 503);
  assert.equal(res.body["error"], "Matter controller is not running");
  res = await call(fresh, "GET", "/healthz");
  assert.deepEqual(res.body, { ok: true, matterConnected: false });
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

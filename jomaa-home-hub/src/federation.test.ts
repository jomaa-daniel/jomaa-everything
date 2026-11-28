import assert from "node:assert/strict";
import { test } from "node:test";
import { Api, sessionToken } from "./api.js";
import { Accounts, type Grant } from "./accounts.js";
import { Clicks } from "./clicks.js";
import { allFeatures, type Command, type Device, type Features, type State } from "./device.js";
import { Federation, delegationHeader } from "./federation.js";
import { Hub } from "./hub.js";
import { silentLog } from "./log.js";
import { MatterNotReadyError, type MatterAdmin } from "./matter/nodes.js";
import { catalog, type NodeCatalog } from "./nodes.js";
import { HealthStore } from "./health/store.js";
import { Organization } from "./organization.js";
import { serve } from "./testing.js";

const ownerPassword = "fixture owner password";
const guestPassword = "fixture guest password";
const key = "fixture-node-key-with-at-least-thirty-two-characters";
const other = {
  id: "remote",
  name: "Remote",
  enabled: true,
  mode: "node" as const,
  hostname: "remote.example.org",
  tunnelName: "remote",
  secretEnv: "REMOTE_KEY",
  deploySecret: "REMOTE_DEPLOY_KEY",
  scopes: ["lights"] as const,
  publicRoutes: [["GET", "/healthz"]] as [string, string][],
  modules: ["hub"],
  moduleOverrides: {},
};
const gatewayConfig = catalog.nodes[0];
assert.ok(gatewayConfig);
const config: NodeCatalog = {
  ...catalog,
  nodes: [
    { ...gatewayConfig, id: "gateway" },
    { ...other, scopes: ["lights"] },
  ],
  defaultNode: "gateway",
};

class Lamp implements Device {
  readonly id = "lamp";
  readonly name = "Lamp";
  current: State = { on: false, brightness: 50, colorTemperaturePct: 50 };
  apply(command: Command): Promise<void> {
    this.current = {
      on: command.on ?? this.current.on,
      brightness: command.brightness ?? this.current.brightness,
      colorTemperaturePct: command.colorTemperaturePct ?? this.current.colorTemperaturePct,
    };
    return Promise.resolve();
  }
  state(): Promise<State> {
    return Promise.resolve(this.current);
  }
  features(): Features {
    return allFeatures;
  }
}
const noMatter: MatterAdmin = {
  ready: false,
  nodes: () => [],
  discover: () => Promise.reject(new MatterNotReadyError()),
  register: () => Promise.reject(new MatterNotReadyError()),
  rename: () => Promise.reject(new MatterNotReadyError()),
  commission: () => Promise.reject(new MatterNotReadyError()),
  setWiFiCredentials: () => Promise.reject(new MatterNotReadyError()),
  setThreadDataset: () => Promise.reject(new MatterNotReadyError()),
  removeNode: () => Promise.reject(new MatterNotReadyError()),
};

async function setup(data: NodeCatalog = structuredClone(config)) {
  const localLamp = new Lamp();
  const remoteLamp = new Lamp();
  const make = (lamp: Lamp, federation: Federation, accounts: Accounts) => {
    const hub = new Hub();
    hub.addDevice("test", lamp);
    return new Api(
      hub,
      noMatter,
      ownerPassword,
      accounts,
      new Clicks(":memory:"),
      silentLog,
      {
        health: new HealthStore(":memory:"),
        layoutPath: null,
        organization: new Organization(":memory:"),
        secrets: null,
        picos: null,
      },
      federation,
    );
  };
  const remote = new Federation(data, "remote", { REMOTE_KEY: key });
  const remoteURL = await serve(make(remoteLamp, remote, new Accounts(":memory:")).handle);
  const forwarded: { url: string; init: RequestInit }[] = [];
  const transport: typeof fetch = (url, init) => {
    const request = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    const options = init ?? {};
    forwarded.push({ url: request, init: options });
    const path = new URL(request).pathname + new URL(request).search;
    return fetch(remoteURL + path, options);
  };
  const accounts = new Accounts(":memory:");
  const gateway = new Federation(data, "gateway", { REMOTE_KEY: key }, transport);
  const gatewayURL = await serve(make(localLamp, gateway, accounts).handle);
  const call = (path: string, token: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) =>
    fetch(gatewayURL + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...headers,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const destinations = new Map<string, { href: string; name: string }[]>();
  const guest = async (name: string, grants: Grant[]) => {
    const invite = await call("/api/invites", sessionToken(ownerPassword), "POST", { grants });
    assert.equal(invite.status, 201);
    const { token } = (await invite.json()) as { token: string };
    const response = await call("/api/join", "", "POST", { token, username: name, password: guestPassword });
    assert.equal(response.status, 201);
    const joined = (await response.json()) as {
      account: { grants: Grant[] };
      destinations: { href: string; name: string }[];
    };
    assert.deepEqual(joined.account.grants, grants);
    destinations.set(name, joined.destinations);
    const login = await call("/api/login", "", "POST", { username: name, password: guestPassword });
    return ((await login.json()) as { token: string }).token;
  };
  return { call, guest, accounts, remoteURL, gatewayURL, localLamp, remoteLamp, remote, forwarded, destinations };
}

test("invites route Bob to one home and Sally to the other, with immediate revocation", async () => {
  const env = await setup();
  const bob = await env.guest("bob", [{ node: "remote", scopes: ["lights"] }]);
  const sally = await env.guest("sally", [{ node: "gateway", scopes: ["lights"] }]);
  assert.deepEqual(env.destinations.get("bob"), [{ href: "/lights", name: "Lights" }]);
  assert.deepEqual(env.destinations.get("sally"), [{ href: "/lights", name: "Lights" }]);
  const command = "/api/targets/lamp/command";
  assert.equal((await env.call(command, bob, "POST", { on: true })).status, 200);
  assert.equal(env.remoteLamp.current.on, true);
  assert.equal(env.localLamp.current.on, false);
  assert.equal((await env.call(command, sally, "POST", { brightness: 20 })).status, 200);
  assert.equal(env.localLamp.current.brightness, 20);
  assert.equal(env.remoteLamp.current.brightness, 50);
  const count = env.forwarded.length;
  assert.equal((await env.call(command + "?node=gateway", bob, "POST", { on: true })).status, 400);
  assert.equal((await env.call(command + "?node=remote", sally, "POST", { on: true })).status, 400);
  assert.equal((await env.call(command, bob, "POST", { on: false }, { Origin: "https://evil.example" })).status, 403);
  assert.equal(env.forwarded.length, count);
  for (const path of [
    "/api/manage",
    "/api/devices",
    "/api/secrets",
    "/api/accounts",
    "/api/matter/nodes",
    "/api/picos",
  ])
    assert.equal((await env.call(path, bob)).status, 403, path);
  assert.deepEqual(((await (await env.call("/api/nodes", bob)).json()) as { nodes: unknown }).nodes, [
    { id: "remote", name: "Remote", scopes: ["lights"] },
  ]);
  env.accounts.setGrants("bob", []);
  assert.equal((await env.call(command, bob, "POST", { on: false })).status, 403);
  assert.equal(env.remoteLamp.current.on, true);
});

test("direct node requests cannot bypass its capability gate, including pages and device reports", async () => {
  const env = await setup();
  for (const [method, path] of [
    ["GET", "/"],
    ["GET", "/lights"],
    ["GET", "/manage"],
    ["GET", "/accounts"],
    ["GET", "/secrets"],
    ["GET", "/api/targets"],
    ["GET", "/api/devices"],
    ["POST", "/api/devices/pico/health"],
    ["GET", "/api/secrets"],
    ["POST", "/api/login"],
    ["POST", "/api/join"],
    ["POST", "/api/matter/commission"],
    ["GET", "/unknown"],
  ] as const) {
    const response = await fetch(env.remoteURL + path, {
      method,
      headers: { Authorization: `Bearer ${sessionToken(ownerPassword)}` },
    });
    assert.equal(response.status, 403, `${method} ${path}`);
  }
  assert.equal((await fetch(env.remoteURL + "/healthz")).status, 200);
});

test("signatures bind URL, method, body and content type, expire, and refuse replay", async () => {
  const env = await setup();
  const bob = await env.guest("bob", [{ node: "remote", scopes: ["lights"] }]);
  assert.equal(
    (
      await env.call(
        "/api/targets/lamp/command",
        bob,
        "POST",
        { on: true },
        { Cookie: "hub_auth=private", "X-Forwarded-For": "secret" },
      )
    ).status,
    200,
  );
  const sent = env.forwarded.at(-1);
  assert.ok(sent);
  const headers = sent.init.headers as Record<string, string>;
  assert.deepEqual(Object.keys(headers).sort(), ["accept-encoding", "content-type", delegationHeader].sort());
  assert.equal(headers["accept-encoding"], "identity");
  assert.ok(!JSON.stringify(sent.init).includes(bob));
  assert.equal((await fetch(env.remoteURL + "/api/targets/lamp/command", sent.init)).status, 403, "replayed command");
  assert.equal((await fetch(env.remoteURL + "/api/targets/lamp/sync", sent.init)).status, 403, "changed URL");
  assert.equal(
    (await fetch(env.remoteURL + "/api/targets/lamp/command", { ...sent.init, body: '{"on":false}' })).status,
    403,
    "changed body",
  );
  assert.equal(
    (
      await fetch(env.remoteURL + "/api/targets/lamp/command", {
        ...sent.init,
        headers: { ...headers, "content-type": "text/plain" },
      })
    ).status,
    403,
    "changed content type",
  );
  assert.equal(
    (await fetch(env.remoteURL + "/api/targets/lamp/command", { ...sent.init, method: "GET", body: null })).status,
    403,
    "changed method",
  );
  env.remote.now = () => Date.now() + catalog.transport.delegationLifetimeSeconds * 1000;
  assert.equal((await env.call("/api/targets", bob)).status, 403, "expired delegation");
});

test("the same router forwards a different capability and rejects grants exceeding a node policy", async () => {
  const data = structuredClone(config);
  const remoteNode = data.nodes[1];
  assert.ok(remoteNode);
  remoteNode.scopes = ["manage"];
  const env = await setup(data);
  const bob = await env.guest("bob", [{ node: "remote", scopes: ["manage"] }]);
  assert.deepEqual(env.destinations.get("bob"), [{ href: "/manage?node=remote", name: "Devices · Remote" }]);
  assert.equal((await env.call("/api/manage", bob)).status, 200);
  assert.ok(env.forwarded[0]?.url.endsWith("/api/manage"));
  const owner = sessionToken(ownerPassword);
  for (const grants of [
    [{ node: "remote", scopes: ["lights"] }],
    [{ node: "missing", scopes: ["lights"] }],
    [
      { node: "remote", scopes: ["manage"] },
      { node: "remote", scopes: ["manage"] },
    ],
  ])
    assert.equal((await env.call("/api/invites", owner, "POST", { grants })).status, 400);
  assert.equal(
    (await env.call("/api/targets?node=remote", owner)).status,
    400,
    "owner cannot override account routing",
  );
});

test("different capabilities can use different assigned and request-selected nodes", async () => {
  const env = await setup();
  const bob = await env.guest("bob", [
    { node: "gateway", scopes: ["manage"] },
    { node: "remote", scopes: ["lights"] },
  ]);
  assert.equal((await env.call("/api/targets/lamp/command", bob, "POST", { brightness: 10 })).status, 200);
  assert.equal(env.remoteLamp.current.brightness, 10);
  assert.equal((await env.call("/api/manage?node=remote", bob)).status, 403);
  assert.equal((await env.call("/api/targets?node=remote&node=gateway", bob)).status, 400);
  const session = (await (await env.call("/api/session?node=remote", bob)).json()) as { scopes: string[] };
  assert.deepEqual(session.scopes, ["lights"]);
});

test("account lighting assignments reject multiple targets and change routing without a new session", async () => {
  const env = await setup();
  const owner = sessionToken(ownerPassword);
  const multiple = [
    { node: "gateway", scopes: ["lights"] },
    { node: "remote", scopes: ["lights"] },
  ];
  assert.equal((await env.call("/api/invites", owner, "POST", { grants: multiple })).status, 400);
  const bob = await env.guest("bob", [{ node: "remote", scopes: ["lights"] }]);
  assert.equal((await env.call("/api/accounts/bob/grants", owner, "PUT", { grants: multiple })).status, 400);
  assert.equal((await env.call("/api/targets/lamp/command", bob, "POST", { brightness: 20 })).status, 200);
  assert.equal(env.remoteLamp.current.brightness, 20);
  assert.equal(env.localLamp.current.brightness, 50);
  assert.equal(
    (await env.call("/api/accounts/bob/grants", owner, "PUT", { grants: [{ node: "gateway", scopes: ["lights"] }] }))
      .status,
    200,
  );
  assert.equal((await env.call("/api/targets/lamp/command", bob, "POST", { brightness: 30 })).status, 200);
  assert.equal(env.localLamp.current.brightness, 30);
  assert.equal(env.remoteLamp.current.brightness, 20);
  env.accounts.setGrants(
    "bob",
    multiple.map((grant) => ({ ...grant, scopes: ["lights"] })),
  );
  assert.equal((await env.call("/api/targets", bob)).status, 403, "ambiguous stored assignments fail closed");
});

test("account routing is a configurable policy for any capability", async () => {
  const data = structuredClone(config);
  data.routing.manage = "account";
  const remote = data.nodes[1];
  assert.ok(remote);
  remote.scopes = ["manage"];
  const env = await setup(data);
  const bob = await env.guest("bob", [{ node: "remote", scopes: ["manage"] }]);
  assert.equal((await env.call("/api/manage", bob)).status, 200);
  assert.equal((await env.call("/api/manage?node=gateway", bob)).status, 400);
  assert.deepEqual(env.destinations.get("bob"), [{ href: "/manage", name: "Devices" }]);
});

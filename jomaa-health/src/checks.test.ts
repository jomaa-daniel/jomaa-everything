import assert from "node:assert/strict";
import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { test } from "node:test";
import manifest from "../../jomaa-deploy/deploy.json" with { type: "json" };
import config from "../config.json" with { type: "json" };
import { runChecks, type Probe } from "./checks.ts";
import { renderPage } from "./page.ts";

const password = "correct horse battery";
const token = "session-token";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const page = (type: string) => new Response("<!doctype html><html></html>", { headers: { "Content-Type": type } });

const targets = [
  { id: "lamp", name: "Lamp", kind: "govee", features: {} },
  { id: "orb", name: "Orb", kind: "matter", features: {} },
  { id: "loose", name: "Loose bulb", kind: "govee", features: {} },
  { id: "living-room", name: "Living room", kind: "room", members: ["lamp", "orb"], features: {} },
];

/** A healthy jomaa.org, with overrides keyed by "METHOD url". */
function site(overrides: Record<string, () => Response> = {}) {
  const calls: string[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const method = init.method ?? "GET";
    const key = `${method} ${url}`;
    calls.push(key);
    const override = overrides[key];
    if (override) return override();
    const { hostname, pathname } = new URL(url);
    const auth = new Headers(init.headers).get("Authorization") === `Bearer ${token}`;
    if (hostname === "sarah.jomaa.org") return page("text/html");
    if (pathname === "/healthz") return json(200, { ok: true, matterConnected: true });
    if (pathname === "/") {
      return new Response(null, { status: 302, headers: { Location: hostname === "jomaa.org" ? "/home" : "/devices" } });
    }
    if (pathname === "/deploy") return json(403, { error: "unauthorized" });
    if (pathname === "/api/login" && method === "POST") {
      const body: unknown = JSON.parse(String(init.body));
      return body !== null && typeof body === "object" && "password" in body && body.password === password
        ? json(200, { token })
        : json(401, { error: "wrong password" });
    }
    if (pathname === "/api/logout" && method === "POST") return json(200, { ok: true });
    if (pathname.startsWith("/api/") && !auth) return json(401, { error: "sign in first" });
    if (pathname === "/api/targets") return json(200, { targets });
    if (pathname === "/api/targets/living-room/state") {
      return json(200, { state: {}, devices: { lamp: {}, orb: {} }, failed: {} });
    }
    if (pathname === "/api/targets/loose/state") return json(200, { state: {}, devices: { loose: {} }, failed: {} });
    if (pathname === "/api/manage") return json(200, { devices: [{}, {}], groups: [{}], types: [] });
    if (pathname === "/api/devices") {
      return json(200, { devices: [{ status: "online" }, { status: "revoked" }], matterNodes: [] });
    }
    if (pathname === "/api/matter/nodes") return json(200, { nodes: [{ available: true }] });
    if (pathname === "/api/matter/discover") return json(200, { devices: [] });
    if (/\.(css)$/.test(pathname)) return page("text/css; charset=utf-8");
    if (/\.(js)$/.test(pathname)) return page("text/javascript; charset=utf-8");
    return page("text/html; charset=utf-8");
  };
  const probe: Probe = {
    fetch,
    sshBanner: async () => "SSH-2.0-OpenSSH_9.9\r",
    password,
    now: () => 0,
  };
  return { probe, calls };
}

const byName = (report: Awaited<ReturnType<typeof runChecks>>, name: string) => {
  const result = report.results.find((r) => r.name === name);
  assert.ok(result, `missing check ${name}`);
  return result;
};

test("a healthy site passes every check", async () => {
  const { probe } = site();
  const report = await runChecks(probe);
  assert.deepEqual(
    report.results.filter((r) => r.status !== "ok"),
    [],
  );
  assert.equal(report.status, "ok");
});

test("every manifest route and static site is checked", async () => {
  const { probe, calls } = site();
  const report = await runChecks(probe);
  const hosts = new Set(report.results.map((r) => new URL(r.url).hostname));
  for (const route of manifest.routes) assert.ok(hosts.has(route.hostname), route.hostname);
  for (const host of config.staticSites) assert.ok(hosts.has(host), host);
  for (const route of manifest.routes) {
    if (!("probes" in route)) continue;
    for (const path of route.probes) assert.ok(calls.includes(`GET https://${route.hostname}${path}`), path);
  }
});

test("static sites match the site directories", () => {
  const root = new URL("../../jomaa-static-pages/", import.meta.url);
  const sites = readdirSync(root)
    .filter((name) => !name.startsWith(".") && name.includes("."))
    .filter((name) => {
      const path = new URL(name, root);
      return lstatSync(path).isDirectory() && statSync(new URL(`${name}/index.html`, root)).isFile();
    })
    .sort();
  assert.deepEqual([...config.staticSites].sort(), sites);
});

test("rooms are read once and devices outside rooms on their own", async () => {
  const { probe, calls } = site();
  await runChecks(probe);
  const states = new Set(calls.filter((c) => /^GET https:\/\/jomaa\.org\/api\/targets\/[^/]+\/state$/.test(c)));
  assert.ok(calls.includes("GET https://jomaa.org/api/targets/living-room/state"));
  assert.ok(calls.includes("GET https://jomaa.org/api/targets/loose/state"));
  assert.ok(!calls.includes("GET https://jomaa.org/api/targets/lamp/state"));
  assert.equal(states.size, 2);
});

test("a route answered by the tunnel instead of the hub fails", async () => {
  const { probe } = site({ "GET https://jomaa.org/lights": () => new Response(null, { status: 404 }) });
  const report = await runChecks(probe);
  const lights = byName(report, "/lights");
  assert.equal(lights.status, "fail");
  assert.match(lights.detail, /HTTP 404/);
  assert.equal(report.status, "fail");
});

test("a 401 that is not the hub's refusal fails", async () => {
  const { probe } = site({ "GET https://jomaa.org/api/manage": () => new Response("denied", { status: 401 }) });
  assert.equal(byName(await runChecks(probe), "/api/manage").status, "fail");
});

test("a disconnected Matter controller fails the hub health check", async () => {
  const { probe } = site({ "GET https://hub.jomaa.org/healthz": () => json(200, { ok: true, matterConnected: false }) });
  const health = byName(await runChecks(probe), "hub health");
  assert.equal(health.status, "fail");
  assert.equal(health.detail, "matterConnected is false, expected true");
});

test("devices that stop answering degrade instead of failing", async () => {
  const { probe } = site({
    "GET https://jomaa.org/api/targets/living-room/state": () =>
      json(200, { state: {}, devices: { lamp: {} }, failed: { orb: "timeout" } }),
    "GET https://jomaa.org/api/devices": () => json(200, { devices: [{ status: "offline" }], matterNodes: [] }),
  });
  const report = await runChecks(probe);
  assert.equal(byName(report, "State: Living room").status, "warn");
  assert.equal(byName(report, "State: Living room").detail, "1 of 2 devices answering");
  assert.equal(byName(report, "Health reporters").status, "warn");
  assert.equal(report.status, "warn");
});

test("a room with no answering device fails", async () => {
  const { probe } = site({
    "GET https://jomaa.org/api/targets/living-room/state": () =>
      json(200, { state: null, devices: {}, failed: { lamp: "x", orb: "y" } }),
  });
  assert.equal(byName(await runChecks(probe), "State: Living room").status, "fail");
});

test("a wrong password stops the API checks after sign-in", async () => {
  const { probe, calls } = site();
  const report = await runChecks({ ...probe, password: "wrong" });
  assert.equal(byName(report, "Sign in").status, "fail");
  assert.ok(!report.results.some((r) => r.name === "Targets"));
  assert.ok(!calls.includes("GET https://jomaa.org/api/targets"));
});

test("a missing password is reported without contacting the hub", async () => {
  const { probe, calls } = site();
  const report = await runChecks({ ...probe, password: "" });
  assert.match(byName(report, "Sign in").detail, /HUB_PASSWORD/);
  assert.ok(!calls.includes("POST https://jomaa.org/api/login"));
});

test("malformed API answers fail their check", async () => {
  const { probe } = site({ "GET https://jomaa.org/api/targets": () => json(200, { targets: [{ id: 1 }] }) });
  const report = await runChecks(probe);
  assert.equal(byName(report, "Targets").status, "fail");
  assert.equal(byName(report, "Sign out").status, "ok");
});

test("an unexpected SSH greeting and a network error fail", async () => {
  const { probe } = site({
    "GET https://sarah.jomaa.org/": () => {
      throw new TypeError("network connection lost");
    },
  });
  const report = await runChecks({ ...probe, sshBanner: async () => "HTTP/1.1 400 Bad Request" });
  assert.equal(byName(report, "SSH through the tunnel").status, "fail");
  const sarah = byName(report, "Static site");
  assert.equal(sarah.status, "fail");
  assert.equal(sarah.detail, "network connection lost");
});

test("a check that times out names its deadline", async () => {
  const { probe } = site();
  const report = await runChecks({
    ...probe,
    sshBanner: async () => {
      throw new DOMException("timed out", "TimeoutError");
    },
  });
  const ssh = byName(report, "SSH through the tunnel");
  assert.equal(ssh.status, "fail");
  assert.match(ssh.detail, /no answer within 10 s/);
});

test("the page escapes check output and shows the overall status", async () => {
  const { probe } = site({ "GET https://hub.jomaa.org/healthz": () => json(500, { error: "<script>" }) });
  const report = await runChecks(probe);
  const html = renderPage(
    { ...report, results: [...report.results, { ...report.results[0]!, detail: "<script>alert(1)</script>" }] },
    60,
  );
  assert.ok(!html.includes("<script>"));
  assert.match(html, /Part of jomaa.org is not working/);
});

test("config.md documents every setting in config.json and wrangler.jsonc", () => {
  const doc = readFileSync(new URL("../config.md", import.meta.url), "utf8");
  const keys = (value: unknown, prefix: string): string[] =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.entries(value).flatMap(([key, field]) => [prefix + key, ...keys(field, `${prefix}${key}.`)])
      : [];
  const wrangler: unknown = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
  for (const key of [...keys(config, ""), ...keys(wrangler, "")]) {
    assert.ok(doc.includes(`\`${key}\``), `config.md does not document ${key}`);
  }
});

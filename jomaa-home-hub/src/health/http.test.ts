import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as httpServer, request as httpRequest, type Server } from "node:http";
import { createServer, request } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Api, sessionToken } from "../api.js";
import { Hub } from "../hub.js";
import { Accounts } from "../accounts.js";
import { Clicks } from "../clicks.js";
import { silentLog } from "../log.js";
import type { MatterAdmin, NodeSummary } from "../matter/nodes.js";
import { HealthStore } from "./store.js";
import { settings } from "../settings.js";

const matter: MatterAdmin = {
  ready: false,
  nodes: () => [],
  discover: () => Promise.resolve([]),
  register: () => Promise.reject(new Error("unused")),
  rename: () => Promise.reject(new Error("unused")),
  commission: () => Promise.reject(new Error("unused")),
  setWiFiCredentials: () => Promise.resolve(),
  setThreadDataset: () => Promise.resolve(),
  removeNode: () => Promise.resolve(),
};
const close = (server: Server) =>
  new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
    server.closeAllConnections();
  });

await test("HTTPS API separates admin and device auth and persists authenticated health reports", async () => {
  const dir = mkdtempSync(join(tmpdir(), "health-tls-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
      "-keyout",
      join(dir, "key.pem"),
      "-out",
      join(dir, "cert.pem"),
    ],
    { stdio: "ignore" },
  );
  const ca = readFileSync(join(dir, "cert.pem"));
  const store = new HealthStore(join(dir, "health.sqlite"));
  const accounts = new Accounts(":memory:");
  const api = new Api(new Hub(), matter, "test-hub-password", accounts, new Clicks(":memory:"), silentLog, {
    health: store,
    layoutPath: null,
    organization: null,
    secrets: null,
    picos: null,
  });
  const secure = createServer({ cert: ca, key: readFileSync(join(dir, "key.pem")) }, api.handle);
  const insecure = httpServer(api.handle);
  await Promise.all([
    new Promise<void>((resolve) => {
      secure.listen(0, "127.0.0.1", resolve);
    }),
    new Promise<void>((resolve) => {
      insecure.listen(0, "127.0.0.1", resolve);
    }),
  ]);
  const port = (secure.address() as AddressInfo).port;
  const httpPort = (insecure.address() as AddressInfo).port;
  async function call(
    path: string,
    method = "GET",
    value?: unknown,
    token?: string,
    plain = false,
    extra: Record<string, string> = {},
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const bytes = value === undefined ? undefined : JSON.stringify(value);
      const req = (plain ? httpRequest : request)(
        {
          hostname: "127.0.0.1",
          servername: "localhost",
          ca,
          port: plain ? httpPort : port,
          path,
          method,
          headers: {
            ...extra,
            ...(bytes !== undefined && { "Content-Type": "application/json" }),
            ...(token && { Authorization: "Bearer " + token }),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            resolve({
              status: res.statusCode ?? 0,
              body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>,
            });
          });
        },
      );
      req.on("error", reject);
      req.end(bytes);
    });
  }
  try {
    const origin = `http://127.0.0.1:${httpPort}`;
    const landing = await fetch(origin + "/", { redirect: "manual" });
    assert.equal(landing.status, 302);
    assert.equal(landing.headers.get("location"), "/manage");
    const homeRedirect = await new Promise<{ status: number; location: string }>((resolve, reject) => {
      const req = httpRequest(
        { hostname: "127.0.0.1", port: httpPort, path: "/", headers: { Host: "jomaa.org" } },
        (res) => {
          res.resume();
          res.on("end", () => {
            resolve({ status: res.statusCode ?? 0, location: res.headers.location ?? "" });
          });
        },
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(homeRedirect.status, 302);
    assert.equal(homeRedirect.location, "/home");
    for (const [path, contentType] of [
      ["/home", "text/html"],
      ["/home/", "text/html"],
      ["/home/base.css", "text/css"],
      ["/home/style.css", "text/css"],
      ["/manage", "text/html"],
      ["/manage/health.js", "text/javascript"],
      ["/home/ui.css", "text/css"],
    ] as const) {
      const response = await fetch(origin + path);
      assert.equal(response.status, 200);
      assert.ok(response.headers.get("content-type")?.startsWith(contentType));
      assert.ok((await response.text()).length > 0);
    }
    const homeHead = await fetch(origin + "/home", { method: "HEAD" });
    assert.equal(homeHead.status, 200);
    assert.equal(await homeHead.text(), "");
    const admin = sessionToken("test-hub-password");
    assert.equal((await call("/api/devices")).status, 401);
    await accounts.join(accounts.createInvite().token, "guest", "a long enough password");
    const guest = accounts.createSession("guest");
    assert.equal((await call("/api/devices", "GET", undefined, guest)).status, 403, "accounts start without access");
    assert.equal((await call("/api/devices/enroll", "POST", { id: "x", name: "X" }, guest)).status, 403);
    accounts.setScopes("guest", ["devices"]);
    assert.equal((await call("/api/devices", "GET", undefined, guest)).status, 200, "the devices scope grants access");
    const issued = await call("/api/devices/enroll", "POST", { id: "pico-api", name: "API Pico" }, admin);
    assert.equal(issued.status, 201);
    const token = issued.body["token"];
    assert.ok(typeof token === "string");
    assert.equal((await call("/api/devices", "GET", undefined, token)).status, 401);
    const ping = {
      bootId: "abcdef0123456789",
      sequence: 0,
      firmware: "test/1",
      uptimeSeconds: 20,
      freeHeapBytes: 90000,
      status: "healthy",
    };
    const path = "/api/devices/pico-api/health";
    assert.equal((await call(path, "POST", ping, admin)).status, 401);
    assert.equal((await call(path, "POST", ping, token, true)).status, 426);
    assert.equal((await call(path, "POST", { ...ping, extra: "typo" }, token)).status, 400);
    assert.equal((await call(path, "POST", ping, token)).status, 201);
    assert.equal((await call(path, "POST", ping, token)).body["duplicate"], true);
    assert.equal(store.logs("pico-api").logs.length, 1);
    const capture = {
      bootId: ping.bootId,
      sequence: 0,
      bus: 0,
      startUs: 0,
      endUs: 1000000,
      data: "a632001122",
      dropped: 0,
    };
    const capturePath = "/api/devices/pico-api/i2c";
    assert.equal((await call(capturePath, "POST", capture, admin)).status, 401);
    assert.equal((await call(capturePath, "POST", capture, token, true)).status, 426);
    assert.equal((await call(capturePath, "POST", capture, token)).status, 200);
    assert.equal((await call(capturePath, "POST", capture, token)).body["duplicate"], true);
    assert.equal((await call(capturePath, "GET", undefined, token)).status, 401);
    assert.equal((await call(capturePath, "GET", undefined, admin)).status, 200);
    assert.equal(store.i2c.logs("pico-api").logs[0]?.data, capture.data);
    const largeCaptures = 8;
    for (let sequence = 1; sequence <= largeCaptures; sequence++) {
      store.i2c.record("pico-api", {
        ...capture,
        sequence,
        startUs: sequence * 1000000,
        endUs: (sequence + 1) * 1000000,
        data: "aa".repeat(settings.i2c.maxDataBytes),
      });
    }
    let liveText = "";
    let snapshotReady: () => void = () => {};
    const snapshot = new Promise<void>((resolve) => {
      snapshotReady = resolve;
    });
    const liveDone = new Promise<void>((resolve, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          servername: "localhost",
          ca,
          port,
          path: capturePath + "/events",
          headers: { Authorization: "Bearer " + guest },
        },
        (res) => {
          assert.equal(res.statusCode, 200);
          res.on("data", (chunk: Buffer) => {
            liveText += chunk.toString();
            const start = liveText.indexOf("event: snapshot");
            if (start >= 0 && liveText.indexOf("\n\n", start) >= 0) snapshotReady();
          });
          res.on("end", resolve);
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      req.end();
    });
    await snapshot;
    assert.match(liveText, /a632001122/);
    accounts.setScopes("guest", []);
    await call(
      capturePath,
      "POST",
      {
        ...capture,
        sequence: largeCaptures + 1,
        startUs: (largeCaptures + 1) * 1000000,
        endUs: (largeCaptures + 2) * 1000000,
        data: "ffeedd",
      },
      token,
    );
    await liveDone;
    assert.match(liveText, /event: denied/);
    assert.ok(!liveText.includes("ffeedd"), "revoked viewers receive no new raw bytes");
    assert.equal((await call("/api/devices/pico-api", "PATCH", { name: "Updated" }, admin)).status, 200);
    assert.equal(store.get("pico-api").name, "Updated");
    assert.equal(
      (
        await call("/api/devices/pico-api", "PATCH", { name: "Attack" }, admin, false, {
          Origin: "https://attacker.invalid",
        })
      ).status,
      403,
    );
    assert.equal((await call("/api/devices/pico-api/logs?limit=500", "GET", undefined, admin)).status, 400);
    assert.equal((await call("/api/devices/pico-api/revoke", "POST", {}, admin)).status, 200);
    assert.equal((await call(path, "POST", ping, token)).status, 401);
    assert.equal((await call(capturePath, "POST", { ...capture, sequence: 1 }, token)).status, 401);
    assert.equal(store.logs("pico-api").logs.length, 1);
    await assert.rejects(
      new Promise<void>((resolve, reject) => {
        const req = request({ hostname: "127.0.0.1", servername: "localhost", port, path: "/healthz" }, () => {
          resolve();
        });
        req.on("error", reject);
        req.end();
      }),
      /self.signed|certificate/i,
    );
  } finally {
    await Promise.all([close(secure), close(insecure)]);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("device inventory includes registered Matter nodes without issuing Pico credentials", async () => {
  const nodes: NodeSummary[] = [];
  const controller: MatterAdmin = {
    ...matter,
    ready: true,
    nodes: () => nodes,
    register: () => {
      nodes.push({
        lastSeen: null,
        uptimeSeconds: null,
        uptimeObservedAt: null,
        type: "Unknown",
        capabilities: ["Power"],
        nodeId: 42,
        available: true,
        isBridge: false,
        lightEndpoints: [1],
        vendor: "Acme",
        product: "Lamp",
        label: "Desk",
      });
      return Promise.resolve({ node_id: 42, available: true, is_bridge: false });
    },
  };
  const store = new HealthStore(":memory:");
  const server = httpServer(
    new Api(
      new Hub(),
      controller,
      "inventory-test-password",
      new Accounts(":memory:"),
      new Clicks(":memory:"),
      silentLog,
      { health: store, layoutPath: null, organization: null, secrets: null, picos: null },
    ).handle,
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = {
    Authorization: `Bearer ${sessionToken("inventory-test-password")}`,
    "Content-Type": "application/json",
  };
  try {
    const registration = await fetch(origin + "/api/matter/register", {
      method: "POST",
      headers,
      body: JSON.stringify({ code: "12345678901", instanceName: "desk" }),
    });
    assert.equal(registration.status, 201);
    const response = await fetch(origin + "/api/devices", { headers });
    const inventory = (await response.json()) as {
      devices: unknown[];
      matterNodes: NodeSummary[];
      matterConnected: boolean;
    };
    assert.deepEqual(inventory.devices, []);
    assert.equal(inventory.matterConnected, true);
    assert.deepEqual(
      inventory.matterNodes,
      nodes.map((node) => ({ ...node, assignedType: null, groups: [], groupIds: [] })),
    );
    assert.equal(inventory.matterNodes[0]?.nodeId, 42);
    assert.deepEqual(store.list(), []);
  } finally {
    await close(server);
    store.close();
  }
});

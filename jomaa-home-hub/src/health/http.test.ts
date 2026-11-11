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
import { silentLog } from "../log.js";
import type { MatterAdmin } from "../matter/nodes.js";
import { HealthStore } from "./store.js";

const matter: MatterAdmin = {
  ready: false,
  nodes: () => [],
  discover: () => Promise.resolve([]),
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
  const api = new Api(new Hub(), matter, "test-hub-password", silentLog, store);
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
    assert.equal(landing.headers.get("location"), "/devices");
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
      ["/devices", "text/html"],
      ["/devices/app.js", "text/javascript"],
      ["/devices/style.css", "text/css"],
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

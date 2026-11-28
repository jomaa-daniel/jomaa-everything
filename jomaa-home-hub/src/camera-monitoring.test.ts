import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CameraMonitoring, parseMonitoringConfig } from "./camera-monitoring.js";
import { Cameras, parseCameraConfig } from "./cameras.js";
import { Api } from "./api.js";
import { Accounts } from "./accounts.js";
import { Clicks } from "./clicks.js";
import { Hub } from "./hub.js";
import { silentLog } from "./log.js";
import { catalog, type NodeCatalog } from "./nodes.js";
import { Federation, delegationHeader } from "./federation.js";
import { releaseRoot, settings } from "./settings.js";
import { serve } from "./testing.js";
import type { MatterAdmin } from "./matter/nodes.js";

const noMatter: MatterAdmin = {
  ready: false,
  nodes: () => [],
  discover: () => Promise.resolve([]),
  register: () => Promise.reject(new Error("unused")),
  rename: () => Promise.reject(new Error("unused")),
  commission: () => Promise.reject(new Error("unused")),
  setWiFiCredentials: () => Promise.resolve(),
  setThreadDataset: () => Promise.resolve(),
  removeNode: () => Promise.reject(new Error("unused")),
};
const ownerPassword = "monitoring fixture password";
const config = () => parseCameraConfig(readFileSync(new URL(settings.cameraConfigFile, releaseRoot), "utf8"));
const monitoringConfig = () =>
  parseMonitoringConfig(readFileSync(new URL(settings.cameraMonitoringConfigFile, releaseRoot), "utf8"));
const env = {
  CAMERA_1_SOURCE: "rtsp://user:private-secret@camera.example.org/live",
  CAMERA_2_SOURCE: "rtsp://fixture/live",
};
const now = 1800000000;

async function fixture() {
  const calls: { path: string; range: string | undefined }[] = [];
  const origin = await serve((req, res) => {
    assert.equal(req.headers.cookie, undefined);
    assert.equal(req.headers.authorization, undefined);
    const url = new URL(req.url ?? "/", "http://fixture");
    calls.push({ path: url.pathname, range: req.headers.range });
    res.setHeader("Content-Type", "application/json");
    const event = {
      id: "event-1",
      camera: "camera1",
      label: "person",
      start_time: now - 100,
      end_time: now - 10,
      has_snapshot: true,
      has_clip: true,
      thumbnail: "private-secret",
    };
    if (url.pathname === "/api/events") {
      assert.equal(url.searchParams.get("cameras"), "camera1");
      res.end(JSON.stringify([event, { ...event, id: "other", camera: "camera2" }]));
    } else if (url.pathname === "/api/review/activity/motion") {
      res.end(
        JSON.stringify([
          { camera: "camera1", start_time: now - 200, motion: 30 },
          { camera: "camera2", start_time: now - 200, motion: 30 },
          { camera: "camera1", start_time: now - 500, motion: 0 },
        ]),
      );
    } else if (url.pathname === "/api/events/event-1") res.end(JSON.stringify(event));
    else if (url.pathname === "/api/events/other") res.end(JSON.stringify({ ...event, camera: "camera2" }));
    else if (url.pathname.includes("missing")) res.writeHead(404).end("private-secret");
    else if (url.pathname.endsWith("snapshot.jpg"))
      res.writeHead(200, { "Content-Type": "image/jpeg" }).end(Buffer.from([255, 216, 255]));
    else if (url.pathname.endsWith("clip.mp4")) {
      if (req.headers.range === "bytes=999-") res.writeHead(416, { "Content-Range": "bytes */4" }).end();
      else
        res
          .writeHead(req.headers.range ? 206 : 200, {
            "Content-Type": "video/mp4",
            "Content-Length": "4",
            "Content-Range": "bytes 0-3/4",
            "Accept-Ranges": "bytes",
          })
          .end(Buffer.from([0, 1, 2, 3]));
    } else res.writeHead(404).end("private-secret");
  });
  const camera = config();
  const monitor = monitoringConfig();
  monitor.origin = origin;
  const monitoring = new CameraMonitoring(monitor, camera, env);
  monitoring.now = () => now;
  return { camera, monitoring, calls };
}

function api(cameras: Cameras, accounts: Accounts, federation?: Federation) {
  return new Api(
    new Hub(),
    noMatter,
    ownerPassword,
    accounts,
    new Clicks(":memory:"),
    silentLog,
    { health: null, organization: null, layoutPath: null, secrets: null, picos: null, cameras },
    federation,
  ).handle;
}

test("monitoring returns sanitized object and motion history and validates private origins", async () => {
  const f = await fixture();
  const result = await f.monitoring.history("camera1", null, new AbortController().signal);
  assert.equal(result.state, "ready");
  assert.deepEqual(
    result.items.map((item) => item.kind),
    ["object", "motion"],
  );
  assert.ok(!JSON.stringify(result).includes("private-secret"));
  assert.ok(!JSON.stringify(result).includes("camera.example.org"));
  assert.equal(result.items[0]?.snapshot, "/api/cameras/camera1/events/event-1/snapshot.jpg");
  await assert.rejects(f.monitoring.history("camera1", String(now + 1), new AbortController().signal), /time/);
  const native = JSON.parse(readFileSync(new URL(settings.cameraMonitoringConfigFile, releaseRoot), "utf8")) as {
    container: { ports: { api: { origin: string } } };
  };
  native.container.ports.api.origin = "http://0.0.0.0:5001";
  assert.throws(() => parseMonitoringConfig(JSON.stringify(native)), /private/);
  const unconfigured = new CameraMonitoring(monitoringConfig(), config(), {}, () => {
    throw new Error("must not fetch");
  });
  assert.equal((await unconfigured.history("camera1", null, new AbortController().signal)).state, "unconfigured");
});

test("all history and media require Cameras access, enforce camera identity, ranges, limits and revocation", async () => {
  const f = await fixture();
  const accounts = new Accounts(":memory:");
  for (const name of ["viewer", "lights"]) await accounts.join(accounts.createInvite().token, name, ownerPassword);
  accounts.setGrants("viewer", [{ node: catalog.defaultNode, scopes: ["cameras"] }]);
  accounts.setGrants("lights", [{ node: catalog.defaultNode, scopes: ["lights"] }]);
  const origin = await serve(api(new Cameras(f.camera, env, fetch, f.monitoring), accounts));
  const headers = { Authorization: `Bearer ${accounts.createSession("viewer")}` };
  const paths = [
    "/api/cameras/camera1/history",
    "/api/cameras/camera1/events/event-1/snapshot.jpg",
    "/api/cameras/camera1/events/event-1/clip.mp4",
    `/api/cameras/camera1/recordings/${now - 100}/${now - 10}/clip.mp4`,
    `/api/cameras/camera1/recordings/${now - 100}/snapshot.jpg`,
  ] as const;
  for (const path of paths) {
    assert.equal((await fetch(origin + path)).status, 401);
    assert.equal(
      (await fetch(origin + path, { headers: { Authorization: `Bearer ${accounts.createSession("lights")}` } })).status,
      403,
    );
    assert.equal((await fetch(origin + path, { headers })).status, 200);
  }
  const clip = await fetch(origin + paths[2], { headers: { ...headers, Range: "bytes=0-3" } });
  assert.equal(clip.status, 206);
  assert.equal(clip.headers.get("content-range"), "bytes 0-3/4");
  assert.equal(clip.headers.get("cache-control"), "no-store");
  assert.deepEqual(new Uint8Array(await clip.arrayBuffer()), new Uint8Array([0, 1, 2, 3]));
  assert.equal((await fetch(origin + paths[2], { headers: { ...headers, Range: "bytes=999-" } })).status, 416);
  assert.equal((await fetch(origin + paths[3].replace("clip.mp4", "clipXmp4"), { headers })).status, 404);
  const callCount = f.calls.length;
  assert.equal((await fetch(origin + "/api/cameras/camera1/events/other/clip.mp4", { headers })).status, 404);
  assert.equal(f.calls.length, callCount + 1);
  assert.equal(
    (await fetch(origin + `/api/cameras/camera1/recordings/${now - 500}/${now}/clip.mp4`, { headers })).status,
    400,
  );
  assert.equal((await fetch(origin + "/api/cameras/camera1/events/event-1/config", { headers })).status, 400);
  assert.equal((await fetch(origin + "/api/cameras/camera1/events/missing/clip.mp4", { headers })).status, 404);
  f.monitoring.config.history.maxMediaBytes = 3;
  const large = await fetch(origin + paths[2], { headers });
  assert.equal(large.status, 502);
  assert.ok(!(await large.text()).includes("private-secret"));
  accounts.setGrants("viewer", []);
  for (const path of paths) assert.equal((await fetch(origin + path, { headers })).status, 403);
  accounts.close();
});

test("recording forwarding uses the assigned node, preserves ranges and rejects changed signed ranges", async () => {
  const f = await fixture();
  const remoteKey = "camera-node-fixture-key-at-least-thirty-two-characters";
  const home = catalog.nodes[0];
  assert.ok(home);
  const nodes: NodeCatalog = {
    ...catalog,
    nodes: [
      home,
      {
        ...home,
        id: "camera-node",
        mode: "node",
        hostname: "camera-node.example.org",
        secretEnv: "CAMERA_NODE_KEY",
        scopes: ["cameras"],
        modules: ["hub", "cameras", "frigate"],
      },
    ],
  };
  nodes.transport = { ...nodes.transport, maxResponseBytes: 2 };
  const remote = new Federation(nodes, "camera-node", { CAMERA_NODE_KEY: remoteKey });
  const remoteAccounts = new Accounts(":memory:");
  const remoteURL = await serve(api(new Cameras(f.camera, env, fetch, f.monitoring), remoteAccounts, remote));
  let signed: RequestInit | undefined;
  let changeRange = true;
  const transport: typeof fetch = (url, init) => {
    signed = init;
    const path = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url).pathname;
    if (changeRange) {
      const changed = new Headers(init?.headers);
      changed.set("Range", "bytes=1-3");
      return fetch(remoteURL + path, { ...init, headers: changed });
    }
    return fetch(remoteURL + path, init);
  };
  const gateway = new Federation(nodes, nodes.defaultNode, { CAMERA_NODE_KEY: remoteKey }, transport);
  const accounts = new Accounts(":memory:");
  await accounts.join(accounts.createInvite().token, "viewer", ownerPassword);
  accounts.setGrants("viewer", [{ node: "camera-node", scopes: ["cameras"] }]);
  const origin = await serve(api(new Cameras(f.camera, env, fetch, f.monitoring), accounts, gateway));
  const headers = { Authorization: `Bearer ${accounts.createSession("viewer")}`, Range: "bytes=0-3" };
  const path = `/api/cameras/camera1/recordings/${now - 100}/${now - 10}/clip.mp4`;
  nodes.transport.maxResponseBytes = catalog.transport.maxResponseBytes;
  changeRange = false;
  const inventory = (await (await fetch(origin + "/api/cameras", { headers })).json()) as { node: { id: string } };
  assert.equal(inventory.node.id, "camera-node");
  accounts.setGrants("viewer", [{ node: nodes.defaultNode, scopes: ["cameras"] }]);
  const reassigned = (await (await fetch(origin + "/api/cameras", { headers })).json()) as { node: { id: string } };
  assert.equal(reassigned.node.id, nodes.defaultNode);
  accounts.setGrants("viewer", [{ node: "camera-node", scopes: ["cameras"] }]);
  nodes.transport.maxResponseBytes = 2;
  changeRange = true;
  f.calls.length = 0;
  assert.equal((await fetch(origin + path, { headers })).status, 403);
  assert.equal(f.calls.length, 0);
  changeRange = false;
  const response = await fetch(origin + path, { headers });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-length"), "4");
  assert.equal(response.headers.get("content-range"), "bytes 0-3/4");
  assert.equal(response.headers.get("x-jomaa-node"), "camera-node");
  assert.equal((await response.arrayBuffer()).byteLength, 4);
  assert.equal(f.calls.at(-1)?.range, "bytes=0-3");
  assert.equal((await fetch(origin + path + "?node=home", { headers })).status, 400);
  assert.ok(signed);
  const authorization = new Headers(signed.headers).get(delegationHeader);
  assert.ok(authorization);
  assert.equal(
    (await fetch(remoteURL + path, { headers: { [delegationHeader]: authorization, Range: "bytes=1-3" } })).status,
    403,
  );
  assert.equal((await fetch(remoteURL + path)).status, 403);
  accounts.close();
  remoteAccounts.close();
});

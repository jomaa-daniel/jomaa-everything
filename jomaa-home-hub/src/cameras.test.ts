import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Cameras, parseCameraConfig } from "./cameras.js";
import { Api, sessionToken } from "./api.js";
import { Accounts } from "./accounts.js";
import { Clicks } from "./clicks.js";
import { Hub } from "./hub.js";
import { silentLog } from "./log.js";
import { catalog } from "./nodes.js";
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
  removeNode: () => Promise.resolve(),
};
const password = "camera test owner password";
const cameraConfig = () => parseCameraConfig(readFileSync(new URL(settings.cameraConfigFile, releaseRoot), "utf8"));

test("camera inventory contains configured slots and no private source URLs", () => {
  const config = cameraConfig();
  const camera = config.cameras[0];
  assert.ok(camera);
  const secret = "rtsp://user:private-password@camera.example.org/live";
  const cameras = new Cameras(config, { [camera.sourceEnv]: secret });
  const inventory = cameras.inventory();
  assert.equal(inventory.cameras.length, 2);
  assert.equal(inventory.cameras[0]?.configured, true);
  assert.equal(inventory.cameras[1]?.configured, false);
  assert.ok(!JSON.stringify(inventory).includes("private-password"));
  assert.ok(!JSON.stringify(inventory).includes("camera.example.org"));
  assert.throws(() => parseCameraConfig(JSON.stringify({ ...config, cameras: [camera, camera] })), /unique/);
});

test("camera playlists and segments require camera access and proxy bounded local paths", async () => {
  const incoming: string[] = [];
  const upstream = await serve((req, res) => {
    incoming.push(req.url ?? "");
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers.cookie, undefined);
    if (req.url?.includes("missing")) {
      res.writeHead(404).end("rtsp://private:password@camera.example.org");
      return;
    }
    if (req.url?.includes("m3u8")) {
      res
        .writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" })
        .end('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\nsegment.mp4\n');
      return;
    }
    res
      .writeHead(req.headers.range ? 206 : 200, { "Content-Type": "video/mp4", "Accept-Ranges": "bytes" })
      .end(Buffer.from([0, 1, 2, 3]));
  });
  const config = cameraConfig();
  config.server.hlsAddress = new URL(upstream).host;
  const first = config.cameras[0];
  assert.ok(first);
  const accounts = new Accounts(":memory:");
  await accounts.join(accounts.createInvite().token, "viewer", password);
  accounts.setGrants("viewer", [{ node: catalog.defaultNode, scopes: ["cameras"] }]);
  await accounts.join(accounts.createInvite().token, "lights", password);
  accounts.setGrants("lights", [{ node: catalog.defaultNode, scopes: ["lights"] }]);
  const cameras = new Cameras(config, { [first.sourceEnv]: "rtsp://fixture-source/live" });
  const origin = await serve(
    new Api(new Hub(), noMatter, password, accounts, new Clicks(":memory:"), silentLog, {
      health: null,
      organization: null,
      layoutPath: null,
      secrets: null,
      picos: null,
      cameras,
    }).handle,
  );
  const path = `/api/cameras/${first.id}/hls/index.m3u8`;
  assert.equal((await fetch(origin + path)).status, 401);
  assert.equal(
    (await fetch(origin + path, { headers: { Authorization: `Bearer ${accounts.createSession("lights")}` } })).status,
    403,
  );
  const headers = { Authorization: `Bearer ${accounts.createSession("viewer")}` };
  const playlist = await fetch(origin + path + "?_HLS_msn=3&_HLS_part=2", { headers });
  assert.equal(playlist.status, 200);
  assert.equal(playlist.headers.get("cache-control"), "no-store");
  assert.match(await playlist.text(), /URI="init.mp4"/);
  assert.ok(incoming[0]?.includes("_HLS_msn=3&_HLS_part=2"));
  const segment = await fetch(origin + `/api/cameras/${first.id}/hls/segment.mp4`, {
    headers: { ...headers, Range: "bytes=0-3" },
  });
  assert.equal(segment.status, 206);
  assert.deepEqual(new Uint8Array(await segment.arrayBuffer()), new Uint8Array([0, 1, 2, 3]));
  assert.equal((await fetch(origin + `/api/cameras/${first.id}/hls/..%2Fsecret.mp4`, { headers })).status, 400);
  assert.equal((await fetch(origin + `/api/cameras/${first.id}/hls/secret.html`, { headers })).status, 400);
  const missing = await fetch(origin + `/api/cameras/${first.id}/hls/missing.mp4`, { headers });
  assert.equal(missing.status, 503);
  assert.ok(!(await missing.text()).includes("password"));
  accounts.setGrants("viewer", []);
  assert.equal((await fetch(origin + path, { headers })).status, 403);
  assert.equal(
    (await fetch(origin + "/api/cameras", { headers: { Authorization: `Bearer ${sessionToken(password)}` } })).status,
    200,
  );
  accounts.close();
});

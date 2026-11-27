import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { chromium } from "playwright-core";
import { Accounts } from "../accounts.js";
import { Api } from "../api.js";
import { Cameras, parseCameraConfig } from "../cameras.js";
import { Clicks } from "../clicks.js";
import { Hub } from "../hub.js";
import { silentLog } from "../log.js";
import { catalog } from "../nodes.js";
import { releaseRoot, settings } from "../settings.js";
import { serve } from "../testing.js";
import type { MatterAdmin } from "../matter/nodes.js";
import { captureReviewScreenshots } from "./dom.js";

const directory = mkdtempSync(join(tmpdir(), "camera-browser-"));
const children: ChildProcess[] = [];
after(() => {
  for (const child of children) child.kill();
  rmSync(directory, { recursive: true, force: true });
});
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
async function port(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const result = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) =>
    server.close(() => {
      resolve();
    }),
  );
  return result;
}
const browser = await chromium.launch({ channel: "chrome", headless: true }).catch((error: unknown) => {
  for (const child of children) child.kill();
  rmSync(directory, { recursive: true, force: true });
  throw error;
});
after(async () => {
  await browser.close();
});
const root = fileURLToPath(releaseRoot);
const configFile = new URL(settings.cameraConfigFile, releaseRoot);
const native = JSON.parse(readFileSync(configFile, "utf8")) as {
  mediaMtx: { binaryFile: string };
  server: Record<string, unknown>;
};
const binary = join(root, native.mediaMtx.binaryFile);
const install = spawnSync("python3", [join(root, "jomaa-cameras/build.py"), "--server"], { stdio: "inherit" });
assert.equal(install.status, 0);
const rtsp = await port();
const hls = await port();
const metrics = await port();
const runtime = {
  ...native.server,
  rtsp: true,
  rtspAddress: `127.0.0.1:${rtsp}`,
  rtspTransports: ["tcp"],
  hlsAddress: `127.0.0.1:${hls}`,
  metricsAddress: `127.0.0.1:${metrics}`,
  authInternalUsers: [{ user: "any", permissions: [{ action: "publish" }, { action: "read" }, { action: "metrics" }] }],
  pathDefaults: { sourceOnDemand: false },
  paths: { camera1: { source: "publisher" }, camera2: { source: "publisher" } },
};
const runtimeFile = join(directory, "mediamtx.json");
writeFileSync(runtimeFile, JSON.stringify(runtime));
children.push(spawn(binary, [runtimeFile], { stdio: "ignore", cwd: directory }));
for (let attempt = 0; attempt < 100; attempt++) {
  try {
    const response = await fetch(`http://127.0.0.1:${metrics}/metrics`);
    if (response.ok) break;
  } catch {
    /* The fixture server is starting. */
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
}
for (const [id, color] of [
  ["camera1", "red"],
  ["camera2", "blue"],
]) {
  children.push(
    spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-re",
        "-f",
        "lavfi",
        "-i",
        `color=c=${color}:s=320x180:r=10`,
        "-an",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-preset",
        "ultrafast",
        "-tune",
        "zerolatency",
        "-g",
        "10",
        "-f",
        "rtsp",
        "-rtsp_transport",
        "tcp",
        `rtsp://127.0.0.1:${rtsp}/${id}`,
      ],
      { stdio: "ignore" },
    ),
  );
}
const config = parseCameraConfig(readFileSync(configFile, "utf8"));
config.server.hlsAddress = `127.0.0.1:${hls}`;
const environment = Object.fromEntries(
  config.cameras.map((camera) => [camera.sourceEnv, "rtsp://fixture-source/live"]),
);
const accounts = new Accounts(":memory:");
const password = "camera browser test password";
await accounts.join(accounts.createInvite().token, "viewer", password);
accounts.setGrants("viewer", [{ node: catalog.defaultNode, scopes: ["cameras"] }]);
const origin = await serve(
  new Api(new Hub(), noMatter, password, accounts, new Clicks(":memory:"), silentLog, {
    health: null,
    organization: null,
    layoutPath: null,
    secrets: null,
    picos: null,
    cameras: new Cameras(config, environment),
  }).handle,
);

after(() => {
  accounts.close();
});

test("two real MediaMTX streams play independently in Video.js and camera access can be revoked", async () => {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin + "/cameras");
  await page.locator("#username").fill("viewer");
  await page.locator("#password").fill(password);
  await page.locator("#login-form button").click();
  await page.locator(".camera-status.live").nth(1).waitFor({ timeout: 60000 });
  await page.waitForFunction(
    "[...document.querySelectorAll('video.vjs-tech')].every(video => video.currentTime > 0 && video.readyState >= 2)",
  );
  assert.equal(await page.locator("video.vjs-tech").count(), 2);
  await captureReviewScreenshots(page, "cameras-live");
  await page.locator(".vjs-play-control").first().click();
  await page.locator(".camera-status", { hasText: "Paused" }).waitFor();
  assert.equal(await page.locator(".camera-status.live").count(), 1);
  assert.equal((await fetch(origin + "/api/cameras/camera1/hls/index.m3u8")).status, 401);
  accounts.setGrants("viewer", []);
  await page.locator("#refresh").click();
  await page.locator("#login-section").waitFor();
  assert.ok(await page.locator("#content").isHidden());
  assert.deepEqual(errors, []);
  await page.close();
});

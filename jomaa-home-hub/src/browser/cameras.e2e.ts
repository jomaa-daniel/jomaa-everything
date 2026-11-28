import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { chromium, type Page } from "playwright-core";
import { Accounts } from "../accounts.js";
import { Api } from "../api.js";
import { CameraMonitoring, parseMonitoringConfig } from "../camera-monitoring.js";
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
for (const id of ["camera1", "camera2"]) {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${hls}/${id}/index.m3u8`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) {
        await response.body?.cancel();
        ready = true;
        break;
      }
    } catch {
      // The fixture publisher is connecting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, `${id} publisher must be ready before testing playback`);
}
const config = parseCameraConfig(readFileSync(configFile, "utf8"));
config.server.hlsAddress = `127.0.0.1:${hls}`;
const environment = Object.fromEntries(
  config.cameras.map((camera) => [camera.sourceEnv, "rtsp://fixture-source/live"]),
);
const clipFile = join(directory, "recording.mp4");
const imageFile = join(directory, "snapshot.jpg");
assert.equal(
  spawnSync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=320x180:rate=10",
    "-t",
    "2",
    "-an",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    clipFile,
  ]).status,
  0,
);
assert.equal(
  spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", clipFile, "-frames:v", "1", imageFile]).status,
  0,
);
const clipBytes = readFileSync(clipFile);
const snapshotBytes = readFileSync(imageFile);
const historyTime = Date.now() / 1000 - 300;
const event = {
  id: "fixture-event",
  camera: "camera1",
  label: "person",
  start_time: historyTime,
  end_time: historyTime + 90,
  has_snapshot: true,
  has_clip: true,
};
const historyOrigin = await serve((req, res) => {
  const url = new URL(req.url ?? "/", "http://fixture");
  if (url.pathname === "/api/events")
    res
      .writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify(url.searchParams.get("cameras") === "camera1" ? [event] : []));
  else if (url.pathname === "/api/events/fixture-event")
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(event));
  else if (url.pathname === "/api/review/activity/motion")
    res
      .writeHead(200, { "Content-Type": "application/json" })
      .end(
        JSON.stringify(
          url.searchParams.get("cameras") === "camera1"
            ? [{ camera: "camera1", start_time: historyTime - 120, motion: 80 }]
            : [],
        ),
      );
  else if (url.pathname.endsWith("snapshot.jpg"))
    res.writeHead(200, { "Content-Type": "image/jpeg" }).end(snapshotBytes);
  else if (url.pathname.endsWith("clip.mp4")) {
    const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Math.min(Number(range[2]), clipBytes.length - 1) : clipBytes.length - 1;
    if (start >= clipBytes.length) {
      res.writeHead(416, { "Content-Range": `bytes */${clipBytes.length}` }).end();
      return;
    }
    res
      .writeHead(range ? 206 : 200, {
        "Content-Type": "video/mp4",
        "Content-Length": String(end - start + 1),
        "Accept-Ranges": "bytes",
        ...(range ? { "Content-Range": `bytes ${start}-${end}/${clipBytes.length}` } : {}),
      })
      .end(clipBytes.subarray(start, end + 1));
  } else res.writeHead(404).end();
});
const monitoringConfig = parseMonitoringConfig(
  readFileSync(new URL(settings.cameraMonitoringConfigFile, releaseRoot), "utf8"),
);
monitoringConfig.origin = historyOrigin;
const monitoring = new CameraMonitoring(monitoringConfig, config, environment);
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
    cameras: new Cameras(config, environment, fetch, monitoring),
  }).handle,
);

after(() => {
  accounts.close();
});

async function waitForVideo(page: Page, selector: string, ready: number, moving: boolean) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const states = await page.locator(selector).evaluateAll((elements) =>
      elements.map((element) => {
        const video = element as unknown as { currentTime: number; readyState: number };
        return { currentTime: video.currentTime, readyState: video.readyState };
      }),
    );
    if (states.length > 0 && states.every((state) => state.readyState >= ready && (!moving || state.currentTime > 0)))
      return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`Video must become ready: ${selector}`);
}

test("live streams, activity filters and recorded video work with revocable camera access", async () => {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin + "/cameras");
  await page.locator("#username").fill("viewer");
  await page.locator("#password").fill(password);
  await page.locator("#login-form button").click();
  try {
    await page.locator(".camera-status.live").nth(1).waitFor({ timeout: 60000 });
  } catch (error) {
    await captureReviewScreenshots(page, "cameras-failure");
    throw error;
  }
  await waitForVideo(page, "video.vjs-tech", 2, true);
  assert.equal(await page.locator("video.vjs-tech").count(), 2);
  await page.locator(".activity-item").nth(1).waitFor();
  await captureReviewScreenshots(page, "cameras-live");
  await page.locator("#history-kind").selectOption("object");
  assert.equal(await page.locator(".activity-item").count(), 1);
  assert.equal(await page.locator(".activity-item h3").textContent(), "person");
  await page.locator(".activity-item button").click();
  await waitForVideo(page, "#history-player video", 1, false);
  await page.locator("#history-player .vjs-play-control").click();
  await waitForVideo(page, "#history-player video", 2, true);
  await captureReviewScreenshots(page, "cameras-recording");
  await page.locator("#close-recording").click();
  assert.ok(await page.locator("#history-player").isHidden());
  await page.locator("#history-kind").selectOption("motion");
  assert.equal(await page.locator(".activity-item h3").textContent(), "Motion");
  await page.locator("#history-camera").selectOption("camera2");
  await page.locator("#history-notice", { hasText: "No recorded activity" }).waitFor();
  assert.equal(await page.locator(".activity-item").count(), 0);
  await page.locator("#history-camera").selectOption("camera1");
  await page.locator(".activity-item").waitFor();
  await page.locator(".activity-item button").click();

  await page.locator(".vjs-play-control").first().click();
  await page.locator(".camera-status", { hasText: "Paused" }).waitFor();
  assert.equal(await page.locator(".camera-status.live").count(), 1);
  assert.equal((await fetch(origin + "/api/cameras/camera1/hls/index.m3u8")).status, 401);
  accounts.setGrants("viewer", []);
  await page.locator("#refresh").click();
  await page.locator("#login-section").waitFor();
  assert.ok(await page.locator("#content").isHidden());
  assert.ok(await page.locator("#history-player").isHidden());
  assert.equal(await page.locator(".activity-item").count(), 0);
  assert.deepEqual(errors, []);
  await page.close();
});

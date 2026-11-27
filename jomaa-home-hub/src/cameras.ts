import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { once } from "node:events";
import { Fields, parseJson } from "./json.js";
import { releaseRoot, settings } from "./settings.js";
import { catalog } from "./nodes.js";

export interface CameraConfig {
  server: { hlsAddress: string };
  playback: { refreshSeconds: number; requestTimeoutSeconds: number; autoplay: boolean; muted: boolean };
  cameras: { id: string; name: string; sourceEnv: string }[];
}

export class CameraError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const mediaFile = /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\.(m3u8|mp4|m4s|ts|aac)$/;
const hlsParameters = new Set(["_HLS_msn", "_HLS_part", "_HLS_skip"]);
const responseHeaders = ["content-type", "content-range", "accept-ranges"];

export function parseCameraConfig(text: string): CameraConfig {
  const root = new Fields(parseJson(text), "camera config").required("server", "playback", "cameras");
  const server = new Fields(root.value("server"), "server");
  const hlsAddress = server.required("hlsAddress").string("hlsAddress") ?? "";
  const origin = new URL(`http://${hlsAddress}`);
  if (
    !origin.hostname ||
    !origin.port ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw new Error("server.hlsAddress must be a host and port without credentials or a path");
  const playback = new Fields(root.value("playback"), "playback")
    .only("refreshSeconds", "requestTimeoutSeconds", "autoplay", "muted")
    .required("refreshSeconds", "requestTimeoutSeconds", "autoplay", "muted");
  const refreshSeconds = playback.int("refreshSeconds");
  const requestTimeoutSeconds = playback.int("requestTimeoutSeconds");
  const autoplay = playback.bool("autoplay");
  const muted = playback.bool("muted");
  if (
    refreshSeconds === null ||
    refreshSeconds <= 0 ||
    requestTimeoutSeconds === null ||
    requestTimeoutSeconds <= 0 ||
    autoplay === null ||
    muted === null
  )
    throw new Error("invalid camera playback settings");
  if (!Array.isArray(root.value("cameras"))) throw new Error("cameras must be a list");
  const cameras = root.list("cameras").map((value) => {
    const camera = new Fields(value, "camera").only("id", "name", "sourceEnv").required("id", "name", "sourceEnv");
    const id = camera.string("id") ?? "";
    const name = camera.string("name") ?? "";
    const sourceEnv = camera.string("sourceEnv") ?? "";
    if (!/^[a-z][a-z0-9_-]*$/.test(id) || !name.trim() || !/^[A-Z][A-Z0-9_]*$/.test(sourceEnv))
      throw new Error("invalid camera id, name or sourceEnv");
    return { id, name, sourceEnv };
  });
  if (
    new Set(cameras.map((camera) => camera.id)).size !== cameras.length ||
    new Set(cameras.map((camera) => camera.sourceEnv)).size !== cameras.length
  )
    throw new Error("camera identifiers and source environment keys must be unique");
  return { server: { hlsAddress }, playback: { refreshSeconds, requestTimeoutSeconds, autoplay, muted }, cameras };
}

/** Authenticated metadata and HLS media from the local MediaMTX service. */
export class Cameras {
  constructor(
    readonly config: CameraConfig,
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly transport: typeof fetch = fetch,
  ) {}

  static load(): Cameras {
    return new Cameras(parseCameraConfig(readFileSync(new URL(settings.cameraConfigFile, releaseRoot), "utf8")));
  }

  inventory() {
    return {
      playback: this.config.playback,
      cameras: this.config.cameras.map((camera) => ({
        id: camera.id,
        name: camera.name,
        configured: Boolean(this.environment[camera.sourceEnv]),
        stream: `/api/cameras/${encodeURIComponent(camera.id)}/hls/index.m3u8`,
      })),
    };
  }

  async media(req: IncomingMessage, res: ServerResponse, id: string, file: string, signal: AbortSignal): Promise<void> {
    const camera = this.config.cameras.find((item) => item.id === id);
    if (!camera) throw new CameraError(404, "Camera not found");
    if (!this.environment[camera.sourceEnv]) throw new CameraError(503, "Camera source is not configured");
    if (!mediaFile.test(file) || file.includes("..")) throw new CameraError(400, "Invalid media file");
    const requested = new URL(req.url ?? "/", "http://hub");
    const url = new URL(
      `/${encodeURIComponent(id)}/${encodeURIComponent(file)}`,
      `http://${this.config.server.hlsAddress}`,
    );
    for (const [key, value] of requested.searchParams) if (hlsParameters.has(key)) url.searchParams.append(key, value);
    const headers: Record<string, string> = { "Accept-Encoding": "identity" };
    if (typeof req.headers.range === "string") headers["Range"] = req.headers.range;
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(this.config.playback.requestTimeoutSeconds * 1000)]);
    try {
      const response = await this.transport(url, { headers, redirect: "manual", signal: deadline });
      if (response.status !== 200 && response.status !== 206) {
        await response.body?.cancel();
        throw new CameraError(503, "Camera stream is unavailable");
      }
      res.statusCode = response.status;
      for (const name of responseHeaders) {
        const value = response.headers.get(name);
        if (value !== null) res.setHeader(name, value);
      }
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      let size = 0;
      if (response.body) {
        const reader = (response.body as ReadableStream<Uint8Array>).getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > catalog.transport.maxResponseBytes) {
            await reader.cancel();
            throw new CameraError(502, "Camera media exceeds the response limit");
          }
          if (!res.write(value)) await once(res, "drain", { signal: deadline });
        }
      }
      res.end();
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof CameraError) throw error;
      throw new CameraError(deadline.aborted ? 504 : 503, "Camera stream is unavailable");
    }
  }
}

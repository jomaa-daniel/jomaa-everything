import { Fields, parseJson } from "./json.js";
import type { CameraConfig } from "./cameras.js";
import { CameraError } from "./cameras.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { catalog } from "./nodes.js";
import { once } from "node:events";

export interface MonitoringConfig {
  enabled: boolean;
  origin: string;
  history: {
    lookbackHours: number;
    limit: number;
    motionBucketSeconds: number;
    maxClipSeconds: number;
    maxMediaBytes: number;
    requestTimeoutSeconds: number;
  };
}
const historyKeys = [
  "lookbackHours",
  "limit",
  "motionBucketSeconds",
  "maxClipSeconds",
  "maxMediaBytes",
  "requestTimeoutSeconds",
] as const;
const eventID = /^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/;
const eventPath = "/api/events";
const motionPath = "/api/review/activity/motion";
const mediaTypes = { "snapshot.jpg": "image/jpeg", "clip.mp4": "video/mp4" } as const;
type MediaFile = keyof typeof mediaTypes;
interface Activity {
  kind: "object" | "motion";
  id: string;
  camera: string;
  label: string;
  start: number;
  end: number | null;
  snapshot: string | null;
  clip: string | null;
  clipSeconds: number;
}

export function parseMonitoringConfig(text: string): MonitoringConfig {
  const root = new Fields(parseJson(text), "monitoring config").required("enabled", "container", "history");
  const enabled = root.bool("enabled");
  const ports = new Fields(new Fields(root.value("container"), "container").value("ports"), "ports");
  const origin = new Fields(ports.value("api"), "api port").string("origin") ?? "";
  const url = new URL(origin);
  if (
    enabled === null ||
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("invalid private monitoring origin or enabled setting");
  const fields = new Fields(root.value("history"), "history").only(...historyKeys).required(...historyKeys);
  const history = Object.fromEntries(
    historyKeys.map((key) => {
      const value = fields.int(key);
      if (value === null || value <= 0) throw new Error(`history.${key} must be positive`);
      return [key, value];
    }),
  ) as MonitoringConfig["history"];
  if (history.motionBucketSeconds > history.maxClipSeconds || history.motionBucketSeconds > 3600)
    throw new Error("motion buckets must fit a clip and an hour");
  return { enabled, origin, history };
}

function number(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Read-only camera activity and bounded media from the private monitoring provider. */
export class CameraMonitoring {
  now = () => Date.now() / 1000;
  constructor(
    readonly config: MonitoringConfig,
    private readonly cameras: CameraConfig,
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly transport: typeof fetch = fetch,
  ) {}

  inventory() {
    return {
      enabled: this.config.enabled,
      lookbackHours: this.config.history.lookbackHours,
      maxClipSeconds: this.config.history.maxClipSeconds,
    };
  }

  #camera(id: string) {
    const camera = this.cameras.cameras.find((item) => item["id"] === id);
    if (!camera) throw new CameraError(404, "Camera not found");
    return camera;
  }

  #state(id: string): "disabled" | "unconfigured" | null {
    const camera = this.#camera(id);
    if (!this.config.enabled || !camera.monitoring.enabled) return "disabled";
    return this.environment[camera.sourceEnv] ? null : "unconfigured";
  }

  #url(path: string, params: Record<string, string> = {}) {
    const url = new URL(path, this.config.origin);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url;
  }

  async #json(path: string, params: Record<string, string>, signal: AbortSignal): Promise<unknown> {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(this.config.history.requestTimeoutSeconds * 1000)]);
    try {
      const response = await this.transport(this.#url(path, params), { redirect: "manual", signal: deadline });
      if (!response.ok) {
        await response.body?.cancel();
        throw new CameraError(
          response.status === 404 ? 404 : 503,
          response.status === 404 ? "Activity not found" : "Camera history is unavailable",
        );
      }
      let size = 0;
      const chunks: Uint8Array[] = [];
      if (response.body) {
        const reader = (response.body as ReadableStream<Uint8Array>).getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > catalog.transport.maxResponseBytes) {
            await reader.cancel();
            throw new CameraError(502, "Camera history exceeds the response limit");
          }
          chunks.push(value);
        }
      }
      return JSON.parse(Buffer.concat(chunks).toString()) as unknown;
    } catch (error) {
      if (error instanceof CameraError) throw error;
      throw new CameraError(deadline.aborted ? 504 : 503, "Camera history is unavailable");
    }
  }

  async #event(id: string, event: string, signal: AbortSignal): Promise<Record<string, unknown>> {
    this.#camera(id);
    if (!eventID.test(event)) throw new CameraError(400, "Invalid activity id");
    const value = await this.#json(`${eventPath}/${encodeURIComponent(event)}`, {}, signal);
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      (value as Record<string, unknown>)["camera"] !== id
    )
      throw new CameraError(404, "Activity not found");
    return value as Record<string, unknown>;
  }

  async history(id: string, before: string | null, signal: AbortSignal) {
    const state = this.#state(id);
    if (state) return { state, items: [], before: null };
    const end = before === null ? this.now() : Number(before);
    if (!number(end) || end > this.now()) throw new CameraError(400, "Invalid history time");
    const start = Math.max(0, end - this.config.history.lookbackHours * 3600);
    const params = { cameras: id, after: String(start), before: String(end) };
    const [events, motion] = await Promise.all([
      this.#json(eventPath, { ...params, limit: String(this.config.history.limit) }, signal),
      this.#json(motionPath, { ...params, scale: String(this.config.history.motionBucketSeconds) }, signal),
    ]);
    if (!Array.isArray(events) || !Array.isArray(motion)) throw new CameraError(503, "Invalid camera history response");
    const items: Activity[] = [];
    for (const raw of events) {
      if (!raw || typeof raw !== "object") continue;
      const event = raw as Record<string, unknown>;
      if (
        event["camera"] !== id ||
        typeof event["id"] !== "string" ||
        !eventID.test(event["id"]) ||
        typeof event["label"] !== "string" ||
        !number(event["start_time"]) ||
        event["start_time"] > end ||
        !(event["end_time"] === null || number(event["end_time"]))
      )
        continue;
      const base = `/api/cameras/${encodeURIComponent(id)}/events/${encodeURIComponent(event["id"])}`;
      const clipSeconds = Math.min(
        this.config.history.maxClipSeconds,
        (event["end_time"] ?? this.now()) - event["start_time"],
      );
      items.push({
        kind: "object",
        id: event["id"],
        camera: id,
        label: event["label"],
        start: event["start_time"],
        end: event["end_time"],
        snapshot: event["has_snapshot"] === true ? `${base}/snapshot.jpg` : null,
        clip: event["has_clip"] === true && clipSeconds > 0 ? `${base}/clip.mp4` : null,
        clipSeconds,
      });
    }
    for (const raw of motion) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as Record<string, unknown>;
      if (item["camera"] !== id || !number(item["start_time"]) || !number(item["motion"]) || item["motion"] <= 0)
        continue;
      if (item["start_time"] > end) continue;
      const motionEnd = Math.min(this.now(), item["start_time"] + this.config.history.motionBucketSeconds);
      if (motionEnd <= item["start_time"]) continue;
      const base = `/api/cameras/${encodeURIComponent(id)}/recordings/${item["start_time"]}`;
      items.push({
        kind: "motion",
        id: `motion-${item["start_time"]}`,
        camera: id,
        label: "Motion",
        start: item["start_time"],
        end: motionEnd,
        snapshot: `${base}/snapshot.jpg`,
        clip: `${base}/${motionEnd}/clip.mp4`,
        clipSeconds: motionEnd - item["start_time"],
      });
    }
    items.sort((a, b) => b.start - a.start);
    const visible = items.slice(0, this.config.history.limit);
    return {
      state: "ready",
      items: visible,
      before: visible.length ? (visible.at(-1)?.start ?? start) - 0.001 : start,
    };
  }

  #range(start: string, end: string) {
    const from = Number(start),
      to = Number(end);
    if (
      !start ||
      !end ||
      !number(from) ||
      !number(to) ||
      to <= from ||
      to > this.now() ||
      to - from > this.config.history.maxClipSeconds
    )
      throw new CameraError(400, "Invalid recording range");
    return { from, to };
  }

  async eventMedia(
    req: IncomingMessage,
    res: ServerResponse,
    id: string,
    eventID: string,
    file: string,
    signal: AbortSignal,
  ) {
    if (this.#state(id)) throw new CameraError(503, "Camera monitoring is not configured");
    if (file !== "snapshot.jpg" && file !== "clip.mp4") throw new CameraError(400, "Invalid activity media");
    const event = await this.#event(id, eventID, signal);
    if (file === "snapshot.jpg") {
      if (event["has_snapshot"] !== true) throw new CameraError(404, "Snapshot not available");
      await this.#media(req, res, `${eventPath}/${encodeURIComponent(eventID)}/${file}`, file, signal);
    } else {
      if (
        event["has_clip"] !== true ||
        !number(event["start_time"]) ||
        event["start_time"] > this.now() ||
        !(event["end_time"] === null || number(event["end_time"]))
      )
        throw new CameraError(404, "Recording not available");
      const end = Math.min(event["end_time"] ?? this.now(), event["start_time"] + this.config.history.maxClipSeconds);
      await this.recording(req, res, id, String(event["start_time"]), String(end), signal);
    }
  }

  async recording(
    req: IncomingMessage,
    res: ServerResponse,
    id: string,
    start: string,
    end: string,
    signal: AbortSignal,
  ) {
    if (this.#state(id)) throw new CameraError(503, "Camera monitoring is not configured");
    const { from, to } = this.#range(start, end);
    await this.#media(req, res, `/api/${encodeURIComponent(id)}/start/${from}/end/${to}/clip.mp4`, "clip.mp4", signal);
  }

  async snapshot(req: IncomingMessage, res: ServerResponse, id: string, start: string, signal: AbortSignal) {
    if (this.#state(id)) throw new CameraError(503, "Camera monitoring is not configured");
    const time = Number(start);
    if (!start || !number(time) || time > this.now()) throw new CameraError(400, "Invalid recording time");
    await this.#media(
      req,
      res,
      `/api/${encodeURIComponent(id)}/recordings/${time}/snapshot.jpg`,
      "snapshot.jpg",
      signal,
    );
  }

  async #media(req: IncomingMessage, res: ServerResponse, path: string, file: MediaFile, signal: AbortSignal) {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(this.config.history.requestTimeoutSeconds * 1000)]);
    try {
      const headers: Record<string, string> = { "Accept-Encoding": "identity" };
      if (req.headers.range) headers["Range"] = req.headers.range;
      const response = await this.transport(this.#url(path), { headers, redirect: "manual", signal: deadline });
      if (![200, 206, 416].includes(response.status)) {
        await response.body?.cancel();
        throw new CameraError(
          response.status === 404 ? 404 : 503,
          response.status === 404 ? "Recording is no longer available" : "Camera media is unavailable",
        );
      }
      if (response.status === 416) {
        await response.body?.cancel();
        res.statusCode = 416;
        const range = response.headers.get("content-range");
        if (range !== null) res.setHeader("Content-Range", range);
        res.setHeader("Cache-Control", "no-store");
        res.end();
        return;
      }
      if (response.headers.get("content-type")?.split(";")[0]?.trim() !== mediaTypes[file]) {
        await response.body?.cancel();
        throw new CameraError(503, "Camera media is unavailable");
      }
      const length = response.headers.get("content-length");
      if (length !== null && Number(length) > this.config.history.maxMediaBytes) {
        await response.body?.cancel();
        throw new CameraError(502, "Recording exceeds the response limit");
      }
      res.statusCode = response.status;
      res.setHeader("Content-Type", mediaTypes[file]);
      for (const name of ["content-range", "accept-ranges", "content-length"]) {
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
          if (size > this.config.history.maxMediaBytes) {
            await reader.cancel();
            throw new CameraError(502, "Recording exceeds the response limit");
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
      throw new CameraError(deadline.aborted ? 504 : 503, "Camera media is unavailable");
    }
  }
}

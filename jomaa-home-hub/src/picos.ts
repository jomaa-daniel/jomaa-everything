import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Fields, isObject, parseJson } from "./json.js";
import { releaseRoot } from "./settings.js";

const configFile = new URL("jomaa-images/config.json", releaseRoot);
const terminal = (status: string) => status === "passed" || status === "failed";
const ssidMaxBytes = 32;
const passwordMaxBytes = 64;

export interface Feature {
  id: string;
  label: string;
  description: string;
  requires: string[];
  default: boolean;
}
export interface PicoTarget {
  id: string;
  name: string;
  mode: "runtime" | "bootsel";
  uniqueId: string | null;
  description: string;
  available: boolean;
  unavailableReason: string | null;
  latestRunId: string | null;
}
export interface FlashRequest {
  features: string[];
  wifi?: { ssid: string; password: string; transport: "native" | "esp8285" };
}
export interface ImageCheck {
  feature: string;
  status: "pending" | "running" | "passed" | "failed";
  message: string;
  evidence: Record<string, unknown> | null;
}
export type ImageEvent =
  | { type: "stage"; stage: string; message: string; runtimeTargetId?: string }
  | { type: "check"; check: ImageCheck }
  | { type: "result"; status: "passed" | "failed"; message: string };
export interface ImageRun {
  id: string;
  targetId: string;
  runtimeTargetId?: string;
  features: string[];
  status: "queued" | "running" | "passed" | "failed";
  stage: string;
  message: string;
  createdAt: number;
  updatedAt: number;
  checks: ImageCheck[];
}
export interface PicoImager {
  discover(): Promise<PicoTarget[]>;
  catalog(): Promise<{ features: Feature[]; defaultWifiTransport: "native" | "esp8285" }>;
  flash(targetId: string, request: FlashRequest, emit: (event: ImageEvent) => void): Promise<void>;
}
export interface ImageSettings {
  command: string[];
  runStateFile: string;
  pollMilliseconds: number;
  retentionHours: number;
  commandTimeoutSeconds: number;
  flashTimeoutSeconds: number;
  maxOutputBytes: number;
  maxRequestBytes: number;
}

export class PicoError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function imageSettings(): ImageSettings {
  const f = new Fields(parseJson(readFileSync(configFile, "utf8")), "image settings");
  const command = f.list("command");
  if (!command.length || command.some((x) => typeof x !== "string" || !x)) throw new Error("Invalid image command");
  const state = f.string("runStateFile");
  if (!state || state.startsWith("/") || state.split("/").includes("..")) throw new Error("Invalid runStateFile");
  const positive = (key: string) => {
    const value = f.int(key);
    if (value === null || value < 1) throw new Error(`Invalid image setting ${key}`);
    return value;
  };
  return {
    command: command as string[],
    runStateFile: state,
    pollMilliseconds: positive("pollMilliseconds"),
    retentionHours: positive("retentionHours"),
    commandTimeoutSeconds: positive("commandTimeoutSeconds"),
    flashTimeoutSeconds: positive("flashTimeoutSeconds"),
    maxOutputBytes: positive("maxOutputBytes"),
    maxRequestBytes: positive("maxRequestBytes"),
  };
}

export function flashRequest(value: unknown, catalog: Feature[]): FlashRequest {
  const f = new Fields(value, "image request").only("features", "wifi").required("features");
  const features = f.list("features");
  if (
    !features.length ||
    features.some((id) => typeof id !== "string" || !catalog.some((x) => x.id === id)) ||
    new Set(features).size !== features.length
  )
    throw new PicoError(400, "Select supported features without duplicates");
  for (const feature of catalog) {
    if (features.includes(feature.id) && !feature.requires.every((id) => features.includes(id)))
      throw new PicoError(400, `Select required features for ${feature.label}`);
  }
  const result: FlashRequest = { features: catalog.filter((x) => features.includes(x.id)).map((x) => x.id) };
  if (features.includes("wifi") !== f.has("wifi"))
    throw new PicoError(400, "Supply Wi-Fi settings only for Wi-Fi images");
  if (features.includes("wifi")) {
    const wifi = new Fields(f.value("wifi"), "Wi-Fi")
      .only("ssid", "password", "transport")
      .required("ssid", "password", "transport");
    const ssid = wifi.string("ssid");
    const password = wifi.string("password");
    const transport = wifi.string("transport");
    if (
      ssid === null ||
      password === null ||
      Buffer.byteLength(ssid) < 1 ||
      Buffer.byteLength(ssid) > ssidMaxBytes ||
      Buffer.byteLength(password) > passwordMaxBytes ||
      /[\r\n\0]/.test(ssid + password) ||
      (transport !== "native" && transport !== "esp8285")
    )
      throw new PicoError(400, "Invalid Wi-Fi settings");
    result.wifi = { ssid, password, transport };
  }
  return result;
}

/** Runs the image component without a shell and accepts its structured output only. */
export class ImageCommand implements PicoImager {
  constructor(private readonly settings: ImageSettings) {}

  private command(args: string[], request?: FlashRequest, emit?: (event: ImageEvent) => void): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const [program, ...prefix] = this.settings.command;
      if (!program) {
        reject(new PicoError(503, "Image command is unavailable"));
        return;
      }
      const child = spawn(program, [...prefix, ...args], {
        cwd: fileURLToPath(releaseRoot),
        stdio: ["pipe", "pipe", "ignore"],
        detached: process.platform !== "win32",
      });
      let output = "";
      let size = 0;
      let failed = false;
      const stop = () => {
        failed = true;
        try {
          if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          /* The child has exited. */
        }
      };
      const timer = setTimeout(
        stop,
        (emit ? this.settings.flashTimeoutSeconds : this.settings.commandTimeoutSeconds) * 1000,
      );
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > this.settings.maxOutputBytes) {
          stop();
          return;
        }
        output += chunk.toString("utf8");
        if (emit) {
          for (let newline = output.indexOf("\n"); newline >= 0; newline = output.indexOf("\n")) {
            const line = output.slice(0, newline);
            output = output.slice(newline + 1);
            try {
              const event = parseJson(line);
              if (!isObject(event) || !["stage", "check", "result"].includes(String(event["type"]))) throw new Error();
              emit(event as unknown as ImageEvent);
            } catch {
              stop();
              return;
            }
          }
        }
      });
      child.once("error", () => {
        clearTimeout(timer);
        reject(new PicoError(503, "The image command could not start"));
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (failed || code !== 0 || (emit && output.trim())) {
          reject(new PicoError(503, "Imaging stopped or exceeded its deadline; check the feature results"));
          return;
        }
        if (emit) resolve(undefined);
        else {
          try {
            resolve(parseJson(output));
          } catch {
            reject(new PicoError(503, "Invalid response from the image component"));
          }
        }
      });
      child.stdin.on("error", () => {
        /* Process failure is reported by close. */
      });
      child.stdin.end(request ? JSON.stringify(request) : "");
    });
  }

  async discover(): Promise<PicoTarget[]> {
    const result = new Fields(await this.command(["discover"]), "USB inventory");
    return result.list("targets").map((value) => {
      const f = new Fields(value, "USB target");
      const id = f.string("id");
      const mode = f.string("mode");
      if (!id || !/^[a-zA-Z0-9_-]+$/.test(id) || (mode !== "runtime" && mode !== "bootsel"))
        throw new PicoError(503, "Invalid USB inventory");
      return {
        id,
        mode,
        name: f.string("name") ?? id,
        uniqueId: f.string("uniqueId"),
        description: f.string("description") ?? "",
        available: f.bool("available") === true,
        unavailableReason: f.string("unavailableReason"),
        latestRunId: null,
      };
    });
  }
  async catalog(): Promise<{ features: Feature[]; defaultWifiTransport: "native" | "esp8285" }> {
    const result = new Fields(await this.command(["catalog"]), "image catalog");
    const features = result.list("features").map((value) => {
      const f = new Fields(value, "image feature");
      const id = f.string("id");
      const requires = f.list("requires");
      if (!id || requires.some((x) => typeof x !== "string")) throw new PicoError(503, "Invalid image catalog");
      return {
        id,
        label: f.string("label") ?? id,
        description: f.string("description") ?? "",
        requires: requires as string[],
        default: f.bool("default") === true,
      };
    });
    if (
      !features.length ||
      new Set(features.map((x) => x.id)).size !== features.length ||
      features.some((x) => x.requires.some((id) => !features.some((y) => y.id === id)))
    )
      throw new PicoError(503, "Invalid image catalog");
    const defaultWifiTransport = result.string("defaultWifiTransport");
    if (defaultWifiTransport !== "native" && defaultWifiTransport !== "esp8285")
      throw new PicoError(503, "Invalid radio default");
    return { features, defaultWifiTransport };
  }
  async flash(targetId: string, request: FlashRequest, emit: (event: ImageEvent) => void): Promise<void> {
    await this.command(["flash", "--target", targetId], request, emit);
  }
}

/** Host-wide imaging runs with private persistence and results independent of browser connections. */
export class PicoRuns {
  private readonly runs = new Map<string, ImageRun>();
  private busy = false;
  constructor(
    readonly imager: PicoImager,
    readonly settings: ImageSettings,
    private readonly file?: string,
  ) {
    if (file) {
      try {
        const saved = parseJson(readFileSync(file, "utf8"));
        if (!Array.isArray(saved)) throw new Error("Invalid stored imaging runs");
        for (const value of saved) {
          if (!isObject(value) || typeof value["id"] !== "string" || !Array.isArray(value["checks"]))
            throw new Error("Invalid stored imaging run");
          const run = value as unknown as ImageRun;
          if (!terminal(run.status)) {
            run.status = "failed";
            run.message = "The hub restarted before verification completed";
            run.updatedAt = Date.now();
            for (const check of run.checks)
              if (check.status !== "passed") {
                check.status = "failed";
                check.message = run.message;
              }
          }
          this.runs.set(run.id, run);
        }
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      this.save();
    }
  }
  private prune(): void {
    for (const [id, run] of this.runs) {
      if (terminal(run.status) && Date.now() - run.updatedAt > this.settings.retentionHours * 60 * 60 * 1000)
        this.runs.delete(id);
    }
  }
  private save(): void {
    this.prune();
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = this.file + ".new";
    writeFileSync(temp, JSON.stringify([...this.runs.values()]), { mode: 0o600 });
    renameSync(temp, this.file);
  }
  get(id: string): ImageRun {
    this.prune();
    const run = this.runs.get(id);
    if (!run) throw new PicoError(404, "Imaging run not found");
    return structuredClone(run);
  }
  async inventory(): Promise<{ targets: PicoTarget[]; activeRunId: string | null; pollMilliseconds: number }> {
    this.prune();
    const runs = [...this.runs.values()];
    const targets = await this.imager.discover();
    return {
      targets: targets.map((target) => ({
        ...target,
        latestRunId:
          runs.filter((run) => run.targetId === target.id || run.runtimeTargetId === target.id).at(-1)?.id ?? null,
      })),
      activeRunId: runs.find((run) => !terminal(run.status))?.id ?? null,
      pollMilliseconds: this.settings.pollMilliseconds,
    };
  }
  async start(targetId: string, value: unknown): Promise<ImageRun> {
    if (this.busy) throw new PicoError(409, "Another Pico is being imaged; wait for its results");
    this.busy = true;
    try {
      const { features } = await this.imager.catalog();
      const request = flashRequest(value, features);
      const target = (await this.imager.discover()).find((x) => x.id === targetId);
      if (!target) throw new PicoError(404, "The selected Pico is no longer connected");
      if (!target.available) throw new PicoError(503, target.unavailableReason ?? "The Pico is not accessible");
      const now = Date.now();
      const run: ImageRun = {
        id: randomUUID(),
        targetId,
        features: request.features,
        status: "queued",
        stage: "queued",
        message: "Imaging requested",
        createdAt: now,
        updatedAt: now,
        checks: request.features.map((feature) => ({
          feature,
          status: "pending",
          message: "Awaiting image startup",
          evidence: null,
        })),
      };
      this.runs.set(run.id, run);
      this.save();
      const snapshot = structuredClone(run);
      void this.execute(run, request);
      return snapshot;
    } catch (error) {
      this.busy = false;
      throw error;
    }
  }
  private async execute(run: ImageRun, request: FlashRequest): Promise<void> {
    let final: "passed" | "failed" | undefined;
    const safe = (text: string) =>
      request.wifi?.password ? text.replaceAll(request.wifi.password, "[redacted]") : text;
    try {
      run.status = "running";
      this.save();
      await this.imager.flash(run.targetId, request, (event) => {
        if (final) throw new Error("Output followed a final imaging result");
        if (event.type === "stage" && typeof event.stage === "string" && typeof event.message === "string") {
          run.stage = safe(event.stage);
          run.message = safe(event.message);
          if (event.runtimeTargetId !== undefined) {
            if (!/^runtime-[a-f0-9]+$/.test(event.runtimeTargetId)) throw new Error("Invalid runtime identity");
            run.runtimeTargetId = event.runtimeTargetId;
          }
        } else if (event.type === "check") {
          const f = new Fields(event.check, "image check");
          const feature = f.string("feature");
          const check = run.checks.find((x) => x.feature === feature);
          const status = f.string("status");
          if (!check || !["running", "passed", "failed"].includes(status ?? "")) throw new Error("Invalid image check");
          const verifiedEvidence = status === "passed" ? evidence(check.feature, f.value("evidence"), request) : null;
          check.status = status as ImageCheck["status"];
          check.message = safe(f.string("message") ?? "");
          check.evidence = verifiedEvidence;
        } else if (
          event.type === "result" &&
          ["passed", "failed"].includes(event.status) &&
          typeof event.message === "string"
        ) {
          final = event.status;
          run.message = safe(event.message);
        } else throw new Error("Invalid imaging event");
        run.updatedAt = Date.now();
        this.save();
      });
      if (final !== "passed" || run.checks.some((check) => check.status !== "passed"))
        throw new Error("Selected functions did not pass verification");
      run.status = "passed";
      run.stage = "complete";
    } catch {
      run.status = "failed";
      run.stage = "failed";
      if (!final || final === "passed")
        run.message = "Imaging stopped before every function was verified; check USB access and the host imaging setup";
      for (const check of run.checks)
        if (check.status !== "passed") {
          check.status = "failed";
          check.message ||= run.message;
        }
    } finally {
      run.updatedAt = Date.now();
      this.busy = false;
      this.save();
    }
  }
}

function evidence(feature: string, value: unknown, request: FlashRequest): Record<string, unknown> {
  const f = new Fields(value, "check evidence");
  const string = (key: string) => {
    const result = f.string(key);
    if (!result || (request.wifi?.password && result === request.wifi.password))
      throw new Error("Invalid check evidence");
    return result;
  };
  const integer = (key: string, min = 0) => {
    const result = f.int(key);
    if (result === null || result < min) throw new Error("Invalid check evidence");
    return result;
  };
  if (feature === "wifi") {
    const ip = string("ip");
    const transport = string("transport");
    if (!isIP(ip) || ip === "0.0.0.0" || ip === "::" || transport !== request.wifi?.transport)
      throw new Error("Invalid Wi-Fi result");
    return { ip, transport };
  }
  if (feature === "temperature") {
    const celsius = f.number("celsius");
    if (celsius === null || !Number.isFinite(celsius)) throw new Error("Invalid temperature result");
    return { celsius };
  }
  if (feature === "health")
    return { deviceId: string("deviceId"), bootId: string("bootId"), reports: integer("reports", 3) };
  if (feature === "i2c")
    return {
      deviceId: string("deviceId"),
      bootId: string("bootId"),
      sequence: integer("sequence"),
      bytes: integer("bytes"),
      dropped: integer("dropped"),
    };
  throw new Error("Unsupported check result");
}

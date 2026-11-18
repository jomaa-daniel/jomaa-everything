import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Fields, isObject, parseJson } from "./json.js";
import { releaseRoot } from "./settings.js";

export const imageConfigFile = new URL("jomaa-images/config.json", releaseRoot);
const terminal = (status: string) => status === "passed" || status === "failed";
const wifiTransports = ["native", "esp8285"] as const;
const runStatuses = ["queued", "running", "passed", "failed"] as const;
const checkStatuses = ["pending", "running", "passed", "failed"] as const;
const reportedStatuses = ["running", "passed", "failed"] as const;
const resultStatuses = ["passed", "failed"] as const;
const oneOf = <T extends string>(values: readonly T[], value: string | null): value is T =>
  values.some((x) => x === value);
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
export type WifiTransport = (typeof wifiTransports)[number];
export interface WifiSettings {
  ssid: string;
  password: string;
  transport: WifiTransport;
}
export interface FlashRequest {
  features: string[];
  wifi: WifiSettings | null;
}
export interface ImageCheck {
  feature: string;
  status: (typeof checkStatuses)[number];
  message: string;
  evidence: Record<string, unknown> | null;
}
export type ImageEvent =
  | { type: "stage"; stage: string; message: string; runtimeTargetId: string | null }
  | {
      type: "check";
      feature: string;
      status: (typeof reportedStatuses)[number];
      message: string;
      evidence: unknown;
    }
  | { type: "result"; status: (typeof resultStatuses)[number]; message: string };
export interface ImageRun {
  id: string;
  targetId: string;
  runtimeTargetId: string | null;
  features: string[];
  status: (typeof runStatuses)[number];
  wifiTransport: WifiTransport | null;
  stage: string;
  message: string;
  createdAt: number;
  updatedAt: number;
  checks: ImageCheck[];
}
export interface PicoImager {
  discover(): Promise<PicoTarget[]>;
  catalog(): Promise<{ features: Feature[]; defaultWifiTransport: WifiTransport }>;
  /** Flashes the target, passing each structured event it reports, unvalidated, to emit. */
  flash(targetId: string, request: FlashRequest, emit: (event: unknown) => void): Promise<void>;
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
  const f = new Fields(parseJson(readFileSync(imageConfigFile, "utf8")), "image settings");
  const command = f.list("command").filter((x): x is string => typeof x === "string" && x !== "");
  if (!command.length || command.length !== f.list("command").length) throw new Error("Invalid image command");
  const state = f.string("runStateFile");
  if (!state || state.startsWith("/") || state.split("/").includes("..")) throw new Error("Invalid runStateFile");
  const positive = (key: string) => {
    const value = f.int(key);
    if (value === null || value < 1) throw new Error(`Invalid image setting ${key}`);
    return value;
  };
  return {
    command,
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
  const f = new Fields(value, "image request").only("features", "wifi").required("features", "wifi");
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
  const ordered = catalog.filter((x) => features.includes(x.id)).map((x) => x.id);
  const supplied = f.value("wifi");
  if (features.includes("wifi") !== (supplied !== null))
    throw new PicoError(400, "Supply Wi-Fi settings only for Wi-Fi images");
  return { features: ordered, wifi: supplied === null ? null : wifiSettings(supplied) };
}

function wifiSettings(value: unknown): WifiSettings {
  const wifi = new Fields(value, "Wi-Fi")
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
    !oneOf(wifiTransports, transport)
  )
    throw new PicoError(400, "Invalid Wi-Fi settings");
  return { ssid, password, transport };
}

/** Validates one structured event reported by an imager. */
export function imageEvent(value: unknown): ImageEvent {
  const f = new Fields(value, "imaging event");
  const type = f.string("type");
  if (type === "stage") {
    f.only("type", "stage", "message", "runtimeTargetId").required("type", "stage", "message", "runtimeTargetId");
    const stage = f.string("stage");
    const message = f.string("message");
    const runtimeTargetId = f.string("runtimeTargetId");
    if (
      stage === null ||
      message === null ||
      (runtimeTargetId !== null && !/^runtime-[a-f0-9]+$/.test(runtimeTargetId))
    )
      throw new Error("Invalid stage event");
    return { type, stage, message, runtimeTargetId };
  }
  if (type === "check") {
    f.only("type", "check").required("type", "check");
    const check = new Fields(f.value("check"), "image check")
      .only("feature", "status", "message", "evidence")
      .required("feature", "status", "message", "evidence");
    const feature = check.string("feature");
    const status = check.string("status");
    const message = check.string("message");
    if (feature === null || message === null || !oneOf(reportedStatuses, status))
      throw new Error("Invalid check event");
    return { type, feature, status, message, evidence: check.value("evidence") };
  }
  if (type === "result") {
    f.only("type", "status", "message").required("type", "status", "message");
    const status = f.string("status");
    const message = f.string("message");
    if (message === null || !oneOf(resultStatuses, status)) throw new Error("Invalid result event");
    return { type, status, message };
  }
  throw new Error("Invalid imaging event");
}

/** Reads one stored run from the private run file. */
function storedRun(value: unknown): ImageRun {
  const f = new Fields(value, "stored imaging run");
  const string = (key: string) => {
    const result = f.string(key);
    if (result === null) throw new Error("Invalid stored imaging run");
    return result;
  };
  const time = (key: string) => {
    const result = f.int(key);
    if (result === null) throw new Error("Invalid stored imaging run");
    return result;
  };
  const status = f.string("status");
  const wifiTransport = f.string("wifiTransport");
  const features = f.list("features").filter((x): x is string => typeof x === "string");
  if (
    !oneOf(runStatuses, status) ||
    (wifiTransport !== null && !oneOf(wifiTransports, wifiTransport)) ||
    features.length !== f.list("features").length
  )
    throw new Error("Invalid stored imaging run");
  const checks = f.list("checks").map((item): ImageCheck => {
    const check = new Fields(item, "stored image check");
    const feature = check.string("feature");
    const checkStatus = check.string("status");
    const message = check.string("message");
    const evidence = check.value("evidence");
    if (
      feature === null ||
      message === null ||
      !oneOf(checkStatuses, checkStatus) ||
      !(evidence === null || isObject(evidence))
    )
      throw new Error("Invalid stored image check");
    return { feature, status: checkStatus, message, evidence };
  });
  return {
    id: string("id"),
    targetId: string("targetId"),
    runtimeTargetId: f.string("runtimeTargetId"),
    features,
    status,
    wifiTransport,
    stage: string("stage"),
    message: string("message"),
    createdAt: time("createdAt"),
    updatedAt: time("updatedAt"),
    checks,
  };
}

/** Runs the image component without a shell and accepts its structured output only. */
export class ImageCommand implements PicoImager {
  constructor(private readonly settings: ImageSettings) {}

  private command(
    args: string[],
    flash: { request: FlashRequest; emit: (event: unknown) => void } | null,
  ): Promise<unknown> {
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
        (flash ? this.settings.flashTimeoutSeconds : this.settings.commandTimeoutSeconds) * 1000,
      );
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > this.settings.maxOutputBytes) {
          stop();
          return;
        }
        output += chunk.toString("utf8");
        if (flash) {
          for (let newline = output.indexOf("\n"); newline >= 0; newline = output.indexOf("\n")) {
            const line = output.slice(0, newline);
            output = output.slice(newline + 1);
            try {
              flash.emit(parseJson(line));
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
        if (failed || code !== 0 || (flash && output.trim())) {
          reject(new PicoError(503, "Imaging stopped or exceeded its deadline; check the feature results"));
          return;
        }
        if (flash) resolve(undefined);
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
      child.stdin.end(flash ? JSON.stringify(flash.request) : "");
    });
  }

  async discover(): Promise<PicoTarget[]> {
    const result = new Fields(await this.command(["discover"], null), "USB inventory");
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
  async catalog(): Promise<{ features: Feature[]; defaultWifiTransport: WifiTransport }> {
    const result = new Fields(await this.command(["catalog"], null), "image catalog");
    const features = result.list("features").map((value) => {
      const f = new Fields(value, "image feature");
      const id = f.string("id");
      const requires = f.list("requires").filter((x): x is string => typeof x === "string");
      if (!id || requires.length !== f.list("requires").length) throw new PicoError(503, "Invalid image catalog");
      return {
        id,
        label: f.string("label") ?? id,
        description: f.string("description") ?? "",
        requires,
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
    if (!oneOf(wifiTransports, defaultWifiTransport)) throw new PicoError(503, "Invalid radio default");
    return { features, defaultWifiTransport };
  }
  async flash(targetId: string, request: FlashRequest, emit: (event: unknown) => void): Promise<void> {
    await this.command(["flash", "--target", targetId], { request, emit });
  }
}

/** Host-wide imaging runs with private persistence and results independent of browser connections. */
export class PicoRuns {
  private readonly runs = new Map<string, ImageRun>();
  private busy = false;
  constructor(
    readonly imager: PicoImager,
    readonly settings: ImageSettings,
    private readonly file: string | null,
  ) {
    if (file !== null) {
      try {
        const saved = parseJson(readFileSync(file, "utf8"));
        if (!Array.isArray(saved)) throw new Error("Invalid stored imaging runs");
        for (const value of saved) {
          const run = storedRun(value);
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
    if (this.file === null) return;
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
        runtimeTargetId: null,
        features: request.features,
        status: "queued",
        wifiTransport: request.wifi?.transport ?? null,
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
    const outcome: { final: "passed" | "failed" | null } = { final: null };
    const password = request.wifi?.password ?? "";
    const safe = (text: string) => (password ? text.replaceAll(password, "[redacted]") : text);
    try {
      run.status = "running";
      this.save();
      await this.imager.flash(run.targetId, request, (value) => {
        if (outcome.final) throw new Error("Output followed a final imaging result");
        const event = imageEvent(value);
        if (event.type === "stage") {
          run.stage = safe(event.stage);
          run.message = safe(event.message);
          if (event.runtimeTargetId !== null) run.runtimeTargetId = event.runtimeTargetId;
        } else if (event.type === "check") {
          const check = run.checks.find((x) => x.feature === event.feature);
          if (!check) throw new Error("Invalid image check");
          check.evidence = event.status === "passed" ? evidence(check.feature, event.evidence, request) : null;
          check.status = event.status;
          check.message = safe(event.message);
        } else {
          outcome.final = event.status;
          run.message = safe(event.message);
        }
        run.updatedAt = Date.now();
        this.save();
      });
      if (outcome.final !== "passed" || run.checks.some((check) => check.status !== "passed"))
        throw new Error("Selected functions did not pass verification");
      run.status = "passed";
      run.stage = "complete";
    } catch {
      run.status = "failed";
      run.stage = "failed";
      if (outcome.final !== "failed")
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
    if (!result) throw new Error("Invalid check evidence");
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
  if (feature === "fan") {
    const percentCurrent = integer("percentCurrent");
    const gpio = integer("gpio");
    if (percentCurrent > 100 || gpio > 28) throw new Error("Invalid fan PWM result");
    return {
      deviceId: string("deviceId"),
      bootId: string("bootId"),
      gpio,
      frequencyHz: integer("frequencyHz", 1),
      percentCurrent,
      appliedRevision: integer("appliedRevision"),
    };
  }
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

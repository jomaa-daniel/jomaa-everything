import { FanControl } from "@matter/main/clusters";
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { Fields, parseJson } from "../json.js";
import { imageConfigFile } from "../picos.js";
import { HealthError, type ManagedDevice } from "./store.js";

const maxPercent = 100;
const maxGpio = 28;

interface FanSettings {
  startupPercent: number;
  lowPercent: number;
  mediumPercent: number;
  staleMilliseconds: number;
}

function integer(value: unknown, name: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
    throw new HealthError(400, `${name} must be a whole number from ${min} to ${max}`);
  return value;
}

function fanSettings(): FanSettings {
  const root = new Fields(parseJson(readFileSync(imageConfigFile, "utf8")), "image settings");
  const f = new Fields(root.value("fan"), "fan settings");
  const result = {
    startupPercent: integer(f.value("startupPercent"), "fan.startupPercent", 0, maxPercent),
    lowPercent: integer(f.value("lowPercent"), "fan.lowPercent", 1, maxPercent - 1),
    mediumPercent: integer(f.value("mediumPercent"), "fan.mediumPercent", 1, maxPercent - 1),
    staleMilliseconds: integer(f.value("staleMilliseconds"), "fan.staleMilliseconds", 1),
  };
  if (
    result.lowPercent >= result.mediumPercent ||
    result.staleMilliseconds <= integer(f.value("pollMilliseconds"), "fan.pollMilliseconds", 1)
  )
    throw new Error("Invalid fan mode ranges or report lifetime");
  return result;
}

interface FanReport {
  bootId: string;
  installId: string;
  sequence: number;
  appliedRevision: number | null;
  percentCurrent: number;
  gpio: number;
  frequencyHz: number;
  inverted: boolean;
}

interface FanCommand {
  revision: number;
  fanMode: FanControl.FanMode;
  percentSetting: number;
}

export interface FanState extends FanCommand {
  clusterId: number;
  fanModeSequence: FanControl.FanModeSequence;
  percentCurrent: number | null;
  currentMeasurement: "pwmDuty";
  appliedRevision: number | null;
  pending: boolean;
  available: boolean;
  reportedAt: number;
  report: FanReport;
}

function report(body: Record<string, unknown>): FanReport {
  const f = new Fields(body, "fan report")
    .only("bootId", "installId", "sequence", "appliedRevision", "percentCurrent", "gpio", "frequencyHz", "inverted")
    .required(
      "bootId",
      "installId",
      "sequence",
      "appliedRevision",
      "percentCurrent",
      "gpio",
      "frequencyHz",
      "inverted",
    );
  const bootId = f.string("bootId");
  const installId = f.string("installId");
  if (bootId === null || !/^[a-f0-9]{16,64}$/.test(bootId) || installId === null || !/^[a-f0-9]{32}$/.test(installId))
    throw new HealthError(400, "Invalid fan boot or install identity");
  const inverted = f.bool("inverted");
  if (inverted === null) throw new HealthError(400, "inverted must be boolean");
  return {
    bootId,
    installId,
    sequence: integer(f.value("sequence"), "sequence", 0),
    appliedRevision:
      f.value("appliedRevision") === null ? null : integer(f.value("appliedRevision"), "appliedRevision", 0),
    percentCurrent: integer(f.value("percentCurrent"), "percentCurrent", 0, maxPercent),
    gpio: integer(f.value("gpio"), "gpio", 0, maxGpio),
    frequencyHz: integer(f.value("frequencyHz"), "frequencyHz", 1),
    inverted,
  };
}

/** Desired fan attributes and PWM reports persist with the device's health records. */
export class FanStore {
  private readonly settings = fanSettings();

  constructor(
    private readonly db: DatabaseSync,
    private readonly device: (id: string) => ManagedDevice,
    private readonly now: () => number,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS fans (
      device_id TEXT PRIMARY KEY REFERENCES credentials(id),
      revision INTEGER NOT NULL, percent_setting INTEGER NOT NULL,
      report TEXT NOT NULL, reported_at INTEGER NOT NULL
    )`);
  }

  private mode(percent: number): FanControl.FanMode {
    if (percent === 0) return FanControl.FanMode.Off;
    if (percent <= this.settings.lowPercent) return FanControl.FanMode.Low;
    if (percent <= this.settings.mediumPercent) return FanControl.FanMode.Medium;
    return FanControl.FanMode.High;
  }

  private row(id: string): Record<string, unknown> {
    const device = this.device(id);
    if (device.status === "revoked") throw new HealthError(403, "device credential revoked");
    const row = this.db.prepare("SELECT * FROM fans WHERE device_id=?").get(id);
    if (!row) throw new HealthError(404, "device has not reported fan control");
    const saved = JSON.parse(String(row["report"])) as FanReport;
    if (device.latest?.bootId !== saved.bootId)
      throw new HealthError(404, "fan control has not reported from the current boot");
    return row;
  }

  get(id: string): FanState {
    const row = this.row(id);
    const saved = JSON.parse(String(row["report"])) as FanReport;
    const percentSetting = Number(row["percent_setting"]);
    const revision = Number(row["revision"]);
    const available =
      this.now() - Number(row["reported_at"]) <= this.settings.staleMilliseconds &&
      ["online", "degraded"].includes(this.device(id).status);
    return {
      clusterId: FanControl.id,
      fanModeSequence: FanControl.FanModeSequence.OffLowMedHigh,
      fanMode: this.mode(percentSetting),
      percentSetting,
      revision,
      percentCurrent: available ? saved.percentCurrent : null,
      currentMeasurement: "pwmDuty",
      appliedRevision: saved.appliedRevision,
      pending: !available || saved.appliedRevision !== revision,
      available,
      reportedAt: Number(row["reported_at"]),
      report: saved,
    };
  }

  write(id: string, body: Record<string, unknown>): FanState {
    this.row(id);
    const keys = Object.keys(body);
    if (keys.length !== 1 || !["fanMode", "percentSetting"].includes(keys[0] ?? ""))
      throw new HealthError(400, "Write one of fanMode or percentSetting");
    let percent: number;
    if (keys[0] === "fanMode") {
      const mode = integer(body["fanMode"], "fanMode", FanControl.FanMode.Off, FanControl.FanMode.High);
      const modePercent = new Map<number, number>([
        [FanControl.FanMode.Off, 0],
        [FanControl.FanMode.Low, this.settings.lowPercent],
        [FanControl.FanMode.Medium, this.settings.mediumPercent],
        [FanControl.FanMode.High, maxPercent],
      ]).get(mode);
      if (modePercent === undefined) throw new HealthError(400, "Unsupported fanMode");
      percent = modePercent;
    } else {
      if (body["percentSetting"] === null) return this.get(id);
      percent = integer(body["percentSetting"], "percentSetting", 0, maxPercent);
    }
    const current = this.get(id);
    if (percent !== current.percentSetting) {
      if (current.revision === Number.MAX_SAFE_INTEGER) throw new HealthError(409, "Fan revision exhausted");
      this.db.prepare("UPDATE fans SET percent_setting=?,revision=revision+1 WHERE device_id=?").run(percent, id);
    }
    return this.get(id);
  }

  record(id: string, body: Record<string, unknown>): { ok: true; command: FanCommand } {
    const value = report(body);
    const device = this.device(id);
    if (device.status === "revoked") throw new HealthError(403, "device credential revoked");
    if (device.latest?.bootId !== value.bootId)
      throw new HealthError(409, "Send health from this boot before fan state");
    const row = this.db.prepare("SELECT * FROM fans WHERE device_id=?").get(id);
    const revision = row ? Number(row["revision"]) : 0;
    const percentSetting = row ? Number(row["percent_setting"]) : this.settings.startupPercent;
    const command = { revision, percentSetting, fanMode: this.mode(percentSetting) };
    const saved = row ? (JSON.parse(String(row["report"])) as FanReport) : null;
    if (saved?.bootId === value.bootId && value.sequence <= saved.sequence) return { ok: true, command };
    if (
      saved?.bootId === value.bootId &&
      (saved.installId !== value.installId ||
        (saved.appliedRevision !== null &&
          (value.appliedRevision === null || value.appliedRevision < saved.appliedRevision)))
    )
      throw new HealthError(400, "Fan report identity or revision went backwards");
    if (
      value.appliedRevision !== null &&
      (value.appliedRevision > revision ||
        (value.appliedRevision === revision && value.percentCurrent !== percentSetting))
    )
      throw new HealthError(400, "Fan report does not match its acknowledged command");
    this.db
      .prepare(
        `INSERT INTO fans(device_id,revision,percent_setting,report,reported_at) VALUES(?,?,?,?,?)
      ON CONFLICT(device_id) DO UPDATE SET report=excluded.report,reported_at=excluded.reported_at`,
      )
      .run(id, revision, percentSetting, JSON.stringify(value), this.now());
    return { ok: true, command };
  }
}

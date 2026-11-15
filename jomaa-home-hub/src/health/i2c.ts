import type { DatabaseSync } from "node:sqlite";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import type { I2CSettings } from "../settings.js";
import { HealthError } from "./store.js";

export interface Capture {
  bootId: string;
  sequence: number;
  bus: number;
  startUs: number;
  endUs: number;
  data: string;
  dropped: number;
}

export interface CaptureLog extends Capture {
  id: number;
  receivedAt: number;
  firstSequence: number;
  captures: number;
  condensed: string;
}

function integer(value: unknown, name: string, min = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min)
    throw new HealthError(400, `${name} must be a whole number of at least ${min}`);
  return value;
}

function capture(body: Record<string, unknown>, maxDataBytes: number): Capture {
  const keys = ["bootId", "sequence", "bus", "startUs", "endUs", "data", "dropped"];
  for (const key of Object.keys(body)) if (!keys.includes(key)) throw new HealthError(400, `unknown field: ${key}`);
  if (typeof body["bootId"] !== "string" || !/^[a-f0-9]{16,64}$/.test(body["bootId"]))
    throw new HealthError(400, "bootId must be hexadecimal");
  const data = body["data"];
  if (typeof data !== "string" || !/^(?:[a-f0-9]{2})*$/.test(data) || data.length > maxDataBytes * 2)
    throw new HealthError(400, "data must be bounded, lowercase hexadecimal bytes");
  const bus = integer(body["bus"], "bus");
  if (bus > 1) throw new HealthError(400, "bus must be 0 or 1");
  const startUs = integer(body["startUs"], "startUs");
  const endUs = integer(body["endUs"], "endUs");
  if (endUs <= startUs) throw new HealthError(400, "endUs must exceed startUs");
  return {
    bootId: body["bootId"],
    sequence: integer(body["sequence"], "sequence"),
    bus,
    startUs,
    endUs,
    data,
    dropped: integer(body["dropped"], "dropped"),
  };
}

/** Lossless string encodings retain zero bytes and condense captures with no bus activity. */
export function condense(data: string, captures: number): string {
  if (!data) return `empty:${captures}`;
  const literal = "hex:" + data;
  const compressed = "deflate:" + deflateRawSync(Buffer.from(data, "hex")).toString("base64");
  const zero = /^0+$/.test(data) ? `zero:${data.length / 2}` : literal;
  return [literal, compressed, zero].reduce((shortest, value) => (value.length < shortest.length ? value : shortest));
}

export function expand(value: string, maxDataBytes: number): string {
  const [encoding, data] = value.split(":", 2);
  if (encoding === "empty") return "";
  if (encoding === "zero") return "00".repeat(Number(data));
  if (encoding === "hex") return data ?? "";
  if (encoding === "deflate")
    return inflateRawSync(Buffer.from(data ?? "", "base64"), { maxOutputLength: maxDataBytes }).toString("hex");
  throw new Error("invalid stored capture encoding");
}

/** Raw captures use the health connection, with separate sequence tracking and live notifications. */
export class I2CStore {
  readonly #listeners = new Map<string, Set<(entry: CaptureLog) => void>>();
  #clients = 0;

  constructor(
    private readonly db: DatabaseSync,
    private readonly settings: I2CSettings,
    private readonly requireDevice: (id: string) => unknown,
    private readonly now: () => number,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS i2c_boots (
        device_id TEXT NOT NULL REFERENCES credentials(id), boot_id TEXT NOT NULL,
        bus INTEGER NOT NULL, sequence INTEGER NOT NULL, end_us INTEGER NOT NULL,
        PRIMARY KEY(device_id,boot_id,bus)
      );
      CREATE TABLE IF NOT EXISTS i2c_logs (
        id INTEGER PRIMARY KEY, device_id TEXT NOT NULL REFERENCES credentials(id),
        boot_id TEXT NOT NULL, bus INTEGER NOT NULL, first_sequence INTEGER NOT NULL,
        sequence INTEGER NOT NULL, start_us INTEGER NOT NULL, end_us INTEGER NOT NULL,
        received_at INTEGER NOT NULL, captures INTEGER NOT NULL, dropped INTEGER NOT NULL,
        condensed TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS i2c_device ON i2c_logs(device_id,id DESC);
      CREATE INDEX IF NOT EXISTS i2c_received ON i2c_logs(received_at);
    `);
  }

  record(id: string, body: Record<string, unknown>): { duplicate: boolean; entry?: CaptureLog } {
    this.requireDevice(id);
    const value = capture(body, this.settings.maxDataBytes);
    const boot = this.db
      .prepare("SELECT sequence,end_us FROM i2c_boots WHERE device_id=? AND boot_id=? AND bus=?")
      .get(id, value.bootId, value.bus);
    if (boot && value.sequence <= Number(boot["sequence"])) return { duplicate: true };
    if (boot && value.startUs < Number(boot["end_us"])) throw new HealthError(400, "capture times overlap");
    const previous = this.db
      .prepare("SELECT * FROM i2c_logs WHERE device_id=? AND bus=? ORDER BY id DESC LIMIT 1")
      .get(id, value.bus);
    const merge =
      previous &&
      value.data === "" &&
      value.dropped === 0 &&
      previous["dropped"] === 0 &&
      String(previous["condensed"]).startsWith("empty:") &&
      previous["boot_id"] === value.bootId &&
      Number(previous["sequence"]) + 1 === value.sequence &&
      previous["end_us"] === value.startUs;
    this.db.exec("BEGIN IMMEDIATE");
    let rowId: number;
    try {
      if (merge) {
        rowId = Number(previous["id"]);
        const captures = Number(previous["captures"]) + 1;
        this.db
          .prepare("UPDATE i2c_logs SET sequence=?,end_us=?,received_at=?,captures=?,condensed=? WHERE id=?")
          .run(value.sequence, value.endUs, this.now(), captures, condense("", captures), rowId);
      } else {
        rowId = Number(
          this.db
            .prepare(
              `INSERT INTO i2c_logs
          (device_id,boot_id,bus,first_sequence,sequence,start_us,end_us,received_at,captures,dropped,condensed)
          VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
            )
            .run(
              id,
              value.bootId,
              value.bus,
              value.sequence,
              value.sequence,
              value.startUs,
              value.endUs,
              this.now(),
              1,
              value.dropped,
              condense(value.data, 1),
            ).lastInsertRowid,
        );
      }
      this.db
        .prepare(
          `INSERT INTO i2c_boots(device_id,boot_id,bus,sequence,end_us) VALUES(?,?,?,?,?)
        ON CONFLICT(device_id,boot_id,bus) DO UPDATE SET sequence=excluded.sequence,end_us=excluded.end_us`,
        )
        .run(id, value.bootId, value.bus, value.sequence, value.endUs);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    const row = this.db.prepare("SELECT * FROM i2c_logs WHERE id=?").get(rowId);
    if (!row) throw new Error("capture missing after commit");
    const entry = this.#entry(row);
    for (const listener of this.#listeners.get(id) ?? []) listener(entry);
    return { duplicate: false, entry };
  }

  logs(
    id: string,
    limit = this.settings.historyLimit,
    before?: number,
  ): { logs: CaptureLog[]; nextCursor: number | null } {
    this.requireDevice(id);
    integer(limit, "limit", 1);
    if (limit > Math.max(this.settings.historyLimit, this.settings.liveRows))
      throw new HealthError(400, "limit too large");
    if (before !== undefined) integer(before, "before", 1);
    const rows = this.db
      .prepare("SELECT * FROM i2c_logs WHERE device_id=? AND id<? ORDER BY id DESC LIMIT ?")
      .all(id, before ?? Number.MAX_SAFE_INTEGER, limit);
    const logs = rows.map((row) => this.#entry(row));
    return { logs, nextCursor: logs.length === limit ? (logs.at(-1)?.id ?? null) : null };
  }

  subscribe(id: string, listener: (entry: CaptureLog) => void): () => void {
    this.requireDevice(id);
    if (this.#clients >= this.settings.maxLiveClients) throw new HealthError(503, "too many live viewers");
    const listeners = this.#listeners.get(id) ?? new Set();
    this.#listeners.set(id, listeners);
    listeners.add(listener);
    this.#clients += 1;
    return () => {
      if (listeners.delete(listener)) this.#clients -= 1;
      if (!listeners.size) this.#listeners.delete(id);
    };
  }

  prune(cutoff: number): void {
    this.db.prepare("DELETE FROM i2c_logs WHERE received_at<?").run(cutoff);
  }

  #entry(row: Record<string, unknown>): CaptureLog {
    const condensed = String(row["condensed"]);
    return {
      id: Number(row["id"]),
      receivedAt: Number(row["received_at"]),
      bootId: String(row["boot_id"]),
      bus: Number(row["bus"]),
      firstSequence: Number(row["first_sequence"]),
      sequence: Number(row["sequence"]),
      startUs: Number(row["start_us"]),
      endUs: Number(row["end_us"]),
      captures: Number(row["captures"]),
      data: expand(condensed, this.settings.maxDataBytes),
      dropped: Number(row["dropped"]),
      condensed,
    };
  }
}

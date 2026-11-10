import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { isIP } from "node:net";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export class HealthError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface Heartbeat {
  bootId: string;
  sequence: number;
  firmware: string;
  uptimeSeconds: number;
  freeHeapBytes: number;
  rssi?: number;
  ip?: string;
  status: "healthy" | "degraded";
  message?: string;
}

export interface ManagedDevice {
  id: string;
  name: string;
  intervalSeconds: number;
  status: "pending" | "online" | "degraded" | "offline" | "revoked";
  enrolledAt: number;
  registeredAt: number | null;
  lastSeen: number | null;
  latest: Heartbeat | null;
}

interface DeviceRow {
  id: string;
  name: string;
  interval_seconds: number;
  revoked: number;
  enrolled_at: number;
  registered_at: number | null;
  last_seen: number | null;
  latest: string | null;
}

const deviceSelect = `SELECT c.id, c.name, c.interval_seconds, c.revoked, c.enrolled_at,
  d.registered_at, d.last_seen, d.latest FROM credentials c LEFT JOIN devices d ON d.id = c.id`;
const hash = (token: string) => createHash("sha256").update(token).digest();

/** Credentials are issued by an administrator; registration happens on the first ping. */
export class HealthStore {
  readonly #db: DatabaseSync;
  readonly retentionDays: number;
  now: () => number = Date.now;

  constructor(path: string, retentionDays = 30) {
    if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) {
      throw new Error("HEALTH_RETENTION_DAYS must be a whole number from 1 to 3650");
    }
    this.retentionDays = retentionDays;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const oldMask = process.umask(0o077);
    try {
      this.#db = new DatabaseSync(path);
      this.#db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;");
    } finally {
      process.umask(oldMask);
    }
    if (path !== ":memory:") chmodSync(path, 0o600);
    const version = this.#db.prepare("PRAGMA user_version").get()?.["user_version"];
    if (typeof version !== "number" || version > 1) {
      this.#db.close();
      throw new Error("unsupported health database version");
    }
    this.#db.exec(`
      BEGIN;
      CREATE TABLE IF NOT EXISTS credentials (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash BLOB NOT NULL,
        interval_seconds INTEGER NOT NULL, enrolled_at INTEGER NOT NULL,
        revoked INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY REFERENCES credentials(id), registered_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL, latest TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS boots (
        device_id TEXT NOT NULL REFERENCES credentials(id), boot_id TEXT NOT NULL,
        sequence INTEGER NOT NULL, PRIMARY KEY(device_id, boot_id)
      );
      CREATE TABLE IF NOT EXISTS health_logs (
        id INTEGER PRIMARY KEY, device_id TEXT NOT NULL REFERENCES credentials(id),
        received_at INTEGER NOT NULL, payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS logs_device ON health_logs(device_id, id DESC);
      CREATE INDEX IF NOT EXISTS logs_received ON health_logs(received_at);
      PRAGMA user_version=1;
      COMMIT;
    `);
    this.prune();
  }

  enroll(body: Record<string, unknown>): { device: ManagedDevice; token: string } {
    allowed(body, ["id", "name", "intervalSeconds"]);
    const id = text(body["id"], "id", 3, 64);
    if (!/^[a-z0-9][a-z0-9_-]+$/.test(id)) throw new HealthError(400, "id must use lowercase letters, numbers, _ or -");
    const name = text(body["name"], "name", 1, 80).trim();
    if (!name) throw new HealthError(400, "name is required");
    const interval = integer(body["intervalSeconds"] ?? 60, "intervalSeconds", 15, 3600);
    if (this.#db.prepare("SELECT id FROM credentials WHERE id=?").get(id)) {
      throw new HealthError(409, "device already enrolled; rotate its credential to provision again");
    }
    const token = randomBytes(32).toString("hex");
    this.#db
      .prepare("INSERT INTO credentials(id,name,token_hash,interval_seconds,enrolled_at) VALUES(?,?,?,?,?)")
      .run(id, name, hash(token), interval, this.now());
    return { device: this.get(id), token };
  }

  authenticate(id: string, token: string): void {
    const row = this.#db.prepare("SELECT token_hash, revoked FROM credentials WHERE id=?").get(id);
    const expected = row?.["token_hash"];
    if (
      !/^[a-f0-9]{64}$/.test(token) ||
      !(expected instanceof Uint8Array) ||
      row?.["revoked"] !== 0 ||
      !timingSafeEqual(hash(token), expected)
    ) {
      throw new HealthError(401, "invalid device credential");
    }
  }

  record(
    id: string,
    body: Record<string, unknown>,
  ): { registered: boolean; duplicate: boolean; nextIntervalSeconds: number } {
    const ping = heartbeat(body);
    const device = this.get(id);
    if (device.status === "revoked") throw new HealthError(401, "invalid device credential");
    const boot = this.#db.prepare("SELECT sequence FROM boots WHERE device_id=? AND boot_id=?").get(id, ping.bootId);
    if (typeof boot?.["sequence"] === "number" && ping.sequence <= boot["sequence"]) {
      return { registered: false, duplicate: true, nextIntervalSeconds: device.intervalSeconds };
    }
    // A malfunctioning device cannot fill the disk with requests. Retries are idempotent above.
    if (device.lastSeen !== null && this.now() - device.lastSeen < 5000) {
      throw new HealthError(429, "health reports must be at least five seconds apart");
    }
    const now = this.now();
    const payload = JSON.stringify(ping);
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db
        .prepare(
          `INSERT INTO devices(id,registered_at,last_seen,latest) VALUES(?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen, latest=excluded.latest`,
        )
        .run(id, now, now, payload);
      this.#db.prepare("INSERT INTO health_logs(device_id,received_at,payload) VALUES(?,?,?)").run(id, now, payload);
      this.#db
        .prepare(
          `INSERT INTO boots(device_id,boot_id,sequence) VALUES(?,?,?)
        ON CONFLICT(device_id,boot_id) DO UPDATE SET sequence=excluded.sequence`,
        )
        .run(id, ping.bootId, ping.sequence);
      this.#db.exec("COMMIT");
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
    return { registered: device.registeredAt === null, duplicate: false, nextIntervalSeconds: device.intervalSeconds };
  }

  list(): ManagedDevice[] {
    return (this.#db.prepare(deviceSelect + " ORDER BY c.enrolled_at DESC, c.id").all() as unknown as DeviceRow[]).map(
      (row) => this.#device(row),
    );
  }

  get(id: string): ManagedDevice {
    const row = this.#db.prepare(deviceSelect + " WHERE c.id=?").get(id) as unknown as DeviceRow | undefined;
    if (!row) throw new HealthError(404, "device not found");
    return this.#device(row);
  }

  update(id: string, body: Record<string, unknown>): ManagedDevice {
    allowed(body, ["name", "intervalSeconds"]);
    const current = this.get(id);
    const name = body["name"] === undefined ? current.name : text(body["name"], "name", 1, 80).trim();
    if (!name) throw new HealthError(400, "name is required");
    const interval =
      body["intervalSeconds"] === undefined
        ? current.intervalSeconds
        : integer(body["intervalSeconds"], "intervalSeconds", 15, 3600);
    this.#db.prepare("UPDATE credentials SET name=?,interval_seconds=? WHERE id=?").run(name, interval, id);
    return this.get(id);
  }

  revoke(id: string): ManagedDevice {
    this.get(id);
    this.#db.prepare("UPDATE credentials SET revoked=1 WHERE id=?").run(id);
    return this.get(id);
  }

  rotate(id: string): { device: ManagedDevice; token: string } {
    this.get(id);
    const token = randomBytes(32).toString("hex");
    this.#db.prepare("UPDATE credentials SET token_hash=?,revoked=0 WHERE id=?").run(hash(token), id);
    return { device: this.get(id), token };
  }

  logs(
    id: string,
    limit = 100,
    before?: number,
  ): { logs: { id: number; receivedAt: number; heartbeat: Heartbeat }[]; nextCursor: number | null } {
    this.get(id);
    integer(limit, "limit", 1, 200);
    if (before !== undefined) integer(before, "before", 1, Number.MAX_SAFE_INTEGER);
    const rows = this.#db
      .prepare(
        `SELECT id,received_at,payload FROM health_logs
      WHERE device_id=? AND id<? ORDER BY id DESC LIMIT ?`,
      )
      .all(id, before ?? Number.MAX_SAFE_INTEGER, limit);
    const logs = rows.map((r) => ({
      id: Number(r["id"]),
      receivedAt: Number(r["received_at"]),
      heartbeat: JSON.parse(String(r["payload"])) as Heartbeat,
    }));
    return { logs, nextCursor: logs.length === limit ? (logs.at(-1)?.id ?? null) : null };
  }

  prune(): void {
    this.#db.prepare("DELETE FROM health_logs WHERE received_at<?").run(this.now() - this.retentionDays * 86400_000);
  }

  close(): void {
    this.#db.close();
  }

  #device(row: DeviceRow): ManagedDevice {
    const latest = row.latest === null ? null : (JSON.parse(row.latest) as Heartbeat);
    const status = row.revoked
      ? "revoked"
      : row.last_seen === null
        ? "pending"
        : this.now() - row.last_seen > Math.max(90, row.interval_seconds * 3) * 1000
          ? "offline"
          : latest?.status === "degraded"
            ? "degraded"
            : "online";
    return {
      id: row.id,
      name: row.name,
      intervalSeconds: row.interval_seconds,
      status,
      enrolledAt: row.enrolled_at,
      registeredAt: row.registered_at,
      lastSeen: row.last_seen,
      latest,
    };
  }
}

function allowed(body: Record<string, unknown>, keys: string[]): void {
  for (const key of Object.keys(body)) if (!keys.includes(key)) throw new HealthError(400, `unknown field: ${key}`);
}

function text(value: unknown, name: string, min: number, max: number): string {
  if (
    typeof value !== "string" ||
    value.length < min ||
    value.length > max ||
    Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  ) {
    throw new HealthError(400, `${name} must be text of ${min}–${max} characters without control characters`);
  }
  return value;
}

function integer(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new HealthError(400, `${name} must be a whole number from ${min} to ${max}`);
  }
  return value;
}

export function heartbeat(body: Record<string, unknown>): Heartbeat {
  allowed(body, [
    "bootId",
    "sequence",
    "firmware",
    "uptimeSeconds",
    "freeHeapBytes",
    "rssi",
    "ip",
    "status",
    "message",
  ]);
  const bootId = text(body["bootId"], "bootId", 16, 64);
  if (!/^[a-f0-9]+$/.test(bootId)) throw new HealthError(400, "bootId must be hexadecimal");
  if (body["status"] !== "healthy" && body["status"] !== "degraded")
    throw new HealthError(400, "status must be healthy or degraded");
  const ping: Heartbeat = {
    bootId,
    sequence: integer(body["sequence"], "sequence", 0, Number.MAX_SAFE_INTEGER),
    firmware: text(body["firmware"], "firmware", 1, 80),
    uptimeSeconds: integer(body["uptimeSeconds"], "uptimeSeconds", 0, Number.MAX_SAFE_INTEGER),
    freeHeapBytes: integer(body["freeHeapBytes"], "freeHeapBytes", 0, Number.MAX_SAFE_INTEGER),
    status: body["status"],
  };
  if (body["rssi"] !== undefined) ping.rssi = integer(body["rssi"], "rssi", -127, 0);
  if (body["ip"] !== undefined) {
    ping.ip = text(body["ip"], "ip", 3, 45);
    if (!isIP(ping.ip)) throw new HealthError(400, "ip must be an IP address");
  }
  if (body["message"] !== undefined) ping.message = text(body["message"], "message", 1, 240);
  return ping;
}

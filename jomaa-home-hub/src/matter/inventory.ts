import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Log } from "../log.js";

export const uptimeAttribute = "0/51/2";

export interface Observation {
  displayName: string | null;
  lastSeen: number | null;
  uptimeSeconds: number | null;
  uptimeObservedAt: number | null;
}

interface Row {
  name: string | null;
  last_seen: number | null;
  uptime_seconds: number | null;
  uptime_observed_at: number | null;
}

/** Hub names and timestamps of successful Matter communication. */
export class MatterInventory {
  readonly #db: DatabaseSync;
  now: () => number = Date.now;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const mask = process.umask(0o077);
    try {
      this.#db = new DatabaseSync(path);
      this.#db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;");
    } finally {
      process.umask(mask);
    }
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.#db.exec(`CREATE TABLE IF NOT EXISTS matter_inventory (
      node_id INTEGER PRIMARY KEY,
      name TEXT,
      last_seen INTEGER,
      uptime_seconds INTEGER,
      uptime_observed_at INTEGER
    )`);
  }

  get(nodeId: number): Observation {
    const row = this.#db
      .prepare("SELECT name, last_seen, uptime_seconds, uptime_observed_at FROM matter_inventory WHERE node_id=?")
      .get(nodeId) as Row | undefined;
    return {
      displayName: row?.name ?? null,
      lastSeen: row?.last_seen ?? null,
      uptimeSeconds: row?.uptime_seconds ?? null,
      uptimeObservedAt: row?.uptime_observed_at ?? null,
    };
  }

  rename(nodeId: number, name: string): void {
    name = name.trim();
    if (name.length < 1 || name.length > 80) throw new RangeError("name must contain 1 to 80 characters");
    this.#db
      .prepare(
        `INSERT INTO matter_inventory (node_id, name) VALUES (?, ?)
      ON CONFLICT(node_id) DO UPDATE SET name=excluded.name`,
      )
      .run(nodeId, name);
  }

  /** Records successful contact; an omitted uptime leaves its sample unchanged. */
  seen(nodeId: number, uptime?: number | null): void {
    const observedAt = this.now();
    if (uptime === undefined) {
      this.#db
        .prepare(
          `INSERT INTO matter_inventory (node_id, last_seen) VALUES (?, ?)
        ON CONFLICT(node_id) DO UPDATE SET last_seen=excluded.last_seen`,
        )
        .run(nodeId, observedAt);
    } else {
      this.#db
        .prepare(
          `INSERT INTO matter_inventory (node_id, last_seen, uptime_seconds, uptime_observed_at)
        VALUES (?, ?, ?, ?) ON CONFLICT(node_id) DO UPDATE SET
        last_seen=excluded.last_seen, uptime_seconds=excluded.uptime_seconds,
        uptime_observed_at=excluded.uptime_observed_at`,
        )
        .run(nodeId, observedAt, uptime, uptime === null ? null : observedAt);
    }
  }

  remove(nodeId: number): void {
    this.#db.prepare("DELETE FROM matter_inventory WHERE node_id=?").run(nodeId);
  }

  close(): void {
    this.#db.close();
  }
}

/** Converts the device's diagnostic value to a safe JSON number. */
export function uptimeSeconds(value: unknown): number | null {
  if (typeof value === "bigint" && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export interface ObservationReader {
  nodes(): Array<{ nodeId: number; available: boolean; supportsUptime: boolean }>;
  hasNode(nodeId: number): boolean;
  read(nodeId: number, paths: string[]): Promise<Readonly<Record<string, unknown>>>;
}

/** Polls available nodes for real contact and optional diagnostic uptime. */
export class MatterMonitor {
  readonly #pending = new Map<number, Promise<void>>();
  readonly #missingUptime = new Set<number>();
  #timer: ReturnType<typeof setTimeout> | null = null;
  #stopped = false;

  constructor(
    private readonly reader: ObservationReader,
    private readonly inventory: MatterInventory,
    private readonly log: Log,
  ) {}

  start(): void {
    this.#cycle();
  }

  #cycle = (): void => {
    if (this.#stopped) return;
    for (const node of this.reader.nodes()) {
      if (node.available) void this.probe(node.nodeId);
    }
    this.#timer = setTimeout(this.#cycle, 30_000);
    this.#timer.unref();
  };

  probe(nodeId: number): Promise<void> | undefined {
    if (this.#stopped || this.#pending.has(nodeId)) return;
    const node = this.reader.nodes().find((candidate) => candidate.nodeId === nodeId);
    if (!node?.available) return;
    const readUptime = node.supportsUptime || !this.#missingUptime.has(nodeId);
    const paths = ["0/40/1", ...(readUptime ? [uptimeAttribute] : [])];
    const operation = Promise.resolve()
      .then(() => (this.#stopped || !this.reader.hasNode(nodeId) ? undefined : this.reader.read(nodeId, paths)))
      .then((attributes) => {
        if (attributes === undefined || this.#stopped || !this.reader.hasNode(nodeId)) return;
        if (readUptime && !(uptimeAttribute in attributes)) this.#missingUptime.add(nodeId);
        this.inventory.seen(nodeId, uptimeSeconds(attributes[uptimeAttribute]));
      })
      .catch((err: unknown) => {
        if (!this.#stopped) this.log.warn("matter diagnostic read failed", { nodeId, err });
      })
      .finally(() => this.#pending.delete(nodeId));
    this.#pending.set(nodeId, operation);
    return operation;
  }

  refreshCapabilities(nodeId: number): void {
    this.#missingUptime.delete(nodeId);
    void this.probe(nodeId);
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
  }
}

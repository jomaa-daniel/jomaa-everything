import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export class OrganizationError extends Error {}

export interface DeviceType {
  id: string;
  name: string;
  hue: number;
}

/** Editable device categories and membership for reporting-only devices. */
export class Organization {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const mask = process.umask(0o077);
    try {
      this.#db = new DatabaseSync(path);
    } finally {
      process.umask(mask);
    }
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.#db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS device_types (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, hue REAL NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS device_categories (device_key TEXT PRIMARY KEY, type_id TEXT REFERENCES device_types(id) ON DELETE SET NULL);
      CREATE TABLE IF NOT EXISTS device_groups (device_key TEXT NOT NULL, group_id TEXT NOT NULL, PRIMARY KEY(device_key, group_id));`);
  }

  types(): DeviceType[] {
    return this.#db.prepare("SELECT id, name, hue FROM device_types ORDER BY name").all() as unknown as DeviceType[];
  }

  createType(name: string): DeviceType {
    name = this.#name(name);
    const types = this.types();
    if (types.some((type) => type.name.toLowerCase() === name.toLowerCase()))
      throw new OrganizationError("Type name already exists");
    const base =
      name
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || "type";
    let id = base;
    for (let suffix = 2; types.some((type) => type.id === id); suffix++) id = `${base}-${suffix}`;
    let hue = (types.length * 137.508) % 360;
    while (types.some((type) => type.hue === hue)) hue = (hue + 137.508) % 360;
    this.#db.prepare("INSERT INTO device_types VALUES (?, ?, ?)").run(id, name, hue);
    return { id, name, hue };
  }

  renameType(id: string, name: string): void {
    name = this.#name(name);
    if (!this.types().some((type) => type.id === id)) throw new OrganizationError("Type not found");
    if (this.types().some((type) => type.id !== id && type.name.toLowerCase() === name.toLowerCase()))
      throw new OrganizationError("Type name already exists");
    this.#db.prepare("UPDATE device_types SET name=? WHERE id=?").run(name, id);
  }

  deleteType(id: string): void {
    if (!this.types().some((type) => type.id === id)) throw new OrganizationError("Type not found");
    this.#db.prepare("DELETE FROM device_types WHERE id=?").run(id);
  }

  assignedType(key: string): DeviceType | null {
    return (
      (this.#db
        .prepare(
          `SELECT t.id, t.name, t.hue FROM device_categories c JOIN device_types t ON c.type_id=t.id WHERE c.device_key=?`,
        )
        .get(key) as unknown as DeviceType | undefined) ?? null
    );
  }

  assign(key: string, typeId: string | null): void {
    if (typeId !== null && !this.types().some((type) => type.id === typeId))
      throw new OrganizationError("Type not found");
    this.#db
      .prepare(
        "INSERT INTO device_categories VALUES (?, ?) ON CONFLICT(device_key) DO UPDATE SET type_id=excluded.type_id",
      )
      .run(key, typeId);
  }

  groups(key: string): string[] {
    return this.#db
      .prepare("SELECT group_id FROM device_groups WHERE device_key=? ORDER BY group_id")
      .all(key)
      .map((row) => String(row["group_id"]));
  }

  assignGroups(key: string, ids: string[]): void {
    this.#db.exec("BEGIN");
    try {
      this.#db.prepare("DELETE FROM device_groups WHERE device_key=?").run(key);
      for (const id of new Set(ids)) this.#db.prepare("INSERT INTO device_groups VALUES (?, ?)").run(key, id);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  removeGroup(id: string): void {
    this.#db.prepare("DELETE FROM device_groups WHERE group_id=?").run(id);
  }

  removeDevice(key: string): void {
    this.#db.prepare("DELETE FROM device_categories WHERE device_key=?").run(key);
    this.#db.prepare("DELETE FROM device_groups WHERE device_key=?").run(key);
  }

  #name(value: string): string {
    const name = value.trim();
    if (!name || name.length > 80) throw new OrganizationError("Name must contain 1 to 80 characters");
    return name;
  }

  close(): void {
    this.#db.close();
  }
}

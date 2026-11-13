// The provider and local Tailscale commands, reached only through
// jomaa-tailscale/tailnet.py. The hub never holds the API token: the script
// reads it from its own .env and prints only sanitized JSON.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { settings, settingsFile } from "./settings.js";
import { Fields, JsonShapeError, parseJson } from "./json.js";

/** tailnet.py, from settings.tailscale.script relative to the hub directory. */
export function scriptPath(): string {
  return fileURLToPath(new URL(settings.tailscale.script, settingsFile));
}

/** The access tables, defined beside tailnet.py so the hub and the sync share one schema. */
export function schemaText(): string {
  return readFileSync(join(dirname(scriptPath()), "access.sql"), "utf8");
}

export interface ProviderUser {
  id: string;
  loginName: string;
  displayName: string;
  /** "member" for this tailnet's users; "shared" for users from other tailnets. */
  type: string;
  role: string;
  status: string;
  lastSeen: string | null;
}

/** A provider device. Fields the provider did not report are null. */
export interface ProviderDevice {
  id: string;
  name: string;
  hostname: string | null;
  /** The owner's login name. */
  user: string;
  os: string | null;
  tags: string[];
  lastSeen: string | null;
  expires: string | null;
  keyExpiryDisabled: boolean | null;
  authorized: boolean | null;
  connectedToControl: boolean | null;
  advertisedRoutes: string[] | null;
  enabledRoutes: string[] | null;
}

export interface ServerStatus {
  hostname: string;
  tag: string;
  tailnet: string | null;
  backendState: string | null;
  online: boolean | null;
  tagged: boolean;
  advertisedRoutes: string[];
  approvedRoutes: string[] | null;
  problems: string[];
}

export interface PolicyObservation {
  family: string[];
}

export type Section<T> = { ok: true; value: T } | { ok: false; error: string };

export interface Observation {
  observedAt: number;
  users: Section<ProviderUser[]>;
  devices: Section<ProviderDevice[]>;
  policy: Section<PolicyObservation>;
  server: Section<ServerStatus>;
}

export const syncStatuses = ["applied", "current", "off", "failed"] as const;
export type SyncStatus = (typeof syncStatuses)[number];

export interface SyncOutcome {
  status: SyncStatus;
  message: string;
}

export interface TailscaleGateway {
  observe(signal: AbortSignal): Promise<Observation>;
  sync(signal: AbortSignal): Promise<SyncOutcome>;
}

function str(fields: Fields, key: string): string {
  const value = fields.string(key);
  if (value === null) throw new JsonShapeError(`missing ${key}`);
  return value;
}

function strings(fields: Fields, key: string): string[] {
  return fields.list(key).map((item) => {
    if (typeof item !== "string") throw new JsonShapeError(`${key} must list strings`);
    return item;
  });
}

function optionalStrings(fields: Fields, key: string): string[] | null {
  return fields.value(key) === null ? null : strings(fields, key);
}

function section<T>(value: unknown, where: string, parse: (value: unknown) => T): Section<T> {
  const fields = new Fields(value, where);
  if (fields.bool("ok") === true) return { ok: true, value: parse(fields.value("value")) };
  return { ok: false, error: str(fields, "error") };
}

function list<T>(value: unknown, where: string, parse: (fields: Fields) => T): T[] {
  if (!Array.isArray(value)) throw new JsonShapeError(`${where} must be a list`);
  return value.map((item, i) => parse(new Fields(item, `${where} ${i + 1}`)));
}

function user(f: Fields): ProviderUser {
  return {
    id: str(f, "id"),
    loginName: str(f, "loginName"),
    displayName: str(f, "displayName"),
    type: str(f, "type"),
    role: str(f, "role"),
    status: str(f, "status"),
    lastSeen: f.string("lastSeen"),
  };
}

function device(f: Fields): ProviderDevice {
  return {
    id: str(f, "id"),
    name: str(f, "name"),
    hostname: f.string("hostname"),
    user: str(f, "user"),
    os: f.string("os"),
    tags: strings(f, "tags"),
    lastSeen: f.string("lastSeen"),
    expires: f.string("expires"),
    keyExpiryDisabled: f.bool("keyExpiryDisabled"),
    authorized: f.bool("authorized"),
    connectedToControl: f.bool("connectedToControl"),
    advertisedRoutes: optionalStrings(f, "advertisedRoutes"),
    enabledRoutes: optionalStrings(f, "enabledRoutes"),
  };
}

function server(value: unknown): ServerStatus {
  const f = new Fields(value, "server");
  return {
    hostname: str(f, "hostname"),
    tag: str(f, "tag"),
    tailnet: f.string("tailnet"),
    backendState: f.string("backendState"),
    online: f.bool("online"),
    tagged: f.bool("tagged") === true,
    advertisedRoutes: strings(f, "advertisedRoutes"),
    approvedRoutes: optionalStrings(f, "approvedRoutes"),
    problems: strings(f, "problems"),
  };
}

/** Parses `tailnet.py observe` output. */
export function parseObservation(text: string): Observation {
  const f = new Fields(parseJson(text), "observation");
  const observedAt = f.int("observedAt");
  if (observedAt === null) throw new JsonShapeError("missing observedAt");
  return {
    observedAt,
    users: section(f.value("users"), "users", (v) => list(v, "users", user)),
    devices: section(f.value("devices"), "devices", (v) => list(v, "devices", device)),
    policy: section(f.value("policy"), "policy", (v) => {
      const p = new Fields(v, "policy");
      return { family: strings(p, "family") };
    }),
    server: section(f.value("server"), "server", server),
  };
}

/** Parses `tailnet.py sync` output. */
export function parseOutcome(text: string): SyncOutcome {
  const f = new Fields(parseJson(text), "outcome");
  const status = syncStatuses.find((candidate) => candidate === f.string("status"));
  if (status === undefined) throw new JsonShapeError("unknown status");
  return { status, message: str(f, "message") };
}

/** Runs tailnet.py with the hub's account database and a minimal environment. */
export class CommandGateway implements TailscaleGateway {
  constructor(
    private readonly command: string[],
    private readonly database: string,
    private readonly timeoutMs: number,
    private readonly env: Record<string, string>,
  ) {}

  async observe(signal: AbortSignal): Promise<Observation> {
    const text = await this.#run(["observe"], signal);
    if (new Fields(parseJson(text), "observation").has("status")) throw new Error(parseOutcome(text).message);
    return parseObservation(text);
  }

  async sync(signal: AbortSignal): Promise<SyncOutcome> {
    try {
      return parseOutcome(await this.#run(["sync", "--database", this.database], signal));
    } catch (error) {
      if (signal.aborted) throw error;
      return { status: "failed", message: error instanceof Error ? error.message : String(error) };
    }
  }

  #run(args: string[], signal: AbortSignal): Promise<string> {
    const [file = "", ...prefix] = this.command;
    return new Promise((resolve, reject) => {
      execFile(
        file,
        [...prefix, ...args],
        { timeout: this.timeoutMs, maxBuffer: 4 << 20, env: this.env, signal },
        (error, stdout) => {
          // The script prints JSON describing its own failures and exits non-zero.
          if (stdout.trim().startsWith("{")) {
            resolve(stdout);
            return;
          }
          reject(
            new Error(
              error?.killed || error?.signal
                ? "The Tailscale command did not finish in time."
                : `The Tailscale command could not run${error?.code ? ` (${String(error.code)})` : ""}.`,
            ),
          );
        },
      );
    });
  }
}

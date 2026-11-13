import { readFileSync } from "node:fs";
import { Fields, parseJson } from "./json.js";

export interface AccountSettings {
  databaseFile: string;
  sessionLifetimeDays: number;
  sessionsPerAccount: number;
  inviteLifetimeDays: number;
  passwordLength: { min: number; max: number };
  busyTimeoutMs: number;
}

export interface TailscaleSettings {
  /** Python interpreter that runs tailnet.py. */
  python: string;
  /** tailnet.py, resolved against the hub directory. */
  script: string;
  commandTimeoutSeconds: number;
  syncIntervalSeconds: number;
  observationMaxAgeSeconds: number;
  downloadUrl: string;
  adminUsersUrl: string;
}

export interface Settings {
  accounts: AccountSettings;
  tailscale: TailscaleSettings;
}

/** The hub's settings file, next to package.json. */
export const settingsFile = new URL("../settings.json", import.meta.url);

function positive(fields: Fields, key: string, where: string): number {
  const value = fields.required(key).int(key);
  if (value === null || value < 1) throw new Error(`${where}.${key} must be a whole number of at least 1`);
  return value;
}

function text(fields: Fields, key: string, where: string): string {
  const value = fields.required(key).string(key) ?? "";
  if (value.trim() === "") throw new Error(`${where}.${key} must be a non-empty string`);
  return value;
}

function httpsUrl(fields: Fields, key: string, where: string): string {
  const value = text(fields, key, where);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${where}.${key} must be an https URL`);
  }
  if (url.protocol !== "https:") throw new Error(`${where}.${key} must be an https URL`);
  return value;
}

function parseTailscale(value: unknown): TailscaleSettings {
  const where = "tailscale";
  const fields = new Fields(value, "settings.json tailscale").only(
    "python",
    "script",
    "commandTimeoutSeconds",
    "syncIntervalSeconds",
    "observationMaxAgeSeconds",
    "downloadUrl",
    "adminUsersUrl",
  );
  const result: TailscaleSettings = {
    python: text(fields, "python", where),
    script: text(fields, "script", where),
    commandTimeoutSeconds: positive(fields, "commandTimeoutSeconds", where),
    syncIntervalSeconds: positive(fields, "syncIntervalSeconds", where),
    observationMaxAgeSeconds: positive(fields, "observationMaxAgeSeconds", where),
    downloadUrl: httpsUrl(fields, "downloadUrl", where),
    adminUsersUrl: httpsUrl(fields, "adminUsersUrl", where),
  };
  return result;
}

/** Parses settings.json; throws naming the first missing or invalid setting. */
export function parseSettings(text: string): Settings {
  const root = new Fields(parseJson(text), "settings.json")
    .only("accounts", "tailscale")
    .required("accounts", "tailscale");
  const accounts = new Fields(root.value("accounts"), "settings.json accounts")
    .only(
      "databaseFile",
      "sessionLifetimeDays",
      "sessionsPerAccount",
      "inviteLifetimeDays",
      "passwordLength",
      "busyTimeoutMs",
    )
    .required("databaseFile", "passwordLength");
  const length = new Fields(accounts.value("passwordLength"), "settings.json accounts.passwordLength").only(
    "min",
    "max",
  );
  const databaseFile = accounts.string("databaseFile") ?? "";
  if (databaseFile === "") throw new Error("accounts.databaseFile must be a file name");
  const min = positive(length, "min", "accounts.passwordLength");
  const max = positive(length, "max", "accounts.passwordLength");
  if (max < min) throw new Error("accounts.passwordLength.max must be at least accounts.passwordLength.min");
  return {
    accounts: {
      databaseFile,
      sessionLifetimeDays: positive(accounts, "sessionLifetimeDays", "accounts"),
      sessionsPerAccount: positive(accounts, "sessionsPerAccount", "accounts"),
      inviteLifetimeDays: positive(accounts, "inviteLifetimeDays", "accounts"),
      passwordLength: { min, max },
      busyTimeoutMs: positive(accounts, "busyTimeoutMs", "accounts"),
    },
    tailscale: parseTailscale(root.value("tailscale")),
  };
}

export const settings: Settings = parseSettings(readFileSync(settingsFile, "utf8"));

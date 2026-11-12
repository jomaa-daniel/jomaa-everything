import { readFileSync } from "node:fs";
import { Fields, parseJson } from "./json.js";

export interface AccountSettings {
  databaseFile: string;
  sessionLifetimeDays: number;
  sessionsPerAccount: number;
  inviteLifetimeDays: number;
  passwordLength: { min: number; max: number };
}

export interface Settings {
  accounts: AccountSettings;
}

/** The hub's settings file, next to package.json. */
export const settingsFile = new URL("../settings.json", import.meta.url);

function positive(fields: Fields, key: string, where: string): number {
  const value = fields.required(key).int(key);
  if (value === null || value < 1) throw new Error(`${where}.${key} must be a whole number of at least 1`);
  return value;
}

/** Parses settings.json; throws naming the first missing or invalid setting. */
export function parseSettings(text: string): Settings {
  const root = new Fields(parseJson(text), "settings.json").only("accounts").required("accounts");
  const accounts = new Fields(root.value("accounts"), "settings.json accounts")
    .only("databaseFile", "sessionLifetimeDays", "sessionsPerAccount", "inviteLifetimeDays", "passwordLength")
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
    },
  };
}

export const settings: Settings = parseSettings(readFileSync(settingsFile, "utf8"));

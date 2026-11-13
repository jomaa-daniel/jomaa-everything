import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
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

export interface SecretSettings {
  /** Editable environment files, relative to the release root. */
  envFiles: string[];
  /** Absolute path of the GitHub CLI whose login's token reruns the deploy workflow. */
  ghCommand: string;
  /** The deployment settings file, relative to the release root. */
  deployConfig: string;
  redeployPollSeconds: number;
}

export interface Settings {
  accounts: AccountSettings;
  tailscale: TailscaleSettings;
  secrets: SecretSettings;
}

/** The deployment settings the hub reads from the deployment's config.json. */
export interface DeploySettings {
  repo: string;
  workflow: string;
  githubApi: string;
  githubTimeoutSeconds: number;
  hubPasswordMinLength: number;
}

/** The hub's settings file, next to package.json. */
export const settingsFile = new URL("../settings.json", import.meta.url);

/** The repository release the hub runs from: the folder above the hub's folder. */
export const releaseRoot = new URL("../../", import.meta.url);

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

/** A path relative to the release root that stays inside it. */
function releasePath(value: string | null, where: string): string {
  if (
    value === null ||
    value === "" ||
    value.startsWith("/") ||
    value.split("/").some((part) => part === ".." || part === "")
  )
    throw new Error(`${where} must be a path inside the repository`);
  return value;
}

function parseSecrets(value: unknown): SecretSettings {
  const secrets = new Fields(value, "settings.json secrets")
    .only("envFiles", "ghCommand", "deployConfig", "redeployPollSeconds")
    .required("envFiles", "ghCommand", "deployConfig");
  if (!Array.isArray(secrets.value("envFiles"))) throw new Error("secrets.envFiles must be a list");
  const envFiles = secrets
    .list("envFiles")
    .map((file) => releasePath(typeof file === "string" ? file : null, "each of secrets.envFiles"));
  if (envFiles.length === 0) throw new Error("secrets.envFiles must list at least one file");
  if (new Set(envFiles).size !== envFiles.length) throw new Error("secrets.envFiles must not repeat a file");
  const ghCommand = secrets.string("ghCommand") ?? "";
  if (!isAbsolute(ghCommand)) throw new Error("secrets.ghCommand must be an absolute path");
  return {
    envFiles,
    ghCommand,
    deployConfig: releasePath(secrets.string("deployConfig"), "secrets.deployConfig"),
    redeployPollSeconds: positive(secrets, "redeployPollSeconds", "secrets"),
  };
}

/** Reads the hub's deployment settings from the deployment's config.json. */
export function parseDeploySettings(text: string): DeploySettings {
  const config = new Fields(parseJson(text), "deployment config.json").required(
    "repo",
    "github",
    "hubPasswordMinLength",
  );
  const github = new Fields(config.value("github"), "deployment config.json github").required(
    "api",
    "workflow",
    "timeoutSeconds",
  );
  const nonEmpty = (fields: Fields, key: string, where: string) => {
    const value = fields.string(key) ?? "";
    if (value === "") throw new Error(`deployment config.json ${where} must be a non-empty string`);
    return value;
  };
  const repo = nonEmpty(config, "repo", "repo");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("deployment config.json repo must be OWNER/REPOSITORY");
  return {
    repo,
    workflow: nonEmpty(github, "workflow", "github.workflow"),
    githubApi: nonEmpty(github, "api", "github.api"),
    githubTimeoutSeconds: positive(github, "timeoutSeconds", "github"),
    hubPasswordMinLength: positive(config, "hubPasswordMinLength", "deployment config.json"),
  };
}

/** Parses settings.json; throws naming the first missing or invalid setting. */
export function parseSettings(text: string): Settings {
  const root = new Fields(parseJson(text), "settings.json")
    .only("accounts", "tailscale", "secrets")
    .required("accounts", "tailscale", "secrets");
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
    secrets: parseSecrets(root.value("secrets")),
  };
}

export const settings: Settings = parseSettings(readFileSync(settingsFile, "utf8"));

export const deploySettings: DeploySettings = parseDeploySettings(
  readFileSync(new URL(settings.secrets.deployConfig, releaseRoot), "utf8"),
);

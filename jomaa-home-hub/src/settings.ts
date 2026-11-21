import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { Fields, parseJson } from "./json.js";

export interface AccountSettings {
  databaseFile: string;
  sessionLifetimeDays: number;
  sessionsPerAccount: number;
  inviteLifetimeDays: number;
  passwordLength: { min: number; max: number };
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

/** Link prefetching on the hub's pages. */
export interface PrefetchSettings {
  /** SQLite file for page click counts, beside the health database. */
  databaseFile: string;
  /** Prefetch requests a page keeps in flight at once. */
  concurrency: number;
}

export interface Settings {
  accounts: AccountSettings;
  prefetch: PrefetchSettings;
  secrets: SecretSettings;
  i2c: I2CSettings;
  health: {
    refreshSeconds: number;
    historyLimit: number;
    discoveryRefreshSeconds: number;
    goveeStatusCacheSeconds: number;
    goveeStatusConcurrency: number;
    goveeStatusTimeoutSeconds: number;
  };
}

export interface I2CSettings {
  maxDataBytes: number;
  maxRequestBytes: number;
  historyLimit: number;
  liveRows: number;
  keepaliveSeconds: number;
  reconnectMilliseconds: number;
  maxLiveClients: number;
}

function parseI2C(value: unknown): I2CSettings {
  const fields = new Fields(value, "settings.json i2c").only(
    "maxDataBytes",
    "maxRequestBytes",
    "historyLimit",
    "liveRows",
    "keepaliveSeconds",
    "reconnectMilliseconds",
    "maxLiveClients",
  );
  const result: I2CSettings = {
    maxDataBytes: positive(fields, "maxDataBytes", "i2c"),
    maxRequestBytes: positive(fields, "maxRequestBytes", "i2c"),
    historyLimit: positive(fields, "historyLimit", "i2c"),
    liveRows: positive(fields, "liveRows", "i2c"),
    keepaliveSeconds: positive(fields, "keepaliveSeconds", "i2c"),
    reconnectMilliseconds: positive(fields, "reconnectMilliseconds", "i2c"),
    maxLiveClients: positive(fields, "maxLiveClients", "i2c"),
  };
  if (result.maxRequestBytes <= result.maxDataBytes * 2)
    throw new Error("i2c.maxRequestBytes must exceed twice i2c.maxDataBytes");
  return result;
}

/** The deployment settings the hub reads from the deployment's config.json. */
export interface DeploySettings {
  nodesFile: string;
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

function parsePrefetch(value: unknown): PrefetchSettings {
  const fields = new Fields(value, "settings.json prefetch")
    .only("databaseFile", "concurrency")
    .required("databaseFile");
  const databaseFile = fields.string("databaseFile") ?? "";
  if (databaseFile === "") throw new Error("prefetch.databaseFile must be a file name");
  return { databaseFile, concurrency: positive(fields, "concurrency", "prefetch") };
}

/** Reads the hub's deployment settings from the deployment's config.json. */
export function parseDeploySettings(text: string): DeploySettings {
  const config = new Fields(parseJson(text), "deployment config.json").required(
    "repo",
    "github",
    "hubPasswordMinLength",
    "nodesFile",
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
    nodesFile: releasePath(config.string("nodesFile"), "nodesFile"),
    workflow: nonEmpty(github, "workflow", "github.workflow"),
    githubApi: nonEmpty(github, "api", "github.api"),
    githubTimeoutSeconds: positive(github, "timeoutSeconds", "github"),
    hubPasswordMinLength: positive(config, "hubPasswordMinLength", "deployment config.json"),
  };
}

/** Parses settings.json; throws naming the first missing or invalid setting. */
export function parseSettings(text: string): Settings {
  const root = new Fields(parseJson(text), "settings.json")
    .only("accounts", "prefetch", "secrets", "i2c", "health")
    .required("accounts", "prefetch", "secrets", "i2c", "health");
  const health = new Fields(root.value("health"), "settings.json health").only(
    "refreshSeconds",
    "historyLimit",
    "discoveryRefreshSeconds",
    "goveeStatusCacheSeconds",
    "goveeStatusConcurrency",
    "goveeStatusTimeoutSeconds",
  );
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
    prefetch: parsePrefetch(root.value("prefetch")),
    secrets: parseSecrets(root.value("secrets")),
    i2c: parseI2C(root.value("i2c")),
    health: {
      refreshSeconds: positive(health, "refreshSeconds", "health"),
      historyLimit: positive(health, "historyLimit", "health"),
      discoveryRefreshSeconds: positive(health, "discoveryRefreshSeconds", "health"),
      goveeStatusCacheSeconds: positive(health, "goveeStatusCacheSeconds", "health"),
      goveeStatusConcurrency: positive(health, "goveeStatusConcurrency", "health"),
      goveeStatusTimeoutSeconds: positive(health, "goveeStatusTimeoutSeconds", "health"),
    },
  };
}

export const settings: Settings = parseSettings(readFileSync(settingsFile, "utf8"));

export const deploySettings: DeploySettings = parseDeploySettings(
  readFileSync(new URL(settings.secrets.deployConfig, releaseRoot), "utf8"),
);

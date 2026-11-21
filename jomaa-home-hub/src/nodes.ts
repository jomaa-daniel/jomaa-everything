import { readFileSync } from "node:fs";
import { isScope, type Scope } from "./accounts.js";
import { Fields, parseJson } from "./json.js";
import { deploySettings, releaseRoot } from "./settings.js";

export interface NodeConfig {
  id: string;
  name: string;
  enabled: boolean;
  mode: "gateway" | "node";
  hostname: string | null;
  tunnelName: string | null;
  secretEnv: string | null;
  deploySecret: string;
  scopes: Scope[];
  publicRoutes: [string, string][];
  modules: string[] | null;
  moduleOverrides: Record<string, unknown>;
}

export interface NodeCatalog {
  defaultNode: string;
  identityFile: string;
  transport: {
    requestTimeoutSeconds: number;
    maxRequestBytes: number;
    maxResponseBytes: number;
    delegationLifetimeSeconds: number;
    secretMinLength: number;
    replayLimit: number;
  };
  nodes: NodeConfig[];
}

const nodeKeys = [
  "id",
  "name",
  "enabled",
  "mode",
  "hostname",
  "tunnelName",
  "secretEnv",
  "deploySecret",
  "scopes",
  "publicRoutes",
  "modules",
  "moduleOverrides",
];
const transportKeys = [
  "requestTimeoutSeconds",
  "maxRequestBytes",
  "maxResponseBytes",
  "delegationLifetimeSeconds",
  "secretMinLength",
  "replayLimit",
] as const;
const nodeID = /^[a-z0-9][a-z0-9-]*$/;
const envName = /^[A-Z][A-Z0-9_]*$/;
const hostname = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;

function names(value: unknown, where: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item === "") ||
    new Set(value).size !== value.length
  )
    throw new Error(`${where} must be unique nonempty strings`);
  return value as string[];
}

/** Validates the shared catalog before a listener starts. */
export function parseCatalog(text: string): NodeCatalog {
  const root = new Fields(parseJson(text), "node catalog")
    .only("defaultNode", "identityFile", "transport", "nodes")
    .required("defaultNode", "identityFile", "transport", "nodes");
  const defaultNode = root.string("defaultNode") ?? "";
  const identityFile = root.string("identityFile") ?? "";
  if (!identityFile || identityFile.includes("/") || identityFile === "." || identityFile === "..")
    throw new Error("identityFile must be a file name");
  const fields = new Fields(root.value("transport"), "transport").only(...transportKeys).required(...transportKeys);
  const bounds = transportKeys.map((key) => {
    const value = fields.int(key);
    if (value === null || value < 1) throw new Error(`transport.${key} must be a positive whole number`);
    return [key, value];
  });
  const transport = Object.fromEntries(bounds) as NodeCatalog["transport"];
  if (transport.secretMinLength < 32) throw new Error("transport.secretMinLength must be at least 32");
  if (!Array.isArray(root.value("nodes")) || root.list("nodes").length === 0)
    throw new Error("nodes must be a nonempty list");
  const nodes = root.list("nodes").map((value): NodeConfig => {
    const node = new Fields(value, "node").only(...nodeKeys).required(...nodeKeys);
    const id = node.string("id") ?? "";
    const name = node.string("name") ?? "";
    const enabled = node.bool("enabled");
    const mode = node.string("mode");
    if (!nodeID.test(id) || !name.trim() || enabled === null || (mode !== "gateway" && mode !== "node"))
      throw new Error("invalid node identity, name, enabled or mode");
    const host = node.string("hostname");
    const tunnelName = node.string("tunnelName");
    const secretEnv = node.string("secretEnv");
    const deploySecret = node.string("deploySecret") ?? "";
    if (
      (host === null ? mode !== "gateway" : !hostname.test(host)) ||
      (tunnelName === null ? mode !== "gateway" : !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(tunnelName)) ||
      (secretEnv === null ? mode !== "gateway" : !envName.test(secretEnv)) ||
      !envName.test(deploySecret)
    )
      throw new Error("invalid node hostname, tunnelName, secretEnv or deploySecret");
    const granted = names(node.value("scopes"), "node scopes").map((scope) => {
      if (!isScope(scope)) throw new Error(`unknown node scope ${scope}`);
      return scope;
    });
    if (!Array.isArray(node.value("publicRoutes"))) throw new Error("publicRoutes must be a list");
    const publicRoutes = node.list("publicRoutes").map((route): [string, string] => {
      if (
        !Array.isArray(route) ||
        route.length !== 2 ||
        typeof route[0] !== "string" ||
        !/^[A-Z]+$/.test(route[0]) ||
        typeof route[1] !== "string" ||
        !route[1].startsWith("/") ||
        /[?#]/.test(route[1])
      )
        throw new Error("publicRoutes must be exact method/path pairs");
      return [route[0], route[1]];
    });
    const modules = node.value("modules") === null ? null : names(node.value("modules"), "node modules");
    if (mode === "node" && modules === null) throw new Error("nodes require an explicit module allowlist");
    const overrides = node.value("moduleOverrides");
    if (
      overrides === null ||
      typeof overrides !== "object" ||
      Array.isArray(overrides) ||
      Object.values(overrides).some((entry) => entry === null || typeof entry !== "object" || Array.isArray(entry))
    )
      throw new Error("moduleOverrides must map module names to declaration fields");
    if (modules !== null && Object.keys(overrides).some((key) => !modules.includes(key)))
      throw new Error("moduleOverrides may only name selected modules");
    return {
      id,
      name,
      enabled,
      mode,
      hostname: host,
      tunnelName,
      secretEnv,
      deploySecret,
      scopes: granted,
      publicRoutes,
      modules,
      moduleOverrides: overrides as Record<string, unknown>,
    };
  });
  for (const key of ["id", "hostname", "tunnelName", "secretEnv", "deploySecret"] as const) {
    const values = nodes.map((node) => node[key]).filter((value) => value !== null);
    if (new Set(values).size !== values.length) throw new Error(`node ${key} must be unique`);
  }
  const gateways = nodes.filter((node) => node.mode === "gateway");
  if (gateways.length !== 1 || gateways[0]?.id !== defaultNode || !gateways[0].enabled)
    throw new Error("defaultNode must name the single enabled gateway");
  return { defaultNode, identityFile, transport, nodes };
}

export const catalog = parseCatalog(readFileSync(new URL(deploySettings.nodesFile, releaseRoot), "utf8"));

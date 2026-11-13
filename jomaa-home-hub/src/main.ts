// Runs the home hub: it loads the device layout, starts the Matter controller,
// and serves the HTTP API.
import { cliOptions } from "./cli.js";
import { createServer } from "node:http";
import { createServer as createTLSServer } from "node:https";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Api } from "./api.js";
import { loadConfig, parseListen, usesDriver } from "./config.js";
import { GoveeClient, defaultBaseURL } from "./govee.js";
import { Hub } from "./hub.js";
import { HealthStore } from "./health/store.js";
import { Organization } from "./organization.js";
import { Accounts } from "./accounts.js";
import { TailscaleService } from "./tailscale.js";
import { TailscaleStore } from "./tailscale-store.js";
import { CommandGateway, schemaText, scriptPath } from "./tailscale-gateway.js";
import { deploySettings, releaseRoot, settings } from "./settings.js";
import { EnvFiles } from "./secrets.js";
import { DeployWorkflow, GitHubCli } from "./redeploy.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stderrLog, type Log } from "./log.js";
import { MatterNotReadyError, type MatterAdmin, type MatterNodes } from "./matter/nodes.js";

/** What the hub needs from Matter, including shutting it down. */
type MatterService = MatterNodes & MatterAdmin & { stop(): Promise<void> };

/** Stands in for the controller when the hub runs with --no-matter. */
const noMatter: MatterService = {
  ready: false,
  node: () => null,
  nodes: () => [],
  discover: () => Promise.reject(new MatterNotReadyError()),
  register: () => Promise.reject(new MatterNotReadyError()),
  rename: () => Promise.reject(new MatterNotReadyError()),
  invoke: () => Promise.reject(new MatterNotReadyError()),
  commission: () => Promise.reject(new MatterNotReadyError()),
  setWiFiCredentials: () => Promise.reject(new MatterNotReadyError()),
  setThreadDataset: () => Promise.reject(new MatterNotReadyError()),
  removeNode: () => Promise.reject(new MatterNotReadyError()),
  stop: () => Promise.resolve(),
};

async function startMatter(log: Log): Promise<MatterService> {
  if (!cliOptions.matter) {
    log.info("running without Matter (--no-matter)", {});
    return noMatter;
  }
  // Loaded only when wanted: matter.js sets up its runtime as soon as it loads.
  const { Matter } = await import("./matter/controller.js");
  const controller = new Matter({
    storagePath: cliOptions.matterStorage,
    bluetoothAdapter: cliOptions.bluetoothAdapter,
    log: log.with({ component: "matter" }),
  });
  // The API answers while the controller starts; Matter calls get a 503 until it's ready.
  void controller.run();
  return controller;
}

async function run(log: Log): Promise<void> {
  const cfg = loadConfig(cliOptions.config);
  const password = process.env["HUB_PASSWORD"] ?? "";
  if (password === "") throw new Error("HUB_PASSWORD is not set");
  const goveeKey = process.env["GOVEE_API_KEY"] ?? "";
  if (usesDriver(cfg, "govee") && goveeKey === "") {
    throw new Error("config has Govee devices but GOVEE_API_KEY is not set");
  }
  const { host, port } = parseListen(cfg.listen);
  const shutdown = new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  const matter = await startMatter(log);
  let health: HealthStore | undefined;
  let organization: Organization | undefined;
  let accounts: Accounts | undefined;
  let tailscale: TailscaleService | undefined;
  let cleanup: ReturnType<typeof setInterval> | undefined;
  try {
    const govee = new GoveeClient(goveeKey, process.env["GOVEE_BASE_URL"] || defaultBaseURL);
    const store = new HealthStore(
      process.env["HEALTH_DB_PATH"] ?? "data/health.sqlite",
      Number(process.env["HEALTH_RETENTION_DAYS"] ?? 30),
    );
    health = store;
    const besideHealth = (name: string) =>
      process.env["HEALTH_DB_PATH"] === ":memory:"
        ? ":memory:"
        : join(dirname(process.env["HEALTH_DB_PATH"] ?? "data/health.sqlite"), name);
    organization = new Organization(besideHealth("organization.sqlite"));
    const accountsFile = besideHealth(settings.accounts.databaseFile);
    const people = new Accounts(accountsFile);
    accounts = people;
    if (accountsFile !== ":memory:") {
      const env: Record<string, string> = {};
      for (const key of ["PATH", "HOME", "LANG", "JOMAA_DEPLOY_HOME"]) {
        const value = process.env[key];
        if (value !== undefined) env[key] = value;
      }
      tailscale = new TailscaleService(
        new TailscaleStore(people.database, schemaText(), Date.now),
        new CommandGateway(
          [settings.tailscale.python, scriptPath()],
          resolve(accountsFile),
          settings.tailscale.commandTimeoutSeconds * 1000,
          env,
        ),
        people,
        settings.tailscale,
        log.with({ component: "tailscale" }),
      );
    }
    const api = new Api(
      Hub.build(cfg, govee, matter),
      matter,
      password,
      people,
      log,
      store,
      cliOptions.config,
      organization,
      {
        files: new EnvFiles(fileURLToPath(releaseRoot), settings.secrets.envFiles, deploySettings.hubPasswordMinLength),
        workflow: new DeployWorkflow({
          api: deploySettings.githubApi,
          repo: deploySettings.repo,
          workflow: deploySettings.workflow,
          timeoutMs: deploySettings.githubTimeoutSeconds * 1000,
        }),
        cli: new GitHubCli(settings.secrets.ghCommand, deploySettings.githubTimeoutSeconds * 1000),
      },
      tailscale,
    );
    const cert = process.env["HUB_TLS_CERT"];
    const key = process.env["HUB_TLS_KEY"];
    if (Boolean(cert) !== Boolean(key)) throw new Error("set both HUB_TLS_CERT and HUB_TLS_KEY");
    const options = { requestTimeout: 6 * 60_000, headersTimeout: 10_000 };
    const server =
      cert && key
        ? createTLSServer(
            { ...options, cert: readFileSync(cert), key: readFileSync(key), minVersion: "TLSv1.2" },
            api.handle,
          )
        : createServer(options, api.handle);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(host === null ? { port } : { host, port }, resolve);
    });
    log.info("hub listening", { addr: cfg.listen, devices: cfg.devices.length, rooms: cfg.rooms.length });
    tailscale?.start();
    cleanup = setInterval(() => {
      try {
        store.prune();
      } catch (err) {
        log.error("health log retention failed", { err });
      }
      try {
        people.prune();
      } catch (err) {
        log.error("expired session and invite cleanup failed", { err });
      }
    }, 60 * 60_000);
    cleanup.unref();
    await shutdown;
    log.info("shutting down", {});
    const closed = new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    server.closeIdleConnections();
    setTimeout(() => {
      server.closeAllConnections();
    }, 10_000).unref();
    await closed;
  } finally {
    if (cleanup) clearInterval(cleanup);
    try {
      await tailscale?.close();
      health?.close();
      organization?.close();
      accounts?.close();
    } finally {
      await matter.stop();
    }
  }
}

run(stderrLog).then(
  () => process.exit(0),
  (err: unknown) => {
    stderrLog.error("hub stopped", { err });
    process.exit(1);
  },
);

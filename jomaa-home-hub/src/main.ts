// Runs the home hub: it loads the device layout, starts the Matter controller,
// and serves the HTTP API.
import { cliOptions } from "./cli.js";
import { createServer } from "node:http";
import { Api } from "./api.js";
import { loadConfig, parseListen, usesDriver } from "./config.js";
import { GoveeClient, defaultBaseURL } from "./govee.js";
import { Hub } from "./hub.js";
import { stderrLog, type Log } from "./log.js";
import { MatterNotReadyError, type MatterAdmin, type MatterNodes } from "./matter/nodes.js";

/** What the hub needs from Matter, including shutting it down. */
type MatterService = MatterNodes & MatterAdmin & { stop(): Promise<void> };

/** Stands in for the controller when the hub runs with --no-matter. */
const noMatter: MatterService = {
  ready: false,
  node: () => null,
  nodes: () => [],
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
  if (password === "") {
    throw new Error("HUB_PASSWORD is not set");
  }
  const goveeKey = process.env["GOVEE_API_KEY"] ?? "";
  if (usesDriver(cfg, "govee") && goveeKey === "") {
    throw new Error("config has Govee devices but GOVEE_API_KEY is not set");
  }
  const { host, port } = parseListen(cfg.listen);
  // Handled from the start, so a signal while starting still stops the controller cleanly.
  const shutdown = new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  const matter = await startMatter(log);
  try {
    // GOVEE_BASE_URL points the hub at a fake Govee API in tests.
    const govee = new GoveeClient(goveeKey, process.env["GOVEE_BASE_URL"] || defaultBaseURL);
    const api = new Api(Hub.build(cfg, govee, matter), matter, password, log);
    // Pairing can take five minutes.
    const server = createServer({ requestTimeout: 6 * 60_000, headersTimeout: 10_000 }, api.handle);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(host === null ? { port } : { host, port }, resolve);
    });
    log.info("hub listening", { addr: cfg.listen, devices: cfg.devices.length, rooms: cfg.rooms.length });

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
    // On every exit, including a failed listen, so the Matter storage is flushed.
    await matter.stop();
  }
}

run(stderrLog).then(
  () => process.exit(0),
  (err: unknown) => {
    stderrLog.error("hub stopped", { err });
    process.exit(1);
  },
);

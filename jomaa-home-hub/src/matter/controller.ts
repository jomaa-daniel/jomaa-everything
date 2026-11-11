// The hub's Matter controller. It runs the Open Home Foundation Matter server's
// controller library (https://github.com/matter-js/matterjs-server) inside the
// hub process, and the hub calls it directly. The
// controller owns the Matter fabric: pairing, Thread and Wi-Fi credentials,
// and device sessions, and keeps a live copy of every node's attributes.
import "./preinit.js";
// Registers vendor clusters; must load before the controller finalizes the cluster model.
import "@matter-server/custom-clusters";
import {
  ConfigStorage,
  Environment,
  Logger,
  LogLevel,
  MatterController,
  ServerError,
} from "@matter-server/ws-controller";
import { MatterError as MatterJsError, NodeConnectionState, NodeId, ObserverGroup } from "@matter/main";
import { DeviceClassification, Matter as MatterModel } from "@matter/main/model";
import { ClusterId, EndpointNumber, ManualPairingCodeCodec, QrPairingCodeCodec } from "@matter/main/types";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Log } from "../log.js";
import { MatterInventory, MatterMonitor, uptimeAttribute, uptimeSeconds } from "./inventory.js";
import {
  abortable,
  MatterError,
  MatterNotReadyError,
  summarize,
  type CommissionableDevice,
  type CommissionedNode,
  type MatterAdmin,
  type MatterNode,
  type MatterNodes,
  type NodeSummary,
} from "./nodes.js";

// The hub's vendor and fabric. Changing them means a new fabric (storage
// "server-1-fff1" holds the current one), so every device must be re-paired.
const vendorId = 0xfff1;
const fabricId = 1;
const maxNodeIdAttempts = 5;
const credentialId = ConfigStorage.DEFAULT_CREDENTIAL_ID;

function deviceTypeName(id: number): string | null {
  const type = MatterModel.deviceTypes.find((candidate) => candidate.id === id);
  if (type && DeviceClassification.isUtility(type.classification)) return null;
  return type?.name.replace(/([a-z0-9])([A-Z])/g, "$1 $2") ?? `Device type 0x${id.toString(16)}`;
}

export interface MatterOptions {
  storagePath: string;
  /** HCI id of the Bluetooth adapter for pairing new devices; null leaves Bluetooth off. */
  bluetoothAdapter: number | null;
  log: Log;
}

/** The library version, which the controller reports as its software version. */
function controllerVersion(): string {
  const entry = fileURLToPath(import.meta.resolve("@matter-server/ws-controller"));
  const pkg = JSON.parse(readFileSync(join(dirname(entry), "../../package.json"), "utf8")) as { version: string };
  return pkg.version;
}

function matterLogLevel(name: string): LogLevel {
  switch (name.toLowerCase()) {
    case "debug":
      return LogLevel.DEBUG;
    case "info":
      return LogLevel.INFO;
    case "warn":
      return LogLevel.WARN;
    case "error":
      return LogLevel.ERROR;
    default:
      return LogLevel.NOTICE;
  }
}

/** The parts of a started controller. */
interface Running {
  config: ConfigStorage;
  controller: MatterController;
  handler: MatterController["commandHandler"];
}

type CommissioningRequest = Parameters<MatterController["commandHandler"]["commissionNode"]>[0];
type SelectedCommissioningRequest = Extract<CommissioningRequest, { passcode: number; longDiscriminator: number }>;

/**
 * The embedded controller. Start it with run; until it has loaded the
 * commissioned nodes, calls fail with MatterNotReadyError.
 */
export class Matter implements MatterNodes, MatterAdmin {
  readonly #opts: MatterOptions;
  readonly #env = Environment.default;
  // Set as each part comes up, so a failed start can close what it opened.
  #config: ConfigStorage | null = null;
  #controller: MatterController | null = null;
  #running: Running | null = null;
  #starting: Promise<Running> | null = null;
  readonly #stopping = new AbortController();
  readonly #registering = new Set<string>();
  readonly #inventory: MatterInventory;
  #monitor: MatterMonitor | null = null;
  #observers = new ObserverGroup();

  #recordContact(nodeId: number, uptime?: number | null): void {
    try {
      this.#inventory.seen(nodeId, uptime);
    } catch (err) {
      this.#opts.log.warn("matter contact recording failed", { nodeId, err });
    }
  }

  constructor(opts: MatterOptions) {
    this.#opts = opts;
    this.#inventory = new MatterInventory(join(opts.storagePath, "inventory.sqlite"));
    Logger.level = matterLogLevel(process.env["MATTER_LOG_LEVEL"] ?? "");
    // The hub handles SIGINT and SIGTERM and stops the controller itself.
    this.#env.vars.set("runtime.signals", false);
    this.#env.vars.set("storage.path", opts.storagePath);
    if (opts.bluetoothAdapter !== null) {
      this.#env.vars.set("ble.enable", true);
      this.#env.vars.set("ble.hci.id", opts.bluetoothAdapter);
    }
  }

  get ready(): boolean {
    return this.#running !== null;
  }

  /** Starts the controller, retrying with backoff until it runs or stop is called. */
  async run(): Promise<void> {
    const log = this.#opts.log;
    let backoff = 1000;
    while (!this.#stopped()) {
      try {
        this.#starting = this.#start();
        const running = await this.#starting;
        if (this.#stopped()) {
          // stop() waited for this start and closes what it opened.
          return;
        }
        this.#running = running;
        this.#monitor = new MatterMonitor(
          {
            nodes: () =>
              running.handler.getNodeIds().map((id) => {
                const data = running.handler.getNodeDetails(id);
                const listed = data.attributes["0/51/65531"];
                return {
                  nodeId: Number(id),
                  available: data.available,
                  supportsUptime: uptimeAttribute in data.attributes || (Array.isArray(listed) && listed.includes(2)),
                };
              }),
            hasNode: (nodeId) => running.handler.hasNode(NodeId(BigInt(nodeId))),
            read: (nodeId, paths) => running.handler.handleReadAttributes(NodeId(BigInt(nodeId)), paths, true),
          },
          this.#inventory,
          log,
        );
        this.#monitor.start();
        log.info("matter controller started", {
          storage: this.#opts.storagePath,
          nodes: running.handler.getNodeIds().length,
        });
        return;
      } catch (err) {
        if (this.#stopped()) {
          return;
        }
        log.error("matter controller failed to start", { err, retry_in: `${backoff / 1000}s` });
        await this.#teardown();
        await sleep(backoff, this.#stopping.signal);
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
  }

  /** Whether stop was called; read through a method because it changes while run awaits. */
  #stopped(): boolean {
    return this.#stopping.signal.aborted;
  }

  async #start(): Promise<Running> {
    const config = await ConfigStorage.create(this.#env);
    this.#config = config;
    const controller = await MatterController.create(
      this.#env,
      config,
      {
        serverVersion: controllerVersion(),
        bleProxyEnabled: false,
        // The hub doesn't show Thread network diagnostics; pairing over Thread doesn't need them.
        disableThreadDiagnostics: true,
        otaUpload: { tempDir: join(this.#opts.storagePath, "ota-uploads") },
      },
      { vendorId, fabricId },
    );
    this.#controller = controller;
    const handler = controller.commandHandler;
    this.#observers.on(handler.events.nodeStateChanged, (id, state) => {
      if (state === NodeConnectionState.Connected) {
        this.#recordContact(Number(id));
        this.#monitor?.refreshCapabilities(Number(id));
      }
    });
    this.#observers.on(handler.events.attributeChanged, (id, data) => {
      if (data.value === undefined) return;
      const { endpointId, clusterId, attributeId } = data.path;
      this.#recordContact(
        Number(id),
        `${endpointId}/${clusterId}/${attributeId}` === uptimeAttribute ? uptimeSeconds(data.value) : undefined,
      );
    });
    this.#observers.on(handler.events.eventChanged, (id, data) => {
      if (data.events.length) this.#recordContact(Number(id));
    });
    this.#observers.on(handler.events.nodeAdded, (id) => {
      this.#recordContact(Number(id));
      this.#monitor?.refreshCapabilities(Number(id));
    });
    this.#observers.on(handler.events.nodeStructureChanged, (id) => this.#monitor?.refreshCapabilities(Number(id)));
    this.#observers.on(handler.events.nodeDecommissioned, (id) => {
      try {
        this.#inventory.remove(Number(id));
      } catch (err) {
        this.#opts.log.warn("matter inventory removal failed", { nodeId: Number(id), err });
      }
    });
    await controller.otaUploads.cleanupOrphans();
    // Starts the controller, loads each node's attributes and connects to them.
    await controller.commandHandler.initializeNodes();
    return { config, controller, handler: controller.commandHandler };
  }

  /** Stops the controller and flushes its storage. */
  async stop(): Promise<void> {
    this.#stopping.abort();
    // Let a start in progress finish, so nothing it opens is left running.
    await this.#starting?.catch(() => undefined);
    await this.#teardown();
    this.#inventory.close();
    await this.#env.runtime.close();
  }

  async #teardown(): Promise<void> {
    this.#monitor?.stop();
    this.#monitor = null;
    this.#observers.close();
    this.#observers = new ObserverGroup();
    this.#running = null;
    const log = this.#opts.log;
    try {
      await this.#controller?.stop();
    } catch (err) {
      log.warn("stopping the matter controller failed", { err });
    }
    try {
      await this.#config?.close();
    } catch (err) {
      log.warn("closing matter config storage failed", { err });
    }
    this.#controller = null;
    this.#config = null;
  }

  /** The running controller's parts; throws until it has started. */
  #require(): Running {
    if (this.#running === null) {
      throw new MatterNotReadyError();
    }
    return this.#running;
  }

  node(nodeId: number): MatterNode | null {
    if (this.#running === null) {
      return null;
    }
    const { handler } = this.#running;
    const id = NodeId(BigInt(nodeId));
    if (!handler.hasNode(id)) {
      return null;
    }
    const d = handler.getNodeDetails(id);
    return {
      nodeId,
      available: d.available,
      isBridge: d.is_bridge,
      attributes: d.attributes,
      ...this.#inventory.get(nodeId),
    };
  }

  /** Every commissioned node, sorted by id. */
  nodes(): NodeSummary[] {
    return this.#require()
      .handler.getNodeIds()
      .map((id) => this.node(Number(id)))
      .filter((n) => n !== null)
      .map((node) => summarize(node, deviceTypeName))
      .sort((a, b) => a.nodeId - b.nodeId);
  }

  /** Saves the node's display name in this hub. */
  rename(nodeId: number, name: string): Promise<NodeSummary> {
    return Promise.resolve().then(() => {
      const { handler } = this.#require();
      if (!handler.hasNode(NodeId(BigInt(nodeId)))) throw new MatterError("Matter node is not paired with this hub");
      this.#inventory.rename(nodeId, name);
      const node = this.node(nodeId);
      if (node === null) throw new MatterError("Matter node is not paired with this hub");
      return summarize(node, deviceTypeName);
    });
  }

  /** Discovers commissioning advertisements over mDNS without Bluetooth. */
  async discover(signal: AbortSignal): Promise<CommissionableDevice[]> {
    const { handler } = this.#require();
    const devices = await call(abortable(handler.handleDiscovery({}), signal));
    return devices.map((device) => ({
      instanceName: device.instanceName,
      deviceName: device.deviceName,
      vendorId: device.vendorId,
      productId: device.productId,
      deviceType: device.deviceType,
      longDiscriminator: device.longDiscriminator,
      commissioningMode: device.commissioningMode,
      addresses: device.addresses ?? [],
      port: device.port,
    }));
  }

  /** Invokes a cluster command on one endpoint of a node. */
  async invoke(
    nodeId: number,
    endpoint: number,
    cluster: number,
    command: string,
    payload: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<void> {
    const { handler } = this.#require();
    await call(
      abortable(
        handler.handleInvoke({
          nodeId: NodeId(BigInt(nodeId)),
          endpointId: EndpointNumber(endpoint),
          clusterId: ClusterId(cluster),
          commandName: command,
          data: payload,
        }),
        signal,
      ),
    );
    this.#recordContact(nodeId);
  }

  /**
   * Pairs a new device using its QR code ("MT:...") or manual pairing code.
   * Set networkOnly for devices already on the network, so the controller
   * doesn't try Bluetooth. Wi-Fi and Thread devices need credentials set first.
   */
  async commission(code: string, networkOnly: boolean, signal: AbortSignal): Promise<CommissionedNode> {
    return this.#commission(code.startsWith("MT:") ? { qrCode: code } : { manualCode: code }, networkOnly, signal);
  }

  /** Pairs the selected network advertisement with the supplied setup code. */
  async register(code: string, instanceName: string, signal: AbortSignal): Promise<CommissionedNode> {
    if (this.#registering.has(instanceName)) throw new MatterError("This device is already being paired.");
    this.#registering.add(instanceName);
    try {
      const devices = await this.discover(signal);
      const device = devices.find((candidate) => candidate.instanceName === instanceName);
      if (device === undefined || device.commissioningMode === 0) {
        throw new MatterError("This device is no longer accepting pairing. Enable pairing and scan again.");
      }
      const request = selectedCommissioningRequest(code, device);
      return await this.#commission(request, true, signal);
    } finally {
      this.#registering.delete(instanceName);
    }
  }

  async #commission(
    request: CommissioningRequest,
    networkOnly: boolean,
    signal: AbortSignal,
  ): Promise<CommissionedNode> {
    const { controller, config, handler } = this.#require();

    // Only hand over stored credentials whose values are actually present.
    const wifi = config.getWifiCredentials(credentialId);
    const thread = config.getThreadCredentials(credentialId);
    const useRadio = !networkOnly && handler.bleEnabled;
    const credentials = {
      ...(useRadio && wifi?.ssid && wifi.credentials
        ? { wifiCredentials: { wifiSsid: wifi.ssid, wifiCredentials: wifi.credentials } }
        : {}),
      ...(useRadio && thread?.dataset
        ? { threadCredentials: { networkName: "", operationalDataset: thread.dataset } }
        : {}),
    };

    const pair = async (): Promise<NodeId> => {
      // Attestation certificates must be loaded before pairing.
      await controller.certificateService();
      // The stored node id counter can drift from the fabric; on a conflict,
      // take the next id.
      for (let attempt = 1; ; attempt++) {
        const nodeId = NodeId(await config.allocateNodeId((id) => handler.isNodeIdInUse(NodeId(id))));
        try {
          const { nodeId: paired } = await handler.commissionNode({
            nodeId,
            onNetworkOnly: networkOnly,
            ...request,
            ...credentials,
          });
          return paired;
        } catch (err) {
          if (attempt >= maxNodeIdAttempts || !isIdentityConflict(err)) {
            throw err;
          }
          this.#opts.log.warn("matter node id already in use, retrying with the next", { nodeId: String(nodeId) });
        }
      }
    };

    const nodeId = await call(abortable(pair(), signal));
    const d = handler.getNodeDetails(nodeId);
    return { node_id: Number(nodeId), available: d.available, is_bridge: d.is_bridge };
  }

  /** Sets the Wi-Fi network handed to devices during pairing. */
  async setWiFiCredentials(ssid: string, password: string): Promise<void> {
    const { config } = this.#require();
    await call(config.setWifiCredentials(credentialId, ssid, password));
  }

  /** Sets the Thread network handed to devices during pairing. */
  async setThreadDataset(dataset: string): Promise<void> {
    const { config } = this.#require();
    if (!/^[0-9a-fA-F]+$/.test(dataset) || dataset.length % 2 !== 0) {
      throw new MatterError(
        "Invalid Thread operational dataset: must be a non-empty hex string with even length (each byte is two hex characters)",
      );
    }
    await call(config.setThreadCredentials(credentialId, dataset));
  }

  /** Unpairs a node from the hub's Matter fabric. */
  async removeNode(nodeId: number, signal: AbortSignal): Promise<void> {
    const { handler } = this.#require();
    await call(abortable(handler.removeNode(NodeId(BigInt(nodeId))), signal));
  }
}

/** Decodes a setup code and restricts commissioning to the selected advertisement. */
export function selectedCommissioningRequest(code: string, device: CommissionableDevice): SelectedCommissioningRequest {
  let passcode: number;
  let matches: boolean;
  try {
    if (code.startsWith("MT:")) {
      const payloads = QrPairingCodeCodec.decode(code);
      const payload = payloads[0];
      if (payloads.length !== 1 || payload === undefined) {
        throw new MatterError("Use the setup code for one device.");
      }
      passcode = payload.passcode;
      matches =
        payload.discriminator === device.longDiscriminator &&
        (payload.vendorId === undefined || device.vendorId < 0 || payload.vendorId === device.vendorId) &&
        (payload.productId === undefined || device.productId < 0 || payload.productId === device.productId);
    } else {
      const payload = ManualPairingCodeCodec.decode(code);
      passcode = payload.passcode;
      matches =
        payload.shortDiscriminator === device.longDiscriminator >> 8 &&
        (payload.vendorId === undefined || device.vendorId < 0 || payload.vendorId === device.vendorId) &&
        (payload.productId === undefined || device.productId < 0 || payload.productId === device.productId);
    }
  } catch {
    throw new MatterError("Invalid Matter setup code. Check the digits or paste the complete MT: QR payload.");
  }
  if (!matches) throw new MatterError("This setup code does not match the selected device.");
  const ip = device.addresses[0];
  return {
    passcode,
    longDiscriminator: device.longDiscriminator,
    ...(ip === undefined ? {} : { knownAddress: { ip, port: device.port } }),
  };
}

/**
 * Waits for a controller call, reporting what the controller rejected as a
 * MatterError. Aborts (the request ran out of time) pass through unchanged.
 */
async function call<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (err) {
    if (err instanceof DOMException || err instanceof MatterError) {
      throw err;
    }
    const message = err instanceof ServerError || err instanceof Error ? err.message : String(err);
    throw new MatterError(message, err);
  }
}

/** Whether an error (or any error in its cause chain) is a matter.js node id collision. */
function isIdentityConflict(error: unknown): boolean {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if (current instanceof MatterJsError && current.id === "identity-conflict") {
      return true;
    }
  }
  return false;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

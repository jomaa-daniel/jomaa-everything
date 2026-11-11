// What the rest of the hub needs from Matter. The controller in controller.ts
// implements these against matter.js; tests use fakes. Nothing here imports
// matter.js, so the hub's other modules load without it.

/**
 * One commissioned Matter device. Attributes are keyed by
 * "endpoint/cluster/attribute", e.g. "1/6/0" is OnOff on endpoint 1.
 */
export interface MatterNode {
  nodeId: number;
  available: boolean;
  isBridge: boolean;
  attributes: Readonly<Record<string, unknown>>;
}

/** The short form of a node, for listing. */
export interface NodeSummary {
  nodeId: number;
  available: boolean;
  isBridge: boolean;
  /** Endpoints exposing a boolean OnOff attribute. */
  lightEndpoints: number[];
  vendor: string | null;
  product: string | null;
  label: string | null;
}

/** What a newly paired node looks like in the commission response. */
export interface CommissionedNode {
  node_id: number;
  available: boolean;
  is_bridge: boolean;
}

/** A device advertising a commissioning window on the local IP network. */
export interface CommissionableDevice {
  instanceName: string;
  deviceName: string;
  vendorId: number;
  productId: number;
  deviceType: number;
  longDiscriminator: number;
  commissioningMode: number;
  addresses: string[];
  port: number;
}

/** Reading nodes and sending them cluster commands, which is all a light needs. */
export interface MatterNodes {
  /** Whether the controller is running and has loaded the commissioned nodes. */
  readonly ready: boolean;
  /** The node, or null if it isn't commissioned (or the controller isn't ready). */
  node(nodeId: number): MatterNode | null;
  invoke(
    nodeId: number,
    endpoint: number,
    cluster: number,
    command: string,
    payload: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<void>;
}

/** Pairing and fabric management, used by the API. */
export interface MatterAdmin {
  readonly ready: boolean;
  nodes(): NodeSummary[];
  discover(signal: AbortSignal): Promise<CommissionableDevice[]>;
  register(code: string, instanceName: string, signal: AbortSignal): Promise<CommissionedNode>;
  commission(code: string, networkOnly: boolean, signal: AbortSignal): Promise<CommissionedNode>;
  setWiFiCredentials(ssid: string, password: string): Promise<void>;
  setThreadDataset(dataset: string): Promise<void>;
  removeNode(nodeId: number, signal: AbortSignal): Promise<void>;
}

/** The Matter controller hasn't started (yet), or the hub runs without it. */
export class MatterNotReadyError extends Error {
  constructor() {
    super("Matter controller is not running");
    this.name = "MatterNotReadyError";
  }
}

/** An error the Matter controller returned for a command. */
export class MatterError extends Error {
  constructor(message: string, cause: unknown = null) {
    super(message, { cause });
    this.name = "MatterError";
  }
}

// Basic Information cluster (0x28) attributes on endpoint 0.
const attrVendorName = "0/40/1";
const attrProductName = "0/40/3";
const attrNodeLabel = "0/40/5";

/** The listing form of a node. */
export function summarize(n: MatterNode): NodeSummary {
  const text = (attr: string) => {
    const v = n.attributes[attr];
    return typeof v === "string" && v !== "" ? v : null;
  };
  return {
    nodeId: n.nodeId,
    available: n.available,
    isBridge: n.isBridge,
    lightEndpoints: Object.entries(n.attributes)
      .filter(([path, value]) => /^[1-9]\d*\/6\/0$/.test(path) && typeof value === "boolean")
      .map(([path]) => Number(path.split("/")[0]))
      .sort((a, b) => a - b),
    vendor: text(attrVendorName),
    product: text(attrProductName),
    label: text(attrNodeLabel),
  };
}

/** Rejects with the signal's reason if it aborts before p settles. */
export function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  const reason = () => (signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)));
  if (signal.aborted) {
    return Promise.reject(reason());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(reason());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

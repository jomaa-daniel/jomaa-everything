import type { MatterDeviceConfig } from "../config.js";
import {
  kelvinAtPct,
  noFeatures,
  pctFromKelvin,
  turnsOff,
  type Command,
  type Device,
  type Features,
  type RGB,
  type State,
} from "../device.js";
import { MatterError, MatterNotReadyError, type MatterNode, type MatterNodes } from "./nodes.js";

// Cluster ids and attribute ids from the Matter spec.
const clusterOnOff = 6;
const clusterLevelControl = 8;
const clusterColorControl = 0x0300;

const attrOnOff = 0; // OnOff.OnOff
const attrCurrentLevel = 0; // LevelControl.CurrentLevel
const attrCurrentHue = 0; // ColorControl.CurrentHue
const attrColorTempMireds = 7; // ColorControl.ColorTemperatureMireds
const attrColorTempMinMired = 0x400b; // ColorControl.ColorTempPhysicalMinMireds
const attrColorTempMaxMired = 0x400c; // ColorControl.ColorTempPhysicalMaxMireds

const maxLevel = 254;

/**
 * A Matter light (or plug) on one endpoint of a commissioned node. Commands go
 * straight to the hub's Matter controller; state comes from the attribute
 * reports the controller keeps for each node.
 */
export class MatterLight implements Device {
  readonly id: string;
  readonly #configuredName: string;
  readonly #matter: MatterNodes;
  readonly #nodeId: number;
  readonly #endpoint: number;
  // Fallback when the device doesn't report its range.
  readonly #minK: number;
  readonly #maxK: number;

  constructor(matter: MatterNodes, cfg: MatterDeviceConfig) {
    this.#matter = matter;
    this.id = cfg.id;
    this.#configuredName = cfg.name;
    this.#nodeId = cfg.nodeId;
    this.#endpoint = cfg.endpoint;
    this.#minK = cfg.minKelvin;
    this.#maxK = cfg.maxKelvin;
  }

  get name(): string {
    return this.#matter.node(this.#nodeId)?.displayName ?? this.#configuredName;
  }

  get nodeId(): number {
    return this.#nodeId;
  }

  #path(cluster: number, attr: number): string {
    return `${this.#endpoint}/${cluster}/${attr}`;
  }

  #attr(n: MatterNode, cluster: number, attr: number): unknown {
    return n.attributes[this.#path(cluster, attr)];
  }

  #node(): MatterNode {
    const n = this.#matter.node(this.#nodeId);
    if (n === null) {
      if (!this.#matter.ready) {
        throw new MatterNotReadyError();
      }
      throw new MatterError(`matter node ${this.#nodeId} is not commissioned`);
    }
    if (!n.available) {
      throw new MatterError(`matter node ${this.#nodeId} is unreachable`);
    }
    return n;
  }

  /** Reads what the endpoint supports from which clusters it exposes. */
  features(): Features {
    const n = this.#matter.node(this.#nodeId);
    if (n === null) {
      return noFeatures;
    }
    const has = (cluster: number, attr: number) => this.#path(cluster, attr) in n.attributes;
    return {
      brightness: has(clusterLevelControl, attrCurrentLevel),
      colorTemperature: has(clusterColorControl, attrColorTempMireds),
      color: has(clusterColorControl, attrCurrentHue),
    };
  }

  /** Prefers the range the device reports over the configured one. */
  #kelvinRange(n: MatterNode): [minK: number, maxK: number] {
    const minM = this.#attr(n, clusterColorControl, attrColorTempMinMired);
    const maxM = this.#attr(n, clusterColorControl, attrColorTempMaxMired);
    if (typeof minM === "number" && typeof maxM === "number" && minM > 0 && maxM > minM) {
      return [miredsToKelvin(maxM), miredsToKelvin(minM)];
    }
    return [this.#minK, this.#maxK];
  }

  /**
   * Sends power first, then level and color. Fields the device doesn't
   * support are skipped, so a room can mix bulbs and plugs.
   */
  async apply(cmd: Command, signal: AbortSignal): Promise<void> {
    const n = this.#node();
    const f = this.features();
    const send = (cluster: number, name: string, payload: Record<string, unknown>) =>
      this.#matter.invoke(this.#nodeId, this.#endpoint, cluster, name, payload, signal);
    const opts = (p: Record<string, unknown>) => ({ ...p, transitionTime: 0, optionsMask: 0, optionsOverride: 0 });

    if (cmd.on !== null) {
      await send(clusterOnOff, cmd.on ? "on" : "off", {});
    }
    if (turnsOff(cmd)) {
      return;
    }
    if (cmd.brightness !== null && f.brightness) {
      await send(clusterLevelControl, "moveToLevelWithOnOff", opts({ level: pctToLevel(cmd.brightness) }));
    }
    if (cmd.colorTemperaturePct !== null && f.colorTemperature) {
      const [minK, maxK] = this.#kelvinRange(n);
      const mireds = kelvinToMireds(kelvinAtPct(minK, maxK, cmd.colorTemperaturePct));
      await send(clusterColorControl, "moveToColorTemperature", opts({ colorTemperatureMireds: mireds }));
    }
    if (cmd.color !== null && f.color) {
      const [hue, saturation] = rgbToHueSat(cmd.color);
      await send(clusterColorControl, "moveToHueAndSaturation", opts({ hue, saturation }));
    }
  }

  /** Reads the light's state from the attributes the controller last received. */
  state(): Promise<State> {
    return Promise.resolve().then(() => {
      const n = this.#node();
      const on = this.#attr(n, clusterOnOff, attrOnOff);
      if (typeof on !== "boolean") {
        throw new MatterError(`matter node ${this.#nodeId} has no OnOff on endpoint ${this.#endpoint}`);
      }
      const s: State = { on, brightness: 0, colorTemperaturePct: 0 };
      // CurrentLevel and ColorTemperatureMireds can be null; leave zero then.
      const level = this.#attr(n, clusterLevelControl, attrCurrentLevel);
      if (typeof level === "number") {
        s.brightness = levelToPct(level);
      }
      const mireds = this.#attr(n, clusterColorControl, attrColorTempMireds);
      if (typeof mireds === "number" && mireds > 0) {
        const [minK, maxK] = this.#kelvinRange(n);
        s.colorTemperaturePct = pctFromKelvin(minK, maxK, miredsToKelvin(mireds));
      }
      return s;
    });
  }
}

function pctToLevel(pct: number): number {
  return Math.max(1, Math.round((pct * maxLevel) / 100));
}

function levelToPct(level: number): number {
  return Math.round((level * 100) / maxLevel);
}

function kelvinToMireds(k: number): number {
  return Math.round(1e6 / k);
}

function miredsToKelvin(m: number): number {
  return Math.round(1e6 / m);
}

/** Converts to Matter's 0-254 hue and saturation scales. */
export function rgbToHueSat(c: RGB): [hue: number, saturation: number] {
  const r = c.r / 255;
  const g = c.g / 255;
  const b = c.b / 255;
  const hi = Math.max(r, g, b);
  const lo = Math.min(r, g, b);
  const d = hi - lo;
  let h: number;
  if (d === 0) {
    h = 0;
  } else if (hi === r) {
    h = ((g - b) / d) % 6;
  } else if (hi === g) {
    h = (b - r) / d + 2;
  } else {
    h = (r - g) / d + 4;
  }
  h *= 60;
  if (h < 0) {
    h += 360;
  }
  const s = hi > 0 ? d / hi : 0;
  return [Math.round((h / 360) * 254), Math.round(s * 254)];
}

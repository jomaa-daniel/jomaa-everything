// Drives Govee lights through Govee's cloud API (https://developer.govee.com).
import { randomUUID } from "node:crypto";
import type { GoveeDeviceConfig } from "./config.js";
import {
  allFeatures,
  kelvinAtPct,
  pctFromKelvin,
  turnsOff,
  type Command,
  type Device,
  type Features,
  type State,
} from "./device.js";
import { Fields, JsonShapeError, parseJson } from "./json.js";

/** Govee's public API. */
export const defaultBaseURL = "https://openapi.api.govee.com";

const capOnOff = "devices.capabilities.on_off";
const capRange = "devices.capabilities.range";
const capColor = "devices.capabilities.color_setting";
const requestTimeoutMs = 10_000;

/** Which light a request is about. */
interface Target {
  sku: string;
  device: string;
}

interface Control extends Target {
  capability: { type: string; instance: string; value: number };
}

/** Holds the API key and base URL shared by every Govee light. */
export class GoveeClient {
  constructor(
    readonly apiKey: string,
    readonly baseURL: string,
  ) {}

  /** Posts a request and returns the response's payload. */
  async post(path: string, payload: Target | Control, signal: AbortSignal): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(this.baseURL + path, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Govee-API-Key": this.apiKey },
        body: JSON.stringify({ requestId: randomUUID(), payload }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)]),
      });
    } catch (err) {
      throw new Error(`govee ${path}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    const raw = (await res.text()).slice(0, 1 << 20);
    if (res.status !== 200) {
      throw new Error(`govee ${path}: HTTP ${res.status}: ${raw.trim()}`);
    }
    let out: Fields;
    let code: number | null;
    try {
      out = new Fields(parseJson(raw), "response");
      code = out.number("code");
    } catch (err) {
      if (err instanceof JsonShapeError) {
        throw new Error(`govee ${path}: bad response: ${err.message}`, { cause: err });
      }
      throw err;
    }
    // Govee reports some failures as HTTP 200 with a non-200 code in the body.
    if (code !== null && code !== 0 && code !== 200) {
      throw new Error(
        `govee ${path}: code ${code}: ${typeof out.value("msg") === "string" ? String(out.value("msg")) : ""}`,
      );
    }
    return out.value("payload");
  }
}

/** One Govee bulb or lamp. */
export class GoveeLight implements Device {
  readonly id: string;
  readonly name: string;
  readonly #client: GoveeClient;
  readonly #target: Target;
  readonly #minK: number;
  readonly #maxK: number;

  constructor(client: GoveeClient, cfg: GoveeDeviceConfig) {
    this.#client = client;
    this.id = cfg.id;
    this.name = cfg.name;
    this.#target = { sku: cfg.sku, device: cfg.device };
    this.#minK = cfg.minKelvin;
    this.#maxK = cfg.maxKelvin;
  }

  features(): Features {
    return allFeatures;
  }

  async #control(type: string, instance: string, value: number, signal: AbortSignal): Promise<void> {
    await this.#client.post(
      "/router/api/v1/device/control",
      { ...this.#target, capability: { type, instance, value } },
      signal,
    );
  }

  /**
   * Sends each changed field as its own Govee call, power first. Govee's API
   * takes one capability per request.
   */
  async apply(cmd: Command, signal: AbortSignal): Promise<void> {
    if (cmd.on !== null) {
      await this.#control(capOnOff, "powerSwitch", cmd.on ? 1 : 0, signal);
    }
    if (turnsOff(cmd)) {
      return;
    }
    if (cmd.brightness !== null) {
      await this.#control(capRange, "brightness", cmd.brightness, signal);
    }
    if (cmd.colorTemperaturePct !== null) {
      const k = kelvinAtPct(this.#minK, this.#maxK, cmd.colorTemperaturePct);
      await this.#control(capColor, "colorTemperatureK", k, signal);
    }
    if (cmd.color !== null) {
      await this.#control(capColor, "colorRgb", cmd.color.toInt(), signal);
    }
  }

  /** Asks Govee for the light's current state. */
  async state(signal: AbortSignal): Promise<State> {
    const payload = await this.#client.post("/router/api/v1/device/state", this.#target, signal);
    const values = stateValues(payload);
    const power = values.get("powerSwitch");
    if (power === undefined) {
      throw new Error(`govee state for ${this.id}: no powerSwitch value`);
    }
    const brightness = values.get("brightness");
    if (brightness === undefined) {
      throw new Error(`govee state for ${this.id}: no brightness value`);
    }
    const k = values.get("colorTemperatureK") ?? 0;
    return {
      on: power === 1,
      brightness: Math.trunc(brightness),
      colorTemperaturePct: k > 0 ? pctFromKelvin(this.#minK, this.#maxK, Math.trunc(k)) : 0,
    };
  }
}

/** The numeric state of each capability in a state response, by instance. */
function stateValues(payload: unknown): Map<string, number> {
  const values = new Map<string, number>();
  if (payload === null) {
    return values;
  }
  for (const raw of new Fields(payload, "payload").list("capabilities")) {
    const c = new Fields(raw, "capability");
    const instance = c.string("instance");
    const state = c.value("state");
    const value = state === null ? null : new Fields(state, "state").value("value");
    if (instance !== null && typeof value === "number") {
      values.set(instance, value);
    }
  }
  return values;
}

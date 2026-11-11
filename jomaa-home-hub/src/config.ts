// Loads the hub's device and room layout from a JSON file. Secrets (the hub
// password, the Govee API key) come from the environment, never from this file.
import { readFileSync } from "node:fs";
import { Fields, JsonShapeError, parseJson } from "./json.js";

/** The whole layout file, with defaults filled in. */
export interface Config {
  listen: string;
  devices: DeviceConfig[];
  rooms: RoomConfig[];
}

export type Driver = DeviceConfig["driver"];

/** One light. driver picks which fields apply. */
export type DeviceConfig = GoveeDeviceConfig | MatterDeviceConfig;

export interface GoveeDeviceConfig {
  driver: "govee";
  id: string;
  name: string;
  sku: string;
  /** The colon-separated device id Govee assigns. */
  device: string;
  minKelvin: number;
  maxKelvin: number;
}

export interface MatterDeviceConfig {
  driver: "matter";
  id: string;
  name: string;
  nodeId: number;
  /** Defaults to 1. */
  endpoint: number;
  /** The white range to assume when the device doesn't report one; defaults to 2700-6500K. */
  minKelvin: number;
  maxKelvin: number;
}

/**
 * Groups devices. Members may name devices or rooms listed earlier in the
 * file, so a "downstairs" room can contain "living-room" and "kitchen".
 */
export interface RoomConfig {
  id: string;
  name: string;
  members: string[];
}

const validID = /^[a-z0-9][a-z0-9-]*$/;

/** Reads and validates the layout file. */
export function loadConfig(path: string): Config {
  return parseConfig(readFileSync(path, "utf8"));
}

/** Decodes and validates a layout, filling in defaults. */
export function parseConfig(raw: string): Config {
  try {
    const top = new Fields(parseJson(raw), "config");
    const c: Config = {
      listen: top.string("listen") ?? ":8080",
      devices: top.list("devices").map(parseDevice),
      rooms: top.list("rooms").map(parseRoom),
    };
    validateConfig(c);
    return c;
  } catch (err) {
    if (err instanceof JsonShapeError) {
      throw new Error(`config: ${err.message}`, { cause: err });
    }
    throw err;
  }
}

function parseDevice(raw: unknown, i: number): DeviceConfig {
  const d = new Fields(raw, `device ${i + 1}`);
  const id = d.string("id") ?? "";
  const f = new Fields(raw, `device ${JSON.stringify(id)}`);
  const name = f.string("name") ?? "";
  const driver = f.string("driver") ?? "";
  switch (driver) {
    case "govee": {
      const sku = f.string("sku") ?? "";
      const device = f.string("device") ?? "";
      const minKelvin = f.int("minKelvin") ?? 0;
      const maxKelvin = f.int("maxKelvin") ?? 0;
      if (sku === "" || device === "") {
        throw new JsonShapeError(`govee device ${JSON.stringify(id)} needs sku and device`);
      }
      if (minKelvin <= 0 || maxKelvin <= minKelvin) {
        throw new JsonShapeError(`govee device ${JSON.stringify(id)} needs minKelvin < maxKelvin`);
      }
      return { driver, id, name, sku, device, minKelvin, maxKelvin };
    }
    case "matter": {
      const nodeId = f.int("nodeId") ?? 0;
      if (nodeId <= 0) {
        throw new JsonShapeError(`matter device ${JSON.stringify(id)} needs nodeId`);
      }
      return {
        driver,
        id,
        name,
        nodeId,
        endpoint: f.int("endpoint") || 1,
        minKelvin: f.int("minKelvin") || 2700,
        maxKelvin: f.int("maxKelvin") || 6500,
      };
    }
    default:
      throw new JsonShapeError(`device ${JSON.stringify(id)} has unknown driver ${JSON.stringify(driver)}`);
  }
}

function parseRoom(raw: unknown, i: number): RoomConfig {
  const r = new Fields(raw, `room ${i + 1}`);
  const id = r.string("id") ?? "";
  const members = r.list("members").map((m) => {
    if (typeof m !== "string") {
      throw new JsonShapeError(`room ${JSON.stringify(id)} members must be strings`);
    }
    return m;
  });
  return { id, name: r.string("name") ?? "", members };
}

/** Checks ids and room references. */
function validateConfig(c: Config): void {
  const seen = new Set<string>();
  const claim = (id: string) => {
    if (!validID.test(id)) {
      throw new JsonShapeError(`id ${JSON.stringify(id)} must be lowercase letters, digits and dashes`);
    }
    if (seen.has(id)) {
      throw new JsonShapeError(`id ${JSON.stringify(id)} is used twice`);
    }
    seen.add(id);
  };
  for (const d of c.devices) {
    claim(d.id);
  }
  for (const r of c.rooms) {
    // Check members before claiming the room's own id, so a room can't
    // contain itself and every reference points backwards (no cycles).
    for (const m of r.members) {
      if (!seen.has(m)) {
        throw new JsonShapeError(
          `room ${JSON.stringify(r.id)} lists ${JSON.stringify(m)}, which isn't a device or an earlier room`,
        );
      }
    }
    claim(r.id);
  }
}

/** Whether any device needs the given driver. */
export function usesDriver(c: Config, driver: Driver): boolean {
  return c.devices.some((d) => d.driver === driver);
}

/** A listen address; a null host means every interface. */
export interface ListenAddress {
  host: string | null;
  port: number;
}

/** Splits a listen address like ":8080", "127.0.0.1:8080" or "[::1]:8080". */
export function parseListen(listen: string): ListenAddress {
  const m = /^(?:\[([^\]]+)\]|([^:]*)):(\d+)$/.exec(listen);
  if (m === null || Number(m[3]) > 65535) {
    throw new Error(`config: listen ${JSON.stringify(listen)} must look like host:port or :port`);
  }
  const host = m[1] ?? m[2] ?? "";
  return { host: host === "" ? null : host, port: Number(m[3]) };
}

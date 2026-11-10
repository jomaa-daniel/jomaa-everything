// Holds every device and room by id and runs commands and sync passes against
// them. It doesn't care which brand a device is.
import type { Config, Driver } from "./config.js";
import { errorMessage, noChange, validate, type Command, type Device, type Features, type State } from "./device.js";
import { GoveeLight, type GoveeClient } from "./govee.js";
import { failures, Group, leaves, summarize } from "./group.js";
import { MatterLight } from "./matter/light.js";
import type { MatterNodes } from "./matter/nodes.js";

/** The id names no device or room. */
export class NotFoundError extends Error {
  constructor() {
    super("no device or room with that id");
    this.name = "NotFoundError";
  }
}

/** A device or room as the API lists it. */
export type Target = DeviceTarget | RoomTarget;

export interface DeviceTarget {
  id: string;
  name: string;
  kind: Kind;
  features: Features;
}

export interface RoomTarget {
  id: string;
  name: string;
  kind: "room";
  members: string[];
  features: Features;
}

/** Which driver runs a device; "test" for the stand-ins in tests. */
export type Kind = Driver | "test";

/** A target's summary state plus each device's own state. */
export interface StateResult {
  /** null when no device under the target answered. */
  state: State | null;
  devices: Record<string, State>;
  failed: Record<string, string>;
}

/**
 * The state a client last asked for. The client owns it and
 * sends it with each sync; the hub only tracks revisions. null fields aren't
 * checked.
 */
export interface Desired {
  /** "" for clients that don't say. */
  clientId: string;
  revision: number | null;
  on: boolean | null;
  brightness: number | null;
  colorTemperaturePct: number | null;
}

/** What a sync pass found and fixed, by device id. */
export interface SyncResult {
  synchronized: boolean;
  stale: boolean;
  corrected: Record<string, string[]>;
  failed: Record<string, string>;
  observed: Record<string, State>;
}

// Values within this many points count as matching. Converting between
// percent, kelvin, mireds and Matter's 0-254 levels can be off by one.
const tolerance = 1;

type Entry = { kind: Kind; device: Device } | { kind: "room"; device: Group };

/** Every device and room by id, in the order they were added. */
export class Hub {
  readonly #entries = new Map<string, Entry>();
  readonly #revs = new Revisions();

  /** Registers a device under the driver that runs it. */
  addDevice(kind: Kind, d: Device): void {
    this.#add({ kind, device: d });
  }

  /** Registers a room. */
  addRoom(g: Group): void {
    this.#add({ kind: "room", device: g });
  }

  #add(e: Entry): void {
    if (this.#entries.has(e.device.id)) {
      throw new Error(`duplicate id ${JSON.stringify(e.device.id)}`);
    }
    this.#entries.set(e.device.id, e);
  }

  /** Creates the hub from a validated config. */
  static build(cfg: Config, govee: GoveeClient, matter: MatterNodes): Hub {
    const h = new Hub();
    for (const d of cfg.devices) {
      h.addDevice(d.driver, d.driver === "govee" ? new GoveeLight(govee, d) : new MatterLight(matter, d));
    }
    for (const r of cfg.rooms) {
      // The config was validated, so every member was added before its room.
      h.addRoom(
        new Group(
          r.id,
          r.name,
          r.members.map((m) => h.#find(m)),
        ),
      );
    }
    return h;
  }

  /** Looks up a device or room. */
  get(id: string): Device | null {
    return this.#entries.get(id)?.device ?? null;
  }

  /** Every device and room in config order. */
  list(): Target[] {
    return [...this.#entries.values()].map((e): Target => {
      const base = { id: e.device.id, name: e.device.name, features: e.device.features() };
      return e.kind === "room"
        ? { ...base, kind: "room", members: e.device.members.map((m) => m.id) }
        : { ...base, kind: e.kind };
    });
  }

  /** Reads the target and every device under it. */
  async state(id: string, signal: AbortSignal): Promise<StateResult> {
    const d = this.#find(id);
    const { states, failed } = await observe(leaves(d), signal);
    // Each device is read once; the room summary comes from those reads.
    const state = d instanceof Group ? summarize(d, states) : (states[d.id] ?? null);
    return { state, devices: states, failed };
  }

  /**
   * Validates cmd and sends it to the target, recording the client's revision
   * so older sync passes from that client stand down. Returns the devices that
   * failed, by id.
   */
  async command(
    id: string,
    cmd: Command,
    clientId: string,
    revision: number | null,
    signal: AbortSignal,
  ): Promise<Record<string, string>> {
    const d = this.#find(id);
    validate(cmd);
    this.#revs.note(clientId, revision);
    try {
      await d.apply(cmd, signal);
      return {};
    } catch (err) {
      return failures(id, err);
    }
  }

  /**
   * Checks every device under the target against want and corrects only the
   * devices and fields that drifted. Each bulb is checked on its own.
   */
  async sync(id: string, want: Desired, signal: AbortSignal): Promise<SyncResult> {
    const d = this.#find(id);
    const clientId = this.#revs.note(want.clientId, want.revision);
    if (this.#revs.stale(clientId, want.revision)) {
      return { synchronized: false, stale: true, corrected: {}, failed: {}, observed: {} };
    }

    const all = leaves(d);
    const { states, failed } = await observe(all, signal);
    const corrected: Record<string, string[]> = {};
    const fixes = new Map<Device, Command>();
    for (const l of all) {
      const s = states[l.id];
      if (s === undefined) {
        continue;
      }
      const { cmd, fields } = drift(want, s, l.features());
      if (fields.length > 0) {
        fixes.set(l, cmd);
        corrected[l.id] = fields;
      }
    }

    // A newer command may have landed while we were reading state.
    if (fixes.size > 0 && this.#revs.stale(clientId, want.revision)) {
      return { synchronized: false, stale: true, corrected: {}, failed: {}, observed: states };
    }

    await Promise.all(
      [...fixes].map(async ([l, cmd]) => {
        try {
          await l.apply(cmd, signal);
        } catch (err) {
          failed[l.id] = errorMessage(err);
        }
      }),
    );

    const synchronized = Object.keys(corrected).length === 0 && Object.keys(failed).length === 0;
    return { synchronized, stale: false, corrected, failed, observed: states };
  }

  #find(id: string): Device {
    const e = this.#entries.get(id);
    if (e === undefined) {
      throw new NotFoundError();
    }
    return e.device;
  }
}

async function observe(
  devices: Device[],
  signal: AbortSignal,
): Promise<{ states: Record<string, State>; failed: Record<string, string> }> {
  const states: Record<string, State> = {};
  const failed: Record<string, string> = {};
  await Promise.all(
    devices.map(async (l) => {
      try {
        states[l.id] = await l.state(signal);
      } catch (err) {
        failed[l.id] = errorMessage(err);
      }
    }),
  );
  return { states, failed };
}

/** The command that moves s to want, and the fields it touches. */
function drift(want: Desired, s: State, f: Features): { cmd: Command; fields: string[] } {
  const cmd: Command = { ...noChange };
  const fields: string[] = [];
  if (want.on !== null && s.on !== want.on) {
    cmd.on = want.on;
    fields.push("on");
  }
  // Only fix levels when the light should be on, or a correction could
  // switch an off light back on.
  if (want.on === false) {
    return { cmd, fields };
  }
  if (f.brightness && want.brightness !== null && Math.abs(s.brightness - want.brightness) > tolerance) {
    cmd.brightness = want.brightness;
    fields.push("brightness");
  }
  if (
    f.colorTemperature &&
    want.colorTemperaturePct !== null &&
    Math.abs(s.colorTemperaturePct - want.colorTemperaturePct) > tolerance
  ) {
    cmd.colorTemperaturePct = want.colorTemperaturePct;
    fields.push("colorTemperaturePct");
  }
  return { cmd, fields };
}

const defaultClientId = "default";

/**
 * Remembers the newest revision each client has sent, so a slow sync can't
 * undo a command the same client sent after it. A client
 * uses one counter for everything it controls: a newer command to a single
 * lamp also retires an older sync of the room that lamp is in.
 */
class Revisions {
  readonly #latest = new Map<string, number>();

  /** Records rev and returns the id the client is tracked under. */
  note(clientId: string, rev: number | null): string {
    const id = clientId === "" ? defaultClientId : clientId;
    if (rev !== null && rev >= 0 && rev > (this.#latest.get(id) ?? 0)) {
      this.#latest.set(id, rev);
    }
    return id;
  }

  stale(clientId: string, rev: number | null): boolean {
    return rev !== null && rev < (this.#latest.get(clientId) ?? 0);
  }
}

import { errorMessage, noFeatures, type Command, type Device, type Features, type State } from "./device.js";

/** Lists which members of a room failed and why. */
export class GroupError extends Error {
  constructor(readonly failed: ReadonlyMap<string, unknown>) {
    const ids = [...failed.keys()].sort();
    super(`${ids.length} device(s) failed: ${ids.map((id) => `${id}: ${errorMessage(failed.get(id))}`).join("; ")}`);
    this.name = "GroupError";
  }
}

/**
 * A room: it implements Device by sending every command to all of its members
 * at once. A slow or broken bulb never stops the rest from changing; failures
 * come back together as a GroupError.
 */
export class Group implements Device {
  constructor(
    readonly id: string,
    readonly name: string,
    readonly members: readonly Device[],
  ) {}

  /** Sends cmd to every member at once. */
  async apply(cmd: Command, signal: AbortSignal): Promise<void> {
    const error = await this.#each((d) => d.apply(cmd, signal));
    if (error !== null) {
      throw error;
    }
  }

  /**
   * Summarizes the room: it is on if any member is on, and brightness and
   * color temperature come from the first member that is on (or the first that
   * answered, if all are off). Use memberStates for the per-device view.
   */
  async state(signal: AbortSignal): Promise<State> {
    const { states, error } = await this.memberStates(signal);
    let summary: State | null = null;
    for (const m of this.members) {
      const s = states.get(m.id);
      if (s !== undefined && (summary === null || (s.on && !summary.on))) {
        summary = s;
      }
    }
    if (summary === null) {
      throw error ?? new Error("group has no members");
    }
    return summary;
  }

  /** What any of the room's devices can do. */
  features(): Features {
    return this.members.reduce<Features>((f, m) => {
      const mf = m.features();
      return {
        brightness: f.brightness || mf.brightness,
        colorTemperature: f.colorTemperature || mf.colorTemperature,
        color: f.color || mf.color,
      };
    }, noFeatures);
  }

  /**
   * Queries every member at once. It returns whatever states it got plus a
   * GroupError for members that didn't answer, or null if all did.
   */
  async memberStates(signal: AbortSignal): Promise<{ states: Map<string, State>; error: GroupError | null }> {
    const states = new Map<string, State>();
    const error = await this.#each(async (d) => {
      states.set(d.id, await d.state(signal));
    });
    return { states, error };
  }

  /** Runs fn on every member at once, collecting failures. */
  async #each(fn: (d: Device) => Promise<void>): Promise<GroupError | null> {
    const failed = new Map<string, unknown>();
    await Promise.all(
      this.members.map(async (d) => {
        try {
          await fn(d);
        } catch (err) {
          failed.set(d.id, err);
        }
      }),
    );
    return failed.size > 0 ? new GroupError(failed) : null;
  }
}

/**
 * Flattens err into a device-id -> message map. Nested groups are expanded so
 * callers see the individual bulbs that failed.
 */
export function failures(id: string, err: unknown): Record<string, string> {
  if (!(err instanceof GroupError)) {
    return { [id]: errorMessage(err) };
  }
  const out: Record<string, string> = {};
  for (const [mid, merr] of err.failed) {
    Object.assign(out, failures(mid, merr));
  }
  return out;
}

/** The individual devices under d, expanding nested groups. */
export function leaves(d: Device): Device[] {
  return d instanceof Group ? d.members.flatMap(leaves) : [d];
}

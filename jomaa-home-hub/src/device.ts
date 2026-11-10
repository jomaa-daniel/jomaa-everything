// The one interface every controllable thing in the hub implements, whether it
// is a single Govee bulb, a Matter light, or a room that fans commands out to
// its members.

/**
 * What a light reports back. brightness and colorTemperaturePct are both
 * 0-100. colorTemperaturePct runs from the device's warmest white (0) to its
 * coolest (100), so the same number means the same thing across brands.
 */
export interface State {
  on: boolean;
  brightness: number;
  colorTemperaturePct: number;
}

/** A partial update. null fields are left alone. */
export interface Command {
  on: boolean | null;
  brightness: number | null;
  colorTemperaturePct: number | null;
  color: RGB | null;
}

/** A command that changes nothing; spread it and set the fields to change. */
export const noChange: Command = Object.freeze({ on: null, brightness: null, colorTemperaturePct: null, color: null });

/** Which fields a device can actually change. A smart plug, say, only switches on and off. */
export interface Features {
  brightness: boolean;
  colorTemperature: boolean;
  color: boolean;
}

/** Every field, for devices that support them all. */
export const allFeatures: Features = Object.freeze({ brightness: true, colorTemperature: true, color: true });

/** No fields beyond on and off. */
export const noFeatures: Features = Object.freeze({ brightness: false, colorTemperature: false, color: false });

/** Anything the hub can send a command to. */
export interface Device {
  readonly id: string;
  readonly name: string;
  apply(cmd: Command, signal: AbortSignal): Promise<void>;
  state(signal: AbortSignal): Promise<State>;
  features(): Features;
}

/** A command rejected before anything was sent. */
export class InvalidCommandError extends Error {
  constructor(detail: string) {
    super(`invalid command: ${detail}`);
    this.name = "InvalidCommandError";
  }
}

/** Rejects empty commands and out-of-range values. */
export function validate(c: Command): void {
  if (c.on === null && c.brightness === null && c.colorTemperaturePct === null && c.color === null) {
    throw new InvalidCommandError("no fields set");
  }
  if (c.brightness !== null && (c.brightness < 1 || c.brightness > 100)) {
    throw new InvalidCommandError("brightness must be 1-100");
  }
  if (c.colorTemperaturePct !== null && (c.colorTemperaturePct < 0 || c.colorTemperaturePct > 100)) {
    throw new InvalidCommandError("colorTemperaturePct must be 0-100");
  }
}

/**
 * Whether the command switches the light off. Drivers skip level and color
 * changes in that case so a correction can't relight a lamp.
 */
export function turnsOff(c: Command): boolean {
  return c.on === false;
}

/** A color, written in JSON as "#rrggbb". */
export class RGB {
  constructor(
    readonly r: number,
    readonly g: number,
    readonly b: number,
  ) {}

  /** Parses "#rrggbb". */
  static parse(s: string): RGB {
    if (!/^#[0-9a-fA-F]{6}$/.test(s)) {
      throw new InvalidCommandError("color must look like #rrggbb");
    }
    const n = parseInt(s.slice(1), 16);
    return new RGB(n >> 16, (n >> 8) & 0xff, n & 0xff);
  }

  /** The color packed as 0xRRGGBB, the form Govee expects. */
  toInt(): number {
    return (this.r << 16) | (this.g << 8) | this.b;
  }

  toString(): string {
    return "#" + this.toInt().toString(16).padStart(6, "0");
  }

  toJSON(): string {
    return this.toString();
  }
}

/** Maps 0-100 onto a device's white range (0 = warmest). */
export function kelvinAtPct(minK: number, maxK: number, pct: number): number {
  return minK + Math.trunc(((maxK - minK) * pct) / 100 + 0.5);
}

/** The inverse of kelvinAtPct, clamped to 0-100. */
export function pctFromKelvin(minK: number, maxK: number, k: number): number {
  if (maxK <= minK) {
    return 0;
  }
  return Math.min(100, Math.max(0, Math.trunc(((k - minK) * 100) / (maxK - minK) + 0.5)));
}

/** The message of anything thrown, for reporting per-device failures. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

import { GoveeLight } from "../govee.js";
import type { Hub, DeviceTarget } from "../hub.js";
import { settings } from "../settings.js";

export interface ConnectionStatus {
  status: "online" | "offline" | "unknown";
  checkedAt: number;
  statusSource: "Govee cloud";
  reason: string | null;
}

/** Shares read-only cloud checks across inventory refreshes. */
export class Connectivity {
  readonly #cache = new WeakMap<GoveeLight, { expiresAt: number; result: Promise<ConnectionStatus> }>();
  constructor(
    private readonly hub: Hub,
    private readonly now: () => number = Date.now,
  ) {}

  async govee(): Promise<Array<DeviceTarget & ConnectionStatus>> {
    const signal = AbortSignal.timeout(settings.health.goveeStatusTimeoutSeconds * 1000);
    const targets = this.hub.list().filter((target): target is DeviceTarget => target.kind === "govee");
    const results = new Map<string, ConnectionStatus>();
    let next = 0;
    const worker = async () => {
      while (next < targets.length) {
        const target = targets[next++];
        if (!target) return;
        const device = this.hub.get(target.id);
        if (!(device instanceof GoveeLight)) {
          results.set(target.id, {
            status: "unknown",
            checkedAt: this.now(),
            statusSource: "Govee cloud",
            reason: "Connection checking is unavailable.",
          });
          continue;
        }
        results.set(target.id, await this.check(device, signal));
      }
    };
    await Promise.all(Array.from({ length: Math.min(targets.length, settings.health.goveeStatusConcurrency) }, worker));
    return targets.map((target) => {
      const result = results.get(target.id);
      if (!result) throw new Error("Connection result is missing");
      return { ...target, ...result };
    });
  }

  private check(device: GoveeLight, signal: AbortSignal): Promise<ConnectionStatus> {
    const cached = this.#cache.get(device);
    if (cached && cached.expiresAt > this.now()) return cached.result;
    const entry = { expiresAt: Infinity, result: this.read(device, signal) };
    this.#cache.set(device, entry);
    void entry.result.then(() => {
      entry.expiresAt = this.now() + settings.health.goveeStatusCacheSeconds * 1000;
    });
    return entry.result;
  }

  private async read(device: GoveeLight, signal: AbortSignal): Promise<ConnectionStatus> {
    try {
      const online = await device.connection(signal);
      return {
        status: online === null ? "unknown" : online ? "online" : "offline",
        checkedAt: this.now(),
        statusSource: "Govee cloud",
        reason: online === null ? "Govee did not return connection status." : null,
      };
    } catch {
      return {
        status: "unknown",
        checkedAt: this.now(),
        statusSource: "Govee cloud",
        reason: "The Govee status check failed.",
      };
    }
  }
}

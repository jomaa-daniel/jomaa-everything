// Rooms and lights: listing, state, commands, and sync.
import { InvalidCommandError, noChange, RGB, type Command } from "./device.js";
import { NotFoundError, type Desired, type Hub } from "./hub.js";
import {
  HttpError,
  readBody,
  route,
  withTimeout,
  writeJSON,
  type FeatureModule,
  type RequestContext,
  type Route,
} from "./http.js";
import type { Log } from "./log.js";

const commandTimeoutMs = 15_000;

export class LightsModule implements FeatureModule {
  constructor(
    private readonly hub: Hub,
    private readonly log: Log,
  ) {}

  routes(): Route[] {
    return [
      route("GET", "/api/targets", "lights", (ctx) => this.#listTargets(ctx)),
      route("GET", "/api/targets/{id}/state", "lights", (ctx) => this.#targetState(ctx)),
      route("POST", "/api/targets/{id}/command", "lights", (ctx) => this.#command(ctx)),
      route("POST", "/api/targets/{id}/sync", "lights", (ctx) => this.#sync(ctx)),
    ];
  }

  async #listTargets({ res }: RequestContext): Promise<void> {
    writeJSON(res, 200, { targets: this.hub.list() });
    return Promise.resolve();
  }

  async #targetState({ res, params, signal }: RequestContext): Promise<void> {
    const result = await hubCall(() => this.hub.state(params[0] ?? "", withTimeout(signal, commandTimeoutMs)));
    writeJSON(res, 200, result);
  }

  /**
   * Answers 200 with the devices that didn't take the command, by id; the map
   * is empty when every device took it.
   */
  async #command({ req, res, params, signal }: RequestContext): Promise<void> {
    const body = (await readBody(req)).only("on", "brightness", "colorTemperaturePct", "color", "clientId", "revision");
    const color = body.string("color");
    const id = params[0] ?? "";
    const failed = await hubCall(() => {
      const cmd: Command = {
        ...noChange,
        on: body.bool("on"),
        brightness: body.int("brightness"),
        colorTemperaturePct: body.int("colorTemperaturePct"),
        color: color === null ? null : RGB.parse(color),
      };
      return this.hub.command(
        id,
        cmd,
        body.string("clientId") ?? "",
        body.int("revision"),
        withTimeout(signal, commandTimeoutMs),
      );
    });
    if (Object.keys(failed).length > 0) this.log.warn("command partly failed", { target: id, failed });
    writeJSON(res, 200, { failed });
  }

  async #sync({ req, res, params, signal }: RequestContext): Promise<void> {
    const body = (await readBody(req)).only("clientId", "revision", "on", "brightness", "colorTemperaturePct");
    const want: Desired = {
      clientId: body.string("clientId") ?? "",
      revision: body.int("revision"),
      on: body.bool("on"),
      brightness: body.int("brightness"),
      colorTemperaturePct: body.int("colorTemperaturePct"),
    };
    const result = await hubCall(() => this.hub.sync(params[0] ?? "", want, withTimeout(signal, commandTimeoutMs)));
    writeJSON(res, 200, result);
  }
}

async function hubCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof NotFoundError) throw new HttpError(404, err.message);
    if (err instanceof InvalidCommandError) throw new HttpError(400, err.message);
    throw err;
  }
}

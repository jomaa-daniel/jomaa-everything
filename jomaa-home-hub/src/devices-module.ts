// Matter pairing and node management. Device health is served by HealthHttp,
// which authenticates device reports with their own credentials.
import { assignMatterGroup } from "./group-assignment.js";
import type { Hub } from "./hub.js";
import {
  HttpError,
  readBody,
  requireSameOrigin,
  route,
  withTimeout,
  writeJSON,
  type FeatureModule,
  type RequestContext,
  type Route,
} from "./http.js";
import type { LayoutChanges } from "./layout-changes.js";
import type { Log } from "./log.js";
import { MatterError, MatterNotReadyError, type MatterAdmin } from "./matter/nodes.js";
import type { Organization } from "./organization.js";

const commandTimeoutMs = 15_000;
const pairingTimeoutMs = 5 * 60_000;

export class DevicesModule implements FeatureModule {
  constructor(
    private readonly hub: Hub,
    private readonly matter: MatterAdmin,
    private readonly layout: LayoutChanges,
    private readonly log: Log,
    private readonly layoutPath?: string,
    private readonly organization?: Organization,
  ) {}

  routes(): Route[] {
    return [
      route("GET", "/api/matter/nodes", "devices", (ctx) => this.#matterNodes(ctx)),
      route("GET", "/api/matter/discover", "devices", (ctx) => this.#matterDiscover(ctx)),
      route("POST", "/api/matter/register", "devices", (ctx) => this.#matterRegister(ctx)),
      route("PATCH", "/api/matter/nodes/{nodeId}/name", "devices", (ctx) => this.#matterRename(ctx)),
      route("PATCH", "/api/matter/nodes/{nodeId}/group", "devices", (ctx) => this.#matterGroup(ctx)),
      route("DELETE", "/api/matter/nodes/{nodeId}", "devices", (ctx) => this.#matterRemove(ctx)),
      route("POST", "/api/matter/commission", "devices", (ctx) => this.#matterCommission(ctx)),
      route("POST", "/api/matter/wifi", "devices", (ctx) => this.#matterWiFi(ctx)),
      route("POST", "/api/matter/thread", "devices", (ctx) => this.#matterThread(ctx)),
    ];
  }

  async #matterNodes({ res }: RequestContext): Promise<void> {
    const nodes = await this.#matterCall(() => Promise.resolve(this.matter.nodes()));
    writeJSON(res, 200, { nodes });
  }

  async #matterDiscover({ res, signal }: RequestContext): Promise<void> {
    const devices = await this.#matterCall(() => this.matter.discover(withTimeout(signal, commandTimeoutMs)));
    writeJSON(res, 200, { devices });
  }

  async #matterRegister({ req, res, signal }: RequestContext): Promise<void> {
    requireSameOrigin(req);
    const body = (await readBody(req)).only("code", "instanceName");
    const raw = (body.string("code") ?? "").trim();
    const code = raw.startsWith("MT:") ? raw : raw.replace(/[\s-]/g, "");
    const instanceName = body.string("instanceName") ?? "";
    if (code === "" || instanceName === "") throw new HttpError(400, "setup code and selected device are required");
    if (!code.startsWith("MT:") && !/^(?:\d{11}|\d{21})$/.test(code)) {
      throw new HttpError(400, "use an 11- or 21-digit Matter setup code or an MT: QR payload");
    }
    try {
      const node = await this.#matterCall(() =>
        this.matter.register(code, instanceName, withTimeout(signal, pairingTimeoutMs)),
      );
      writeJSON(res, 201, { node });
    } catch (err) {
      if (err instanceof HttpError) {
        throw new HttpError(err.status, err.message.replaceAll(code, "[redacted]").replaceAll(raw, "[redacted]"));
      }
      throw new HttpError(500, "Matter registration failed. Refresh the inventory before trying again.");
    }
  }

  async #matterRename({ req, res, params }: RequestContext): Promise<void> {
    requireSameOrigin(req);
    const raw = params[0] ?? "";
    const nodeId = Number(raw);
    if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(nodeId)) throw new HttpError(400, "invalid Matter node ID");
    const name = ((await readBody(req)).only("name").string("name") ?? "").trim();
    if (name.length < 1 || name.length > 80) throw new HttpError(400, "name must contain 1 to 80 characters");
    const node = await this.#matterCall(async () => {
      if (!this.matter.nodes().some((candidate) => candidate.nodeId === nodeId))
        throw new HttpError(404, "Matter node not found");
      return this.matter.rename(nodeId, name);
    });
    writeJSON(res, 200, { node });
  }

  async #matterGroup({ req, res, params }: RequestContext): Promise<void> {
    requireSameOrigin(req);
    if (this.layoutPath === undefined) throw new HttpError(503, "group editing is unavailable");
    const raw = params[0] ?? "";
    const nodeId = Number(raw);
    if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(nodeId)) throw new HttpError(400, "invalid Matter node ID");
    const groupId = (await readBody(req)).only("groupId").required("groupId").string("groupId");
    if (groupId !== null && !this.hub.list().some((target) => target.kind === "room" && target.id === groupId)) {
      throw new HttpError(400, "selected group does not exist");
    }
    const node = await this.#matterCall(() => {
      const value = this.matter.nodes().find((candidate) => candidate.nodeId === nodeId);
      if (!value) throw new HttpError(404, "Matter node not found");
      return Promise.resolve(value);
    });
    const path = this.layoutPath;
    if (groupId !== null && !node.lightEndpoints.length)
      throw new HttpError(400, "this device has no light or plug endpoints");
    try {
      await this.layout.serial(async () => {
        this.hub.reload(await assignMatterGroup(path, node, groupId));
      });
    } catch (err) {
      this.log.warn("matter group assignment failed", { nodeId, err });
      throw new HttpError(409, "Group could not be saved. Refresh and try again.");
    }
    writeJSON(res, 200, {
      node: { nodeId, groups: this.hub.groupsForMatter(nodeId), groupIds: this.hub.directGroupsForMatter(nodeId) },
    });
  }

  async #matterRemove({ res, params, signal }: RequestContext): Promise<void> {
    const raw = params[0] ?? "";
    const id = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(id)) {
      throw new HttpError(400, "nodeId must be a number");
    }
    await this.#matterCall(() => this.matter.removeNode(id, withTimeout(signal, commandTimeoutMs)));
    this.organization?.removeDevice(`matter:${id}`);
    writeJSON(res, 200, { ok: true });
  }

  async #matterCommission({ req, res, signal }: RequestContext): Promise<void> {
    const body = (await readBody(req)).only("code", "networkOnly");
    const code = body.string("code") ?? "";
    if (code === "") {
      throw new HttpError(400, "code is required");
    }
    const networkOnly = body.bool("networkOnly") ?? false;
    const node = await this.#matterCall(() =>
      this.matter.commission(code, networkOnly, withTimeout(signal, pairingTimeoutMs)),
    );
    writeJSON(res, 200, { node });
  }

  async #matterWiFi({ req, res }: RequestContext): Promise<void> {
    const body = (await readBody(req)).only("ssid", "password");
    const ssid = body.string("ssid") ?? "";
    if (ssid === "") {
      throw new HttpError(400, "ssid is required");
    }
    await this.#matterCall(() => this.matter.setWiFiCredentials(ssid, body.string("password") ?? ""));
    writeJSON(res, 200, { ok: true });
  }

  async #matterThread({ req, res }: RequestContext): Promise<void> {
    const dataset = (await readBody(req)).only("dataset").string("dataset") ?? "";
    if (dataset === "") {
      throw new HttpError(400, "dataset is required");
    }
    await this.#matterCall(() => this.matter.setThreadDataset(dataset));
    writeJSON(res, 200, { ok: true });
  }

  async #matterCall<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.matter.ready) {
      throw new HttpError(503, new MatterNotReadyError().message);
    }
    try {
      return await fn();
    } catch (err) {
      if (err instanceof MatterNotReadyError) throw new HttpError(503, err.message);
      if (err instanceof MatterError) throw new HttpError(502, err.message);
      if (err instanceof DOMException) throw new HttpError(504, err.message);
      throw err;
    }
  }
}

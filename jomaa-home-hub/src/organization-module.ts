// Device organization: types, groups, and assignments.
import type { Hub } from "./hub.js";
import { Fields, JsonShapeError } from "./json.js";
import {
  HttpError,
  readBody,
  requireSameOrigin,
  route,
  writeJSON,
  type FeatureModule,
  type RequestContext,
  type Route,
} from "./http.js";
import type { LayoutChanges } from "./layout-changes.js";
import type { Log } from "./log.js";
import type { MatterAdmin } from "./matter/nodes.js";
import type { HealthStore } from "./health/store.js";
import { OrganizationError, type Organization } from "./organization.js";

export class OrganizationModule implements FeatureModule {
  constructor(
    private readonly hub: Hub,
    private readonly matter: MatterAdmin,
    private readonly layout: LayoutChanges,
    private readonly log: Log,
    private readonly health?: HealthStore,
    private readonly layoutPath?: string,
    private readonly organization?: Organization,
  ) {}

  routes(): Route[] {
    return [
      route("GET", "/api/manage", "manage", (ctx) => this.#manageRead(ctx)),
      route("POST", "/api/manage", "manage", (ctx) => this.#manageWrite(ctx)),
    ];
  }

  #managementDevices() {
    const organization = this.organization;
    const targets = this.hub.list();
    const lights = targets
      .filter((target) => target.kind === "govee")
      .map((target) => ({
        key: `target:${target.id}`,
        name: target.name,
        source: "govee",
        reportedType: "Light",
        capabilities: [
          "Power",
          ...(target.features.brightness ? ["Brightness"] : []),
          ...(target.features.color ? ["Color"] : []),
          ...(target.features.colorTemperature ? ["White temperature"] : []),
        ],
        typeId: organization?.assignedType(`target:${target.id}`)?.id ?? null,
        groupIds: this.hub.directGroupsForTarget(target.id),
      }));
    const nodes = (this.matter.ready ? this.matter.nodes() : []).map((node) => ({
      key: `matter:${node.nodeId}`,
      name: node.label || node.product || `Matter device ${node.nodeId}`,
      source: "matter",
      reportedType: node.type,
      capabilities: node.capabilities,
      typeId: organization?.assignedType(`matter:${node.nodeId}`)?.id ?? null,
      groupIds: node.lightEndpoints.length
        ? this.hub.directGroupsForMatter(node.nodeId)
        : (organization?.groups(`matter:${node.nodeId}`) ?? []),
    }));
    const reporters = (this.health?.list() ?? []).map((device) => ({
      key: `health:${device.id}`,
      name: device.name,
      source: "health",
      reportedType: "Health reporter",
      capabilities: ["Health reporting"],
      typeId: organization?.assignedType(`health:${device.id}`)?.id ?? null,
      groupIds: organization?.groups(`health:${device.id}`) ?? [],
    }));
    return [...lights, ...nodes, ...reporters];
  }

  async #manageRead({ res }: RequestContext): Promise<void> {
    if (!this.organization) throw new HttpError(503, "Management is unavailable");
    writeJSON(res, 200, {
      types: this.organization.types(),
      matterConnected: this.matter.ready,
      groups: this.hub.list().filter((target) => target.kind === "room"),
      devices: this.#managementDevices(),
    });
    return Promise.resolve();
  }

  async #manageWrite({ req, res }: RequestContext): Promise<void> {
    requireSameOrigin(req);
    const organization = this.organization;
    const path = this.layoutPath;
    if (!organization || !path) throw new HttpError(503, "Management is unavailable");
    const fields = await readBody(req);
    await this.layout.serial(() => this.#manageAction(fields, organization, path));
    writeJSON(res, 200, { ok: true });
  }

  async #manageAction(fields: Fields, organization: Organization, path: string): Promise<void> {
    const action = fields.string("action") ?? "";
    try {
      if (action === "type.create") organization.createType(fields.only("action", "name").string("name") ?? "");
      else if (action === "type.rename")
        organization.renameType(fields.only("action", "id", "name").string("id") ?? "", fields.string("name") ?? "");
      else if (action === "type.delete") organization.deleteType(fields.only("action", "id").string("id") ?? "");
      else if (["group.create", "group.rename", "group.delete"].includes(action)) {
        fields.only("action", "id", "name");
        const id = fields.string("id");
        const name = (fields.string("name") ?? "").trim();
        if (action !== "group.delete" && (!name || name.length > 80))
          throw new HttpError(400, "Name must contain 1 to 80 characters");
        await this.layout.apply(path, { action, id, name });
        if (action === "group.delete" && id) organization.removeGroup(id);
      } else if (action === "device.assign") {
        fields.only("action", "key", "typeId", "groupIds").required("key");
        if (!fields.has("typeId") && !fields.has("groupIds"))
          throw new HttpError(400, "No assignment changes supplied");
        const key = fields.string("key") ?? "";
        const device = this.#managementDevices().find((device) => device.key === key);
        if (!device) throw new HttpError(400, "Device not found");
        const typeId = fields.string("typeId");
        if (fields.has("groupIds") && !Array.isArray(fields.value("groupIds")))
          throw new HttpError(400, "groupIds must be a list");
        if (fields.has("typeId") && typeId !== null && !organization.types().some((type) => type.id === typeId))
          throw new HttpError(400, "Type not found");
        const groupIds = fields.list("groupIds").map((value) => {
          if (typeof value !== "string") throw new HttpError(400, "Invalid group");
          return value;
        });
        const available = this.hub
          .list()
          .filter((target) => target.kind === "room")
          .map((group) => group.id);
        if (groupIds.some((id) => !available.includes(id))) throw new HttpError(400, "Group not found");
        const node =
          device.source === "matter" ? this.matter.nodes().find((node) => `matter:${node.nodeId}` === key) : undefined;
        if (fields.has("groupIds") && (device.source === "govee" || node?.lightEndpoints.length)) {
          await this.layout.apply(path, {
            action: "assign",
            nodeId: node?.nodeId ?? null,
            endpoints: node?.lightEndpoints ?? [],
            name: device.name,
            groupIds,
            targetIds: device.source === "govee" ? [key.slice(7)] : [],
          });
        } else if (fields.has("groupIds")) organization.assignGroups(key, groupIds);
        if (fields.has("typeId")) organization.assign(key, typeId);
      } else throw new HttpError(400, "Unknown management action");
    } catch (error) {
      if (error instanceof JsonShapeError || error instanceof HttpError) throw error;
      if (error instanceof OrganizationError) throw new HttpError(400, error.message);
      this.log.error("management update failed", { action, error });
      throw new HttpError(500, "Management update failed. Refresh and try again.");
    }
  }
}

// Builds the hub's API from its services: every feature module, sharing one
// UserService, one owner sign-in limit, and the account-deletion hook.
import type { Accounts } from "./accounts.js";
import { Api } from "./api.js";
import { AuthorizationService } from "./authorization.js";
import type { Clicks } from "./clicks.js";
import { DevicesModule } from "./devices-module.js";
import { HealthHttp } from "./health/http.js";
import type { HealthStore } from "./health/store.js";
import type { Hub } from "./hub.js";
import { LayoutChanges } from "./layout-changes.js";
import { LightsModule } from "./lights-module.js";
import { LoginLimiter } from "./limiter.js";
import type { Log } from "./log.js";
import type { MatterAdmin } from "./matter/nodes.js";
import { AccountOnboarding, TailscaleOnboarding } from "./onboarding.js";
import type { Organization } from "./organization.js";
import { OrganizationModule } from "./organization-module.js";
import { PrefetchModule } from "./prefetch-module.js";
import { SecretsModule, type SecretsAdmin } from "./secrets-module.js";
import type { HealthPageSettings, I2CSettings, PrefetchSettings, TailscaleSettings } from "./settings.js";
import type { TailscaleService } from "./tailscale.js";
import { TailscaleModule } from "./tailscale-module.js";
import { UserService } from "./users.js";
import { UsersModule } from "./users-module.js";
import { pages } from "./web.js";

/** The services behind the hub's API. A null part leaves its feature out or unavailable. */
export interface HubApiParts {
  hub: Hub;
  matter: MatterAdmin;
  /** The hub password, non-empty; the owner exchanges it for a session token at POST /api/login. */
  password: string;
  accounts: Accounts;
  /** Followed-link counts and the prefetch settings behind /api/prefetch and /api/clicks. */
  prefetch: { clicks: Clicks; settings: PrefetchSettings };
  log: Log;
  /** Device health; without it the /api/devices health routes are not served. */
  health: { store: HealthStore; i2c: I2CSettings; page: HealthPageSettings } | null;
  /** The device layout file the device and organization pages edit. */
  layoutPath: string | null;
  organization: Organization | null;
  /** Without it the Secrets routes answer 503. */
  secrets: SecretsAdmin | null;
  /** Without it the Tailscale routes are not served. */
  tailscale: { service: TailscaleService; settings: TailscaleSettings } | null;
}

export function hubApi(parts: HubApiParts): Api {
  const { hub, matter, accounts, log, tailscale } = parts;
  const store = parts.health?.store;
  const layoutPath = parts.layoutPath ?? undefined;
  const organization = parts.organization ?? undefined;
  // An account's link is deleted with it; the sync then removes its access.
  const users = new UserService(accounts, parts.password, () => tailscale?.service.sync());
  const layout = new LayoutChanges(hub, log);
  // Owner sign-ins and Secrets password checks share one failure limit.
  const ownerLimiter = new LoginLimiter();
  const usersModule = new UsersModule(users, new AccountOnboarding(users), ownerLimiter, log);
  const prefetch = new PrefetchModule(
    parts.prefetch.clicks,
    pages,
    new AuthorizationService(),
    parts.prefetch.settings,
  );
  return new Api({
    users,
    publicRoutes: [...usersModule.publicRoutes(), ...prefetch.publicRoutes()],
    modules: [
      usersModule,
      new SecretsModule(users, ownerLimiter, log, parts.secrets ?? undefined),
      new LightsModule(hub, log),
      new DevicesModule(hub, matter, layout, log, layoutPath, organization),
      new OrganizationModule(hub, matter, layout, log, store, layoutPath, organization),
      ...(tailscale
        ? [
            new TailscaleModule(
              accounts,
              tailscale.service,
              new TailscaleOnboarding(accounts, tailscale.service),
              tailscale.settings,
            ),
          ]
        : []),
    ],
    health: parts.health
      ? new HealthHttp(
          parts.health.store,
          parts.health.i2c,
          parts.health.page,
          log.with({ component: "device-health" }),
          matter,
          hub,
          organization,
        )
      : null,
    matter,
    log,
  });
}

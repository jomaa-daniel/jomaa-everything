// Link prefetching: the hub pages a requester can open, most-clicked first, and
// a count of each followed link.
import type { AuthorizationService } from "./authorization.js";
import type { Clicks } from "./clicks.js";
import { HttpError, readBody, requireSameOrigin, route, writeJSON, type RequestContext, type Route } from "./http.js";
import type { PrefetchSettings } from "./settings.js";
import type { Page } from "./web.js";

export class PrefetchModule {
  constructor(
    private readonly clicks: Pick<Clicks, "record" | "counts">,
    private readonly pages: readonly Page[],
    private readonly authorization: AuthorizationService,
    private readonly settings: PrefetchSettings,
  ) {}

  /** Both routes are public: every page offers its sign-in. */
  publicRoutes(): Route[] {
    return [route("GET", "/api/prefetch", null, this.#prefetch), route("POST", "/api/clicks", null, this.#click)];
  }

  /**
   * The pages the requester can open, most-clicked first, with the files each
   * loads and how many prefetches a page runs at once. Signed-out requesters
   * get every page.
   */
  #prefetch = ({ res, principal }: RequestContext): Promise<void> => {
    const counts = this.clicks.counts();
    const open = this.pages
      .filter((page) => principal === null || this.authorization.access(principal, page.access) === "allowed")
      .map((page) => ({ path: page.path, clicks: counts.get(page.path) ?? 0, assets: page.assets }))
      .sort((a, b) => b.clicks - a.clicks);
    writeJSON(res, 200, { concurrency: this.settings.concurrency, pages: open });
    return Promise.resolve();
  };

  /** Counts a followed link to a hub page. */
  #click = async ({ req, res }: RequestContext): Promise<void> => {
    requireSameOrigin(req);
    const path = (await readBody(req)).only("path").required("path").string("path");
    const page = this.pages.find((candidate) => candidate.path === path);
    if (page === undefined) throw new HttpError(404, "unknown page");
    this.clicks.record(page.path);
    writeJSON(res, 200, { ok: true });
  };
}

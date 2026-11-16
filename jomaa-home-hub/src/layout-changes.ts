// Room membership edits, one at a time, from both device organization and Matter pairing.
import { editLayout } from "./group-assignment.js";
import { HttpError } from "./http.js";
import type { Hub } from "./hub.js";
import type { Log } from "./log.js";

export class LayoutChanges {
  #queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly hub: Hub,
    private readonly log: Log,
  ) {}

  /** Applies one layout edit inside an already queued change. */
  async apply(path: string, operation: Record<string, unknown>): Promise<void> {
    try {
      this.hub.reload(await editLayout(path, operation));
    } catch (error) {
      this.log.warn("layout update failed", { operation: operation["action"], error });
      throw new HttpError(409, "Group changes could not be saved. Refresh and try again.");
    }
  }

  /** Queues work that may apply several layout edits. */
  async serial(work: () => Promise<void>): Promise<void> {
    const next = this.#queue.then(work);
    this.#queue = next.catch(() => {});
    await next;
  }
}

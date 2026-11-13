// Every access decision the API makes, in one place.
import { refusal, type Access, type Scope } from "./accounts.js";
import { HttpError } from "./http.js";
import type { Principal } from "./principal.js";

/**
 * What a route needs: a page's scope, the owner, any signed-in caller
 * ("session"), or nothing (null, a public route).
 */
export type Requirement = Scope | "owner" | "session" | null;

const ownerRefusal = "Only the hub owner can do this.";

export class AuthorizationService {
  /** Signed out (401), signed in without the requirement (403), or allowed. */
  access(principal: Principal | null, requires: Requirement): Access {
    if (requires === null) return "allowed";
    if (principal === null) return "signed-out";
    if (requires === "session" || principal.owner) return "allowed";
    return requires !== "owner" && principal.has(requires) ? "allowed" : "forbidden";
  }

  /** Throws a 401 or 403 unless the principal meets the requirement. */
  require(principal: Principal | null, requires: Requirement): void {
    const result = this.access(principal, requires);
    if (result === "allowed") return;
    if (result === "signed-out") throw new HttpError(401, "sign in first");
    throw new HttpError(
      403,
      requires === "owner" || requires === "session" || requires === null ? ownerRefusal : refusal(requires),
    );
  }
}

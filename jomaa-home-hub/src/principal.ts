// Who sent a request: the owner signed in with the hub password, or an invited account.
import type { Account, Scope } from "./accounts.js";

/** An authenticated caller. Device credentials never produce one. */
export abstract class Principal {
  /** Stable name of the caller, for logs and ownership checks. */
  abstract readonly subject: string;
  /** Whether the caller is the hub owner. */
  abstract readonly owner: boolean;
  /** Whether the caller may use a page's scope. */
  abstract has(scope: Scope): boolean;
}

/** The hub owner. It has no account row; the hub password identifies it. */
export class OwnerPrincipal extends Principal {
  readonly subject = "owner";
  readonly owner = true;

  has(): boolean {
    return true;
  }
}

/** An invited account, with the scopes stored for it when the request arrived. */
export class MemberPrincipal extends Principal {
  readonly owner = false;
  readonly subject: string;

  constructor(readonly account: Account) {
    super();
    this.subject = `account:${account.username}`;
  }

  has(scope: Scope): boolean {
    return this.account.scopes.includes(scope);
  }
}

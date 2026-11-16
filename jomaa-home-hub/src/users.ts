// Accounts and sign-in: resolves the caller of a request and keeps account
// changes with the module records that must change with them.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Account, Accounts } from "./accounts.js";
import { MemberPrincipal, OwnerPrincipal, type Principal } from "./principal.js";

export const authCookie = "hub_auth";

/**
 * The owner's session token is derived from the password, so the password
 * itself is never stored in a cookie and changing it signs everyone out.
 */
export function sessionToken(password: string): string {
  return createHmac("sha256", password).update("jomaa-home-hub session v1").digest("hex");
}

export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** The bearer token, or the session cookie. */
export function requestToken(req: IncomingMessage): string {
  const header = req.headers.authorization ?? "";
  if (header.startsWith("Bearer ")) return header.slice("Bearer ".length);
  let token = "";
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === authCookie) token = part.slice(i + 1).trim();
  }
  return token;
}

export class UserService {
  readonly #ownerToken: string;

  /** deleted runs after an account is deleted. */
  constructor(
    readonly accounts: Accounts,
    password: string,
    private readonly deleted: (username: string) => void = () => {},
  ) {
    this.#ownerToken = sessionToken(password);
  }

  /** The caller a request's token identifies, read with the account's current scopes. */
  resolve(req: IncomingMessage): Principal | null {
    const token = requestToken(req);
    if (token === "") return null;
    if (this.isOwnerToken(token)) return new OwnerPrincipal();
    const account = this.accounts.session(token);
    return account ? new MemberPrincipal(account) : null;
  }

  isOwnerToken(token: string): boolean {
    return sameSecret(token, this.#ownerToken);
  }

  /** The owner's session token when the hub password matches. */
  ownerSignIn(password: string): string | null {
    return sameSecret(sessionToken(password), this.#ownerToken) ? this.#ownerToken : null;
  }

  /** A new session token when the account's username and password match. */
  async accountSignIn(username: string, password: string): Promise<string | null> {
    const account = await this.accounts.verify(username, password);
    return account ? this.accounts.createSession(account.username) : null;
  }

  /** Ends the request's account session; the owner's token has no stored session. */
  endSession(req: IncomingMessage): void {
    const token = requestToken(req);
    if (token !== "" && !this.isOwnerToken(token)) this.accounts.endSession(token);
  }

  /** Creates an account from an invite; validation and consumption are one transaction. */
  join(token: string, username: string, password: string): Promise<Account> {
    return this.accounts.join(token, username, password);
  }

  deleteAccount(username: string): void {
    this.accounts.deleteAccount(username);
    this.deleted(username.trim().toLowerCase());
  }
}

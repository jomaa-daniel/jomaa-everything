// Sign-in, invites, and account management.
import type { IncomingMessage, ServerResponse } from "node:http";
import { isScope, passwordLength, scopes, sessionLifetimeMs } from "./accounts.js";
import { clientIP, isHTTPS, LoginLimiter } from "./limiter.js";
import type { Log } from "./log.js";
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
import { authCookie, type UserService } from "./users.js";
import type { AccountOnboarding } from "./onboarding.js";
import { MemberPrincipal } from "./principal.js";

export class UsersModule implements FeatureModule {
  /** Counts failed account sign-ins; owner sign-ins count on ownerLimiter, which the Secrets page shares. */
  readonly #accountLimiter = new LoginLimiter();

  constructor(
    private readonly users: UserService,
    private readonly onboarding: AccountOnboarding,
    private readonly ownerLimiter: LoginLimiter,
    private readonly log: Log,
  ) {}

  /** Routes that need no session. */
  publicRoutes(): Route[] {
    return [
      route("POST", "/api/login", null, (ctx) => this.#login(ctx)),
      route("POST", "/api/logout", null, (ctx) => this.#logout(ctx)),
      route("POST", "/api/invites/check", null, (ctx) => this.#inviteCheck(ctx)),
      route("POST", "/api/join", null, (ctx) => this.#join(ctx)),
    ];
  }

  routes(): Route[] {
    return [
      route("GET", "/api/session", "session", (ctx) => this.#session(ctx)),
      route("GET", "/api/invites", "owner", (ctx) => this.#inviteList(ctx)),
      route("POST", "/api/invites", "owner", (ctx) => this.#inviteCreate(ctx)),
      route("DELETE", "/api/invites/{id}", "owner", (ctx) => this.#inviteRevoke(ctx)),
      route("GET", "/api/accounts", "owner", (ctx) => this.#accountList(ctx)),
      route("PUT", "/api/accounts/{username}/scopes", "owner", (ctx) => this.#accountScopes(ctx)),
      route("DELETE", "/api/accounts/{username}", "owner", (ctx) => this.#accountDelete(ctx)),
    ];
  }

  /**
   * Without a username the password is the hub password; with one it is that
   * account's password. A previous account session on the request ends.
   */
  async #login({ req, res }: RequestContext): Promise<void> {
    requireSameOrigin(req);
    const body = (await readBody(req)).only("username", "password");
    const username = body.string("username");
    const password = body.string("password") ?? "";
    const client = clientIP(req);
    const limiter = username === null ? this.ownerLimiter : this.#accountLimiter;
    const { ok, waitMs } = limiter.allow(client);
    if (!ok) {
      res.setHeader("Retry-After", String(Math.trunc(waitMs / 1000) + 1));
      throw new HttpError(429, "too many failed sign-ins; try again later");
    }
    const token =
      username === null ? this.users.ownerSignIn(password) : await this.users.accountSignIn(username, password);
    if (token === null) {
      limiter.fail(client);
      this.log.warn("failed sign-in", { client, account: username !== null });
      throw new HttpError(401, username === null ? "wrong password" : "wrong username or password");
    }
    limiter.succeed(client);
    this.users.endSession(req);
    signIn(req, res, token);
    writeJSON(res, 200, { token });
  }

  async #logout({ req, res }: RequestContext): Promise<void> {
    requireSameOrigin(req);
    this.users.endSession(req);
    res.setHeader("Set-Cookie", cookie("", 0, isHTTPS(req)));
    writeJSON(res, 200, { ok: true });
    return Promise.resolve();
  }

  async #session({ res, principal }: RequestContext): Promise<void> {
    if (principal === null) throw new HttpError(401, "sign in first");
    writeJSON(
      res,
      200,
      principal instanceof MemberPrincipal
        ? { owner: false, username: principal.account.username, scopes: principal.account.scopes }
        : { owner: true, username: null, scopes: scopes.map((scope) => scope.id) },
    );
    return Promise.resolve();
  }

  async #inviteCheck({ req, res }: RequestContext): Promise<void> {
    const token = (await readBody(req)).only("token").string("token") ?? "";
    writeJSON(res, 200, { expiresAt: this.users.accounts.checkInvite(token).expiresAt, passwordLength });
  }

  /** Creates an account from an invite; the caller's session is unchanged. */
  async #join({ req, res }: RequestContext): Promise<void> {
    requireSameOrigin(req);
    const body = (await readBody(req)).only("token", "username", "password");
    const account = await this.onboarding.advance(body.string("username") ?? "", {
      type: "join",
      token: body.string("token") ?? "",
      password: body.string("password") ?? "",
    });
    if (account === null) throw new HttpError(500, "account was not created");
    this.log.info("account created", { username: account.username });
    writeJSON(res, 201, { account });
  }

  async #inviteList({ res }: RequestContext): Promise<void> {
    writeJSON(res, 200, { invites: this.users.accounts.invites() });
    return Promise.resolve();
  }

  /** Returns the invite's token once; the page turns it into a share link. */
  async #inviteCreate({ req, res }: RequestContext): Promise<void> {
    requireSameOrigin(req);
    (await readBody(req)).only();
    writeJSON(res, 201, this.users.accounts.createInvite());
  }

  async #inviteRevoke({ req, res, params }: RequestContext): Promise<void> {
    requireSameOrigin(req);
    this.users.accounts.revokeInvite(params[0] ?? "");
    writeJSON(res, 200, { ok: true });
    return Promise.resolve();
  }

  async #accountList({ res }: RequestContext): Promise<void> {
    writeJSON(res, 200, { accounts: this.users.accounts.accounts(), scopes });
    return Promise.resolve();
  }

  async #accountScopes({ req, res, params }: RequestContext): Promise<void> {
    requireSameOrigin(req);
    const body = (await readBody(req)).only("scopes").required("scopes");
    if (!Array.isArray(body.value("scopes"))) throw new HttpError(400, "scopes must be a list");
    const granted = body.list("scopes").map((value) => {
      if (!isScope(value)) throw new HttpError(400, `unknown scope ${JSON.stringify(value)}`);
      return value;
    });
    const account = await this.onboarding.advance((params[0] ?? "").trim().toLowerCase(), {
      type: "set-scopes",
      scopes: granted,
    });
    if (account === null) throw new HttpError(404, "Account not found");
    this.log.info("account scopes changed", { username: account.username, scopes: account.scopes });
    writeJSON(res, 200, { account });
  }

  async #accountDelete({ req, res, params }: RequestContext): Promise<void> {
    requireSameOrigin(req);
    const username = params[0] ?? "";
    await this.onboarding.advance(username.trim().toLowerCase(), { type: "delete" });
    this.log.info("account deleted", { username });
    writeJSON(res, 200, { ok: true });
  }
}

/**
 * Sets the session cookie. It is Secure only over HTTPS (directly or through
 * the tunnel): on the home network the hub is often plain HTTP, and a Secure
 * cookie would never be sent back.
 */
function signIn(req: IncomingMessage, res: ServerResponse, token: string): void {
  res.setHeader("Set-Cookie", cookie(token, sessionLifetimeMs / 1000, isHTTPS(req)));
}

function cookie(value: string, maxAge: number, secure: boolean): string {
  return `${authCookie}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

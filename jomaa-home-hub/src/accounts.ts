import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { settings } from "./settings.js";

/** The pages an account can be granted, by scope ID. */
export const scopes = [
  { id: "lights", name: "Lights", description: "Control rooms at /lights." },
  {
    id: "devices",
    name: "Device health",
    description: "View health reports, pair Matter devices, and issue device credentials at /devices.",
  },
  { id: "manage", name: "Device organization", description: "Edit types, groups, and assignments at /manage." },
] as const;

export type Scope = (typeof scopes)[number]["id"];

export function isScope(value: unknown): value is Scope {
  return scopes.some((scope) => scope.id === value);
}

/** The 403 message for an account without a scope. */
export function refusal(scope: Scope): string {
  const name = scopes.find((candidate) => candidate.id === scope)?.name ?? scope;
  return `Your account does not have access to ${name}. Ask the hub owner to grant it.`;
}

/** Whether a request may use a scope: signed out (401), signed in without the scope (403), or allowed. */
export type Access = "signed-out" | "forbidden" | "allowed";

export class AccountError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface Account {
  username: string;
  scopes: Scope[];
  createdAt: number;
}

export interface Invite {
  id: string;
  createdAt: number;
  expiresAt: number;
}

const dayMs = 24 * 60 * 60_000;
export const sessionLifetimeMs = settings.accounts.sessionLifetimeDays * dayMs;
export const inviteLifetimeMs = settings.accounts.inviteLifetimeDays * dayMs;
export const passwordLength = settings.accounts.passwordLength;
const keyLength = 64;
const usernamePattern = /^[a-z0-9][a-z0-9._-]{2,31}$/;

function hashScrypt(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  return `${salt.toString("hex")}:${(await hashScrypt(password, salt)).toString("hex")}`;
}

async function passwordMatches(password: string, stored: string): Promise<boolean> {
  const [salt = "", hash = ""] = stored.split(":");
  const expected = Buffer.from(hash, "hex");
  const actual = await hashScrypt(password, Buffer.from(salt, "hex"));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function newToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Verifies unknown usernames against this so a miss takes as long as a wrong password. */
const absentHash = `${"00".repeat(16)}:${"00".repeat(keyLength)}`;

/** Accounts created from invite links, their granted scopes, and their sign-in sessions. */
export class Accounts {
  readonly #db: DatabaseSync;
  now: () => number = Date.now;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const mask = process.umask(0o077);
    try {
      this.#db = new DatabaseSync(path);
    } finally {
      process.umask(mask);
    }
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.#db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS accounts (username TEXT PRIMARY KEY, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS account_scopes (username TEXT NOT NULL REFERENCES accounts(username) ON DELETE CASCADE, scope TEXT NOT NULL, PRIMARY KEY(username, scope));
      CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, username TEXT NOT NULL REFERENCES accounts(username) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS invites (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);`);
  }

  /** Creates a single-use invite. The token is returned once and only its hash is stored. */
  createInvite(): { invite: Invite; token: string } {
    const token = newToken();
    const now = this.now();
    const invite = { id: randomBytes(8).toString("hex"), createdAt: now, expiresAt: now + inviteLifetimeMs };
    this.#db
      .prepare("INSERT INTO invites VALUES (?, ?, ?, ?)")
      .run(invite.id, digest(token), invite.createdAt, invite.expiresAt);
    return { invite, token };
  }

  /** Unused, unexpired invites, newest first. */
  invites(): Invite[] {
    return this.#db
      .prepare("SELECT id, created_at, expires_at FROM invites WHERE expires_at > ? ORDER BY created_at DESC")
      .all(this.now())
      .map((row) => ({
        id: String(row["id"]),
        createdAt: Number(row["created_at"]),
        expiresAt: Number(row["expires_at"]),
      }));
  }

  revokeInvite(id: string): void {
    if (this.#db.prepare("DELETE FROM invites WHERE id=?").run(id).changes === 0)
      throw new AccountError(404, "Invite not found");
  }

  /** The invite a token opens; throws when it is unknown, used, or expired. */
  checkInvite(token: string): Invite {
    const row = this.#db
      .prepare("SELECT id, created_at, expires_at FROM invites WHERE token_hash=? AND expires_at > ?")
      .get(digest(token), this.now());
    if (!row) throw new AccountError(404, "This invite link is invalid, used, or expired");
    return { id: String(row["id"]), createdAt: Number(row["created_at"]), expiresAt: Number(row["expires_at"]) };
  }

  /** Creates an account with no scopes and consumes the invite. */
  async join(token: string, username: string, password: string): Promise<Account> {
    this.checkInvite(token);
    const name = validUsername(username);
    validPassword(password);
    const hash = await hashPassword(password);
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const invite = this.checkInvite(token);
      if (this.#db.prepare("SELECT 1 FROM accounts WHERE username=?").get(name))
        throw new AccountError(409, "That username is taken");
      const createdAt = this.now();
      this.#db.prepare("INSERT INTO accounts VALUES (?, ?, ?)").run(name, hash, createdAt);
      this.#db.prepare("DELETE FROM invites WHERE id=?").run(invite.id);
      this.#db.exec("COMMIT");
      return { username: name, scopes: [], createdAt };
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  /** The account when the username and password match, otherwise null. */
  async verify(username: string, password: string): Promise<Account | null> {
    const name = username.trim().toLowerCase();
    const row = this.#db.prepare("SELECT password_hash FROM accounts WHERE username=?").get(name);
    const matches = await passwordMatches(password, row ? String(row["password_hash"]) : absentHash);
    return row && matches ? this.account(name) : null;
  }

  account(username: string): Account | null {
    const row = this.#db.prepare("SELECT username, created_at FROM accounts WHERE username=?").get(username);
    if (!row) return null;
    return { username: String(row["username"]), scopes: this.#scopes(username), createdAt: Number(row["created_at"]) };
  }

  accounts(): Account[] {
    return this.#db
      .prepare("SELECT username FROM accounts ORDER BY username")
      .all()
      .map((row) => this.account(String(row["username"])))
      .filter((account) => account !== null);
  }

  setScopes(username: string, granted: Scope[]): Account {
    username = username.trim().toLowerCase();
    const account = this.account(username);
    if (!account) throw new AccountError(404, "Account not found");
    this.#db.exec("BEGIN");
    try {
      this.#db.prepare("DELETE FROM account_scopes WHERE username=?").run(username);
      for (const scope of new Set(granted))
        this.#db.prepare("INSERT INTO account_scopes VALUES (?, ?)").run(username, scope);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    return { ...account, scopes: this.#scopes(username) };
  }

  /** Deletes the account, its scopes, and its sessions. */
  deleteAccount(username: string): void {
    if (this.#db.prepare("DELETE FROM accounts WHERE username=?").run(username.trim().toLowerCase()).changes === 0)
      throw new AccountError(404, "Account not found");
  }

  /**
   * Starts a session and returns its token; only the token's hash is stored.
   * An account keeps its newest accounts.sessionsPerAccount sessions.
   */
  createSession(username: string): string {
    const token = newToken();
    this.#db
      .prepare("INSERT INTO sessions VALUES (?, ?, ?)")
      .run(digest(token), username, this.now() + sessionLifetimeMs);
    this.#db
      .prepare(
        `DELETE FROM sessions WHERE username=? AND token_hash NOT IN
          (SELECT token_hash FROM sessions WHERE username=? ORDER BY expires_at DESC, rowid DESC LIMIT ?)`,
      )
      .run(username, username, settings.accounts.sessionsPerAccount);
    return token;
  }

  /** The account a session token belongs to, or null when it is unknown or expired. */
  session(token: string): Account | null {
    const row = this.#db
      .prepare("SELECT username FROM sessions WHERE token_hash=? AND expires_at > ?")
      .get(digest(token), this.now());
    return row ? this.account(String(row["username"])) : null;
  }

  endSession(token: string): void {
    this.#db.prepare("DELETE FROM sessions WHERE token_hash=?").run(digest(token));
  }

  /** Removes expired sessions and invites. */
  prune(): void {
    const now = this.now();
    this.#db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
    this.#db.prepare("DELETE FROM invites WHERE expires_at <= ?").run(now);
  }

  #scopes(username: string): Scope[] {
    const granted = new Set(
      this.#db
        .prepare("SELECT scope FROM account_scopes WHERE username=?")
        .all(username)
        .map((row) => row["scope"]),
    );
    return scopes.map((scope) => scope.id).filter((id) => granted.has(id));
  }

  close(): void {
    this.#db.close();
  }
}

function validUsername(value: string): string {
  const name = value.trim().toLowerCase();
  if (!usernamePattern.test(name))
    throw new AccountError(
      400,
      "Username must be 3 to 32 characters: letters, digits, dots, dashes, or underscores, starting with a letter or digit",
    );
  return name;
}

function validPassword(value: string): void {
  if (value.length < passwordLength.min || value.length > passwordLength.max)
    throw new AccountError(400, `Password must contain ${passwordLength.min} to ${passwordLength.max} characters`);
}

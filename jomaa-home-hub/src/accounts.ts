import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { settings } from "./settings.js";

/** The pages an account can be granted, by scope ID. */
export const scopes = [
  { id: "lights", name: "Lights", description: "Control rooms at /lights." },
  {
    id: "devices",
    name: "Device health",
    description: "View device details, logs, and pairing at /manage.",
  },
  { id: "manage", name: "Device organization", description: "Edit types, groups, and assignments at /manage." },
  { id: "cameras", name: "Cameras", description: "View live video, activity, snapshots, and recordings at /cameras." },
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

export interface Grant {
  node: string;
  scopes: Scope[];
}

export interface Account {
  username: string;
  grants: Grant[];
  createdAt: number;
}

export interface Invite {
  grants: Grant[];
  id: string;
  createdAt: number;
  expiresAt: number;
  status: "pending" | "expired" | "used" | "revoked";
  account: Pick<Account, "username" | "createdAt"> | null;
  revokedAt: number | null;
}

export interface InviteActivity {
  days: { date: string; count: number }[];
  total: number;
  lastAccessAt: number | null;
  chartDays: number;
}

const inviteSelect = `SELECT invites.id, invites.created_at, invites.expires_at,
  invite_outcomes.username, invite_outcomes.joined_at, invite_outcomes.revoked_at
  FROM invites LEFT JOIN invite_outcomes ON invites.id=invite_outcomes.id`;

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
      CREATE TABLE IF NOT EXISTS account_grants (username TEXT NOT NULL REFERENCES accounts(username) ON DELETE CASCADE, node TEXT NOT NULL, scope TEXT NOT NULL, PRIMARY KEY(username, node, scope));
      CREATE TABLE IF NOT EXISTS invite_grants (id TEXT NOT NULL REFERENCES invites(id) ON DELETE CASCADE, node TEXT NOT NULL, scope TEXT NOT NULL, PRIMARY KEY(id, node, scope));
      CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, username TEXT NOT NULL REFERENCES accounts(username) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS invites (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS invite_outcomes (id TEXT PRIMARY KEY REFERENCES invites(id) ON DELETE CASCADE, username TEXT, joined_at INTEGER, revoked_at INTEGER);
      CREATE TABLE IF NOT EXISTS invite_access (id TEXT NOT NULL REFERENCES invites(id) ON DELETE CASCADE, day TEXT NOT NULL, count INTEGER NOT NULL, last_access_at INTEGER NOT NULL, PRIMARY KEY(id, day));`);
  }

  /** Creates a single-use invite. The token is returned once and only its hash is stored. */
  createInvite(grants: Grant[] = []): { invite: Invite; token: string } {
    const token = newToken();
    const now = this.now();
    const invite = { grants, id: randomBytes(8).toString("hex"), createdAt: now, expiresAt: now + inviteLifetimeMs };
    this.#db
      .prepare("INSERT INTO invites VALUES (?, ?, ?, ?)")
      .run(invite.id, digest(token), invite.createdAt, invite.expiresAt);
    for (const grant of grants)
      for (const scope of new Set(grant.scopes))
        this.#db.prepare("INSERT INTO invite_grants VALUES (?, ?, ?)").run(invite.id, grant.node, scope);
    return { invite: this.invite(invite.id), token };
  }

  /** All invite links, including used, expired, and revoked links, newest first. */
  invites(): Invite[] {
    return this.#db
      .prepare(inviteSelect + " ORDER BY invites.created_at DESC, invites.rowid DESC")
      .all()
      .map((row) => this.#invite(row));
  }

  invite(id: string): Invite {
    const row = this.#db.prepare(inviteSelect + " WHERE invites.id=?").get(id);
    if (!row) throw new AccountError(404, "Invite not found");
    return this.#invite(row);
  }

  /** Daily UTC link opens in the configured chart window, with lifetime totals. */
  inviteActivity(id: string): InviteActivity {
    const invite = this.invite(id);
    const today = Math.floor(this.now() / dayMs) * dayMs;
    const start = Math.max(
      Math.floor(invite.createdAt / dayMs) * dayMs,
      today - (settings.accounts.inviteChartDays - 1) * dayMs,
    );
    const counts = this.#db
      .prepare("SELECT day, count FROM invite_access WHERE id=? AND day>=? ORDER BY day")
      .all(id, new Date(start).toISOString().slice(0, 10));
    const days = [];
    for (let at = start; at <= today; at += dayMs) {
      const date = new Date(at).toISOString().slice(0, 10);
      days.push({ date, count: Number(counts.find((row) => row["day"] === date)?.["count"] ?? 0) });
    }
    const totals = this.#db
      .prepare("SELECT COALESCE(SUM(count), 0) AS total, MAX(last_access_at) AS last FROM invite_access WHERE id=?")
      .get(id);
    return {
      days,
      total: Number(totals?.["total"] ?? 0),
      lastAccessAt: totals?.["last"] == null ? null : Number(totals["last"]),
      chartDays: settings.accounts.inviteChartDays,
    };
  }

  setInviteExpiration(id: string, expiresAt: number): Invite {
    const invite = this.invite(id);
    if (invite.status === "used" || invite.status === "revoked")
      throw new AccountError(409, "Used or revoked links cannot change expiration");
    if (
      !Number.isSafeInteger(expiresAt) ||
      Number.isNaN(new Date(expiresAt).getTime()) ||
      expiresAt <= invite.createdAt
    )
      throw new AccountError(400, "Expiration must be a valid date after the link was created");
    this.#db.prepare("UPDATE invites SET expires_at=? WHERE id=?").run(expiresAt, id);
    return this.invite(id);
  }

  /** Sets the access an unused link grants to the account it creates. */
  setInviteGrants(id: string, grants: Grant[]): Invite {
    const invite = this.invite(id);
    if (invite.status === "used" || invite.status === "revoked")
      throw new AccountError(409, "Used or revoked links cannot change access");
    this.#db.exec("BEGIN");
    try {
      this.#db.prepare("DELETE FROM invite_grants WHERE id=?").run(id);
      for (const grant of grants)
        for (const scope of new Set(grant.scopes))
          this.#db.prepare("INSERT INTO invite_grants VALUES (?, ?, ?)").run(id, grant.node, scope);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    return this.invite(id);
  }

  revokeInvite(id: string): void {
    const invite = this.invite(id);
    if (invite.status === "used") throw new AccountError(409, "This link has already created an account");
    this.#db
      .prepare("INSERT INTO invite_outcomes (id, revoked_at) VALUES (?, ?) ON CONFLICT(id) DO NOTHING")
      .run(id, this.now());
  }

  /** Counts a known link opening, including openings after it becomes unusable. */
  openInvite(token: string): Invite {
    const row = this.#db.prepare("SELECT id FROM invites WHERE token_hash=?").get(digest(token));
    if (row) {
      const now = this.now();
      this.#db
        .prepare(
          `INSERT INTO invite_access VALUES (?, ?, 1, ?)
        ON CONFLICT(id, day) DO UPDATE SET count=count+1, last_access_at=excluded.last_access_at`,
        )
        .run(String(row["id"]), new Date(now).toISOString().slice(0, 10), now);
    }
    return this.checkInvite(token);
  }

  /** The invite a token opens; throws when it is unknown, used, or expired. */
  checkInvite(token: string): Invite {
    const row = this.#db.prepare(inviteSelect + " WHERE invites.token_hash=?").get(digest(token));
    const invite = row ? this.#invite(row) : null;
    if (!invite || invite.status !== "pending")
      throw new AccountError(404, "This invite link is invalid, used, or expired");
    return invite;
  }

  /** Creates an account with the invite grants and consumes the invite. */
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
      for (const grant of invite.grants)
        for (const scope of grant.scopes)
          this.#db.prepare("INSERT INTO account_grants VALUES (?, ?, ?)").run(name, grant.node, scope);
      this.#db
        .prepare("INSERT INTO invite_outcomes (id, username, joined_at) VALUES (?, ?, ?)")
        .run(invite.id, name, createdAt);
      this.#db.exec("COMMIT");
      return { username: name, grants: invite.grants, createdAt };
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
    return {
      username: String(row["username"]),
      grants: this.#grants("account_grants", "username", username),
      createdAt: Number(row["created_at"]),
    };
  }

  accounts(): Account[] {
    return this.#db
      .prepare("SELECT username FROM accounts ORDER BY username")
      .all()
      .map((row) => this.account(String(row["username"])))
      .filter((account) => account !== null);
  }

  setGrants(username: string, granted: Grant[]): Account {
    username = username.trim().toLowerCase();
    const account = this.account(username);
    if (!account) throw new AccountError(404, "Account not found");
    this.#db.exec("BEGIN");
    try {
      this.#db.prepare("DELETE FROM account_grants WHERE username=?").run(username);
      for (const grant of granted)
        for (const scope of new Set(grant.scopes))
          this.#db.prepare("INSERT INTO account_grants VALUES (?, ?, ?)").run(username, grant.node, scope);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    return { ...account, grants: this.#grants("account_grants", "username", username) };
  }

  /** Deletes the account, its grants, and its sessions. */
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

  /** Removes expired sessions. Invite history remains available for inspection. */
  prune(): void {
    const now = this.now();
    this.#db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
  }

  #invite(row: Record<string, SQLOutputValue>): Invite {
    const account =
      row["username"] == null ? null : { username: String(row["username"]), createdAt: Number(row["joined_at"]) };
    const revokedAt = row["revoked_at"] == null ? null : Number(row["revoked_at"]);
    const expiresAt = Number(row["expires_at"]);
    return {
      grants: this.#grants("invite_grants", "id", String(row["id"])),
      id: String(row["id"]),
      createdAt: Number(row["created_at"]),
      expiresAt,
      account,
      revokedAt,
      status: account ? "used" : revokedAt !== null ? "revoked" : expiresAt <= this.now() ? "expired" : "pending",
    };
  }

  #grants(table: "account_grants" | "invite_grants", field: "username" | "id", id: string): Grant[] {
    const rows = this.#db.prepare(`SELECT node, scope FROM ${table} WHERE ${field}=? ORDER BY node`).all(id);
    const nodes = [...new Set(rows.map((row) => String(row["node"])))];
    return nodes.map((node) => ({
      node,
      scopes: scopes
        .map((scope) => scope.id)
        .filter((scope) => rows.some((row) => row["node"] === node && row["scope"] === scope)),
    }));
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

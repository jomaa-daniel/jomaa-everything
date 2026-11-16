// Which account is linked to which Tailscale user, which have exit-node
// access, and the last sync's result. The tables are defined in
// jomaa-tailscale/access.sql, which the sync reads.
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

/** A refused change; status is the HTTP status the API answers with. */
export class TailscaleError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** A Tailscale user confirmed from the provider's own records. */
export interface Identity {
  providerUserId: string;
  login: string;
  displayName: string;
}

export interface Link extends Identity {
  username: string;
  access: boolean;
  linkedAt: number;
}

export interface SyncState {
  enabledAt: number | null;
  syncedAt: number | null;
  error: string | null;
  /** group:family as last read back from Tailscale, or null before the first read. */
  family: string[] | null;
  familyReadAt: number | null;
}

type Row = Record<string, SQLInputValue>;

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return value.toString();
  throw new Error(`column ${key} is not text`);
}

function optionalNumber(row: Row, key: string): number | null {
  return row[key] === null ? null : Number(row[key]);
}

function link(row: Row): Link {
  return {
    username: text(row, "username"),
    providerUserId: text(row, "provider_user_id"),
    login: text(row, "login"),
    displayName: text(row, "display_name"),
    access: Number(row["access"]) === 1,
    linkedAt: Number(row["linked_at"]),
  };
}

function family(value: SQLInputValue | undefined): string[] | null {
  if (typeof value !== "string") return null;
  const parsed: unknown = JSON.parse(value);
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : null;
}

export class TailscaleStore {
  constructor(
    private readonly db: DatabaseSync,
    schema: string,
    private readonly now: () => number,
  ) {
    db.exec(schema);
  }

  links(): Link[] {
    return this.db
      .prepare("SELECT * FROM tailscale_links ORDER BY username")
      .all()
      .map((row) => link(row));
  }

  linkOf(username: string): Link | null {
    const row = this.db.prepare("SELECT * FROM tailscale_links WHERE username=?").get(username);
    return row ? link(row) : null;
  }

  /** Links an account to a Tailscale user without access. Linking the same user again refreshes its login and name. */
  link(username: string, identity: Identity): Link {
    const current = this.linkOf(username);
    if (current !== null && current.providerUserId !== identity.providerUserId)
      throw new TailscaleError(409, `${username} is already linked to ${current.login}. Unlink it first.`);
    const owner = this.db
      .prepare("SELECT username FROM tailscale_links WHERE provider_user_id=? AND username<>?")
      .get(identity.providerUserId, username);
    if (owner) throw new TailscaleError(409, `${identity.login} is already linked to ${text(owner, "username")}.`);
    try {
      this.db
        .prepare(
          `INSERT INTO tailscale_links (username, provider_user_id, login, display_name, linked_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (username) DO UPDATE SET login=excluded.login, display_name=excluded.display_name`,
        )
        .run(username, identity.providerUserId, identity.login, identity.displayName, this.now());
    } catch (error) {
      if (error instanceof Error && /FOREIGN KEY constraint failed/.test(error.message))
        throw new TailscaleError(404, "Account not found");
      if (error instanceof Error && /UNIQUE constraint failed/.test(error.message))
        throw new TailscaleError(409, `${identity.login} was just linked to another account. Refresh and try again.`);
      throw error;
    }
    return this.#get(username);
  }

  /** Removes an account's link; whether anything was linked. */
  unlink(username: string): boolean {
    return this.db.prepare("DELETE FROM tailscale_links WHERE username=?").run(username).changes > 0;
  }

  setAccess(username: string, access: boolean): Link {
    if (
      this.db.prepare("UPDATE tailscale_links SET access=? WHERE username=?").run(access ? 1 : 0, username).changes ===
      0
    )
      throw new TailscaleError(409, `Link ${username} to a Tailscale user first.`);
    return this.#get(username);
  }

  /** Turns on managed access: from now on syncs write group:family from the links. */
  enable(): void {
    this.db.prepare("UPDATE tailscale_sync SET enabled_at=COALESCE(enabled_at, ?) WHERE id=1").run(this.now());
  }

  state(): SyncState {
    const row = this.db.prepare("SELECT * FROM tailscale_sync WHERE id=1").get() as Row;
    return {
      enabledAt: optionalNumber(row, "enabled_at"),
      syncedAt: optionalNumber(row, "synced_at"),
      error: row["error"] === null ? null : text(row, "error"),
      family: family(row["family"]),
      familyReadAt: optionalNumber(row, "family_read_at"),
    };
  }

  #get(username: string): Link {
    const found = this.linkOf(username);
    if (found === null) throw new Error(`link for ${username} vanished`);
    return found;
  }
}

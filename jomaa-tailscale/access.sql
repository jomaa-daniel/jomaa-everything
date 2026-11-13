-- Exit-node access, stored in the hub's account database. The hub creates
-- these tables at startup and writes links and access; access.py reads them
-- to sync the tailnet policy and records each sync's result.

-- One row per account linked to a Tailscale user. Deleting the account
-- deletes its link, and the next sync removes its access.
CREATE TABLE IF NOT EXISTS tailscale_links (
  username TEXT PRIMARY KEY REFERENCES accounts (username) ON DELETE CASCADE,
  provider_user_id TEXT NOT NULL UNIQUE,
  -- The login the policy lists, from the provider's user record.
  login TEXT NOT NULL,
  display_name TEXT NOT NULL,
  access INTEGER NOT NULL DEFAULT 0 CHECK (access IN (0, 1)),
  linked_at INTEGER NOT NULL
);

-- One row: whether syncing is on, and the last sync's result.
CREATE TABLE IF NOT EXISTS tailscale_sync (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  -- When the owner turned on managed access; syncs write nothing before.
  enabled_at INTEGER,
  synced_at INTEGER,
  error TEXT,
  -- group:family as read back from Tailscale, as a JSON list, and when.
  family TEXT,
  family_read_at INTEGER
);
INSERT OR IGNORE INTO tailscale_sync (id) VALUES (1);

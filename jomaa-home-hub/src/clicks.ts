import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** How often visitors follow links to each hub page. */
export class Clicks {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const mask = process.umask(0o077);
    try {
      this.#db = new DatabaseSync(path);
    } finally {
      process.umask(mask);
    }
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.#db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS page_clicks (path TEXT PRIMARY KEY, clicks INTEGER NOT NULL);`);
  }

  /** Counts one followed link to a page. */
  record(path: string): void {
    this.#db
      .prepare("INSERT INTO page_clicks VALUES (?, 1) ON CONFLICT(path) DO UPDATE SET clicks = clicks + 1")
      .run(path);
  }

  /** Followed links by page path; pages never followed are absent. */
  counts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const row of this.#db.prepare("SELECT path, clicks FROM page_clicks").all()) {
      if (typeof row["path"] === "string" && typeof row["clicks"] === "number") counts.set(row["path"], row["clicks"]);
    }
    return counts;
  }

  close(): void {
    this.#db.close();
  }
}

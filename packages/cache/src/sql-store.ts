import type { CacheStore, SqlDatabase, StoredEntry } from "./types";

/** The single table every SQL-backed cache reads and writes. */
const TABLE = "keel_cache";

/**
 * Create the cache table if it is not already there.
 *
 * `value` holds the JSON-encoded payload; `expires_at` is a nullable epoch-ms
 * deadline (NULL = never expires), mirroring `StoredEntry.expiresAt` exactly.
 */
export async function installCacheSchema(db: SqlDatabase): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      expires_at INTEGER
    )
  `);
}

/** The shape a row comes back as — a true cast, justified by the schema above. */
interface CacheRow {
  value: string;
  expires_at: number | null;
}

/**
 * A SQL-backed store.
 *
 * Values are serialized to JSON on the way in and parsed on the way out, so the
 * store can hold any JSON-representable value. Writes upsert on the primary key,
 * so re-caching a key overwrites rather than duplicates.
 */
export function sqlStore(db: SqlDatabase): CacheStore {
  // The four statements are prepared eagerly, here at construction time —
  // `prepare()` is synchronous (ADR 0006), so the cached handles cost nothing
  // to hold and every terminal below reuses them. Only the I/O verbs await.
  const selectByKey = db.prepare(`SELECT value, expires_at FROM ${TABLE} WHERE key = ?`);

  const upsert = db.prepare(`
    INSERT INTO ${TABLE} (key, value, expires_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at
  `);

  const deleteByKey = db.prepare(`DELETE FROM ${TABLE} WHERE key = ?`);

  const deleteAll = db.prepare(`DELETE FROM ${TABLE}`);

  return {
    async get(key) {
      const row = (await selectByKey.get([key])) as CacheRow | undefined;

      // A miss is undefined, never a half-built entry.
      if (row === undefined) return undefined;

      // JSON.parse is pure value code — the only async beat was the read above.
      return { value: JSON.parse(row.value) as unknown, expiresAt: row.expires_at };
    },

    async set(key, entry: StoredEntry) {
      await upsert.run([key, JSON.stringify(entry.value), entry.expiresAt]);
    },

    async delete(key) {
      await deleteByKey.run([key]);
    },

    async clear() {
      await deleteAll.run();
    },
  };
}

import type { CacheStore, Dialect, SqlDatabase, StoredEntry } from "./types";

/** The single table every SQL-backed cache reads and writes. */
const TABLE = "keel_cache";

/**
 * Create the cache table if it is not already there.
 *
 * `value` holds the JSON-encoded payload; `expires_at` is a nullable epoch-ms
 * deadline (NULL = never expires), mirroring `StoredEntry.expiresAt` exactly.
 *
 * `expires_at` is **`BIGINT`, not `INTEGER`** — an epoch-ms deadline (~1.8e12)
 * overflows Postgres's 32-bit `int4`. On SQLite, `BIGINT` carries INTEGER
 * affinity, so the same DDL is correct on both engines. `dialect` defaults to
 * `"sqlite"`; pass `"postgres"` when installing against a Postgres handle.
 */
export async function installCacheSchema(
  db: SqlDatabase,
  dialect: Dialect = "sqlite",
): Promise<void> {
  const expiresAtType = dialect === "postgres" ? "BIGINT" : "INTEGER";

  await db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      expires_at ${expiresAtType}
    )
  `);
}

/** The shape a row comes back as — a true cast, justified by the schema above. */
interface CacheRow {
  value: string;
  // node-postgres returns BIGINT as a string; SQLite as a number. Either may
  // arrive here, so the read path coerces with `Number()` before handing the
  // deadline back as the `number | null` the `Cache` policy expects.
  expires_at: number | string | null;
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
      // A NULL deadline stays null; a present one is coerced (PG hands BIGINT
      // back as a string) to the epoch-ms number the `Cache` policy compares.
      return {
        value: JSON.parse(row.value) as unknown,
        expiresAt: row.expires_at === null ? null : Number(row.expires_at),
      };
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

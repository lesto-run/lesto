/**
 * @keel/cache — a TTL cache with pluggable stores and an injected clock.
 *
 *   const cache = new Cache({ store: new MemoryStore() });
 *   const user = await cache.fetch("user:1", () => loadUser(1), { ttlMs: 60_000 });
 *
 *   // Or persist across restarts on the SQL database:
 *   installCacheSchema(db);
 *   const cache = new Cache({ store: sqlStore(db) });
 */

export { Cache } from "./cache";
export type { CacheOptions, WriteOptions } from "./cache";

export { MemoryStore } from "./memory-store";

export { installCacheSchema, sqlStore } from "./sql-store";

export { systemClock } from "./time";

export type { CacheStore, Clock, SqlDatabase, SqlStatement, StoredEntry } from "./types";

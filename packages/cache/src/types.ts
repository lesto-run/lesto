/**
 * The vocabulary of the cache.
 *
 * A cache is just a key → value map with an expiry clause. We keep the surface
 * deliberately small so that any backing store — a Map, a SQL table, Redis —
 * can satisfy it structurally, and the `Cache` above never knows the difference.
 */

/**
 * One row in a store.
 *
 * `expiresAt` is an absolute deadline in epoch milliseconds; `null` means the
 * entry never expires. We store the deadline (not a TTL) so a store can be
 * persisted and re-read by a different process without recomputing anything.
 */
export interface StoredEntry {
  value: unknown;
  expiresAt: number | null;
}

/**
 * The pluggable backing store.
 *
 * A store is dumb on purpose: it remembers entries and forgets them on command.
 * It knows nothing about expiry — the `Cache` owns that policy and the clock, so
 * liveness is decided in exactly one place.
 */
export interface CacheStore {
  get(key: string): StoredEntry | undefined;
  set(key: string, entry: StoredEntry): void;
  delete(key: string): void;
  clear(): void;
}

/** Time, made injectable. Returns the current instant in epoch milliseconds. */
export type Clock = () => number;

// ---- the minimal SQL surface (driver-agnostic) ----

export interface SqlStatement {
  run(parameters?: unknown[]): unknown;
  get(parameters?: unknown[]): unknown;
  all(parameters?: unknown[]): unknown[];
}

export interface SqlDatabase {
  prepare(sql: string): SqlStatement;
  exec(sql: string): unknown;
}

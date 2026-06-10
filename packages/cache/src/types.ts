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
 *
 * Every verb is asynchronous (ADR 0006): a store may be backed by an in-process
 * Map or by a networked engine that speaks over a socket, and the `Cache` above
 * must never know the difference. An in-memory store satisfies the contract by
 * resolving immediately — the shape is async even when the work is not.
 */
export interface CacheStore {
  get(key: string): Promise<StoredEntry | undefined>;
  set(key: string, entry: StoredEntry): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
}

/** Time, made injectable. Returns the current instant in epoch milliseconds. */
export type Clock = () => number;

// ---- the minimal SQL surface (driver-agnostic) ----

/**
 * The minimal SQL surface this package consumes from a driver.
 *
 * Per ADR 0006 the I/O terminals are Promise-returning — binding and executing
 * is what touches the wire, so `run`/`get`/`all` and `exec` await — while
 * `prepare()` stays synchronous: it only builds a statement handle, which lets
 * `sqlStore()` cache its prepared statements eagerly at construction without a
 * top-level `await` in a synchronous factory.
 */
export interface SqlStatement {
  run(parameters?: unknown[]): Promise<{ changes: number }>;
  get(parameters?: unknown[]): Promise<unknown>;
  all(parameters?: unknown[]): Promise<unknown[]>;
}

export interface SqlDatabase {
  prepare(sql: string): SqlStatement;
  exec(sql: string): Promise<void>;

  /**
   * Run `fn` inside a single transaction, committing on resolve and rolling
   * back on reject. A first-class primitive (ADR 0006) rather than raw
   * `exec("BEGIN")` DDL: a pooled engine must pin one connection for the whole
   * span, which only a callback boundary can guarantee.
   */
  transaction<T>(fn: (tx: SqlDatabase) => Promise<T>): Promise<T>;
}

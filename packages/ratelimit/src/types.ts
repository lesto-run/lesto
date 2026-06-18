/**
 * The vocabulary of the rate limiter.
 *
 * The limiter depends on a *minimal store surface* — not on any one backend.
 * A Map satisfies it today; a SQL- or Redis-backed store will satisfy the same
 * shape tomorrow, and the limiter never knows the difference.
 *
 * The store owns atomicity; the limiter owns the math. A `check` is a
 * read-modify-write (read the bucket, refill, spend-or-deny, persist), and
 * across two awaits against a shared database a plain async `get`+`set` is a
 * lost-update race. So the store surface is one atomic verb — `update` — that
 * brackets the whole read-modify-write, and the shape is async (ADR 0006/0013)
 * so a table over a socket can satisfy it. An in-memory store satisfies the
 * contract by resolving immediately.
 */

/** A single bucket's persisted state. `updatedAt` is epoch milliseconds. */
export interface BucketState {
  readonly tokens: number;
  readonly updatedAt: number;
}

/** Where buckets live between checks. */
export interface RateLimitStore {
  /**
   * Atomically read-modify-write one bucket. `mutate` receives the current
   * state (undefined for a first-seen key) and returns the state to persist;
   * the store guarantees no other update of the same key interleaves between
   * the read and the write.
   *
   * `mutate` MUST be synchronous and pure over its input — a store may invoke
   * it more than once (e.g. one retry after losing a first-insert race).
   */
  update(
    key: string,
    mutate: (current: BucketState | undefined) => BucketState,
  ): Promise<BucketState>;
}

// ---- the minimal SQL surface (driver-agnostic) ----

/**
 * The minimal SQL surface `sqlRateLimitStore` consumes from a driver.
 *
 * Declared *locally*, type-only — `@lesto/ratelimit` takes no `@lesto/db`
 * dependency (the established cache precedent). Per ADR 0006 the I/O terminals
 * are Promise-returning while `prepare()` stays synchronous.
 *
 * Unlike the session store's seam, this one **must include `transaction`**: an
 * atomic rate-limit check is one read-modify-write that must run inside a single
 * transaction (a locked read on Postgres) — see `sql-store.ts`.
 */
export interface SqlStatement {
  run(parameters?: unknown[]): Promise<{ changes: number }>;
  get(parameters?: unknown[]): Promise<unknown>;
  all(parameters?: unknown[]): Promise<unknown[]>;
}

export interface SqlDatabase {
  prepare(sql: string): SqlStatement;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: SqlDatabase) => Promise<T>): Promise<T>;
}

/** A clock we can stop. Injected wherever time matters, so tests are deterministic. */
export type Clock = () => number;

/** The verdict for a single `check`. */
export interface RateLimitResult {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly retryAfterMs: number;
}

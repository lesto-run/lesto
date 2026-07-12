import { RateLimitError } from "./errors";

import type { BucketState, Clock, RateLimitStore, SqlDatabase } from "./types";

/** The single table every SQL-backed rate-limit store reads and writes. */
const TABLE = "lesto_rate_limits";

/** Which dialect we are speaking — the one fork in this increment (`FOR UPDATE`). */
export type Dialect = "sqlite" | "postgres";

/**
 * A SQL rate-limit store plus the sweep the SQL backing makes cheap.
 *
 * `sweep(before)` deletes rows older than `before`. A bucket whose `updated_at`
 * is at least `capacity / refillPerSecond * 1000` ms old has fully refilled, so
 * its row is semantically identical to no row — deleting it is invisible to the
 * limiter. The store itself starts no timer (it stays a passive value); the
 * CALLER owns the cadence and computes the safe threshold from its policy.
 * {@link startRateLimitSweep} is the batteries-included, process-safe way to
 * drive that cadence, and `@lesto/queue`'s `RetentionScheduler` is the recipe for
 * sweeping several stores from one place.
 */
export interface SqlRateLimitStore extends RateLimitStore {
  sweep(before: number): Promise<number>;
}

/**
 * Create the rate-limit table and its index if they are not already there.
 *
 * Idempotent (`IF NOT EXISTS`). `tokens` is `DOUBLE PRECISION` (fractional
 * accrual; REAL affinity on SQLite); `updated_at` is **`BIGINT`, not `INTEGER`**
 * — epoch-ms (~1.8e12) overflows Postgres int4.
 */
export async function installRateLimitSchema(db: SqlDatabase): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      key        TEXT PRIMARY KEY,
      tokens     DOUBLE PRECISION NOT NULL,
      updated_at BIGINT NOT NULL
    )
  `);

  await db.exec(`CREATE INDEX IF NOT EXISTS ${TABLE}_updated_at ON ${TABLE} (updated_at)`);
}

/** The shape a bucket row comes back as. Both columns may arrive string-typed (PG). */
interface RateLimitRow {
  tokens: number | string;
  updated_at: number | string;
}

/** The two structured SQLite codes that are actually unique-ish, not merely `SQLITE_CONSTRAINT*`. */
const SQLITE_UNIQUE_CODES = new Set(["SQLITE_CONSTRAINT_UNIQUE", "SQLITE_CONSTRAINT_PRIMARYKEY"]);

/**
 * Detect a unique-constraint violation, structurally — never by parsing prose
 * loosely, and never by a loose `SQLITE_CONSTRAINT` prefix match. Postgres uses
 * SQLSTATE `23505`; SQLite reports a message containing `UNIQUE constraint
 * failed`, or — on drivers that expose a structured code — exactly
 * `SQLITE_CONSTRAINT_UNIQUE` or `SQLITE_CONSTRAINT_PRIMARYKEY`.
 *
 * `SQLITE_CONSTRAINT_NOTNULL` / `_CHECK` / `_FOREIGNKEY` / `_TRIGGER` share the
 * `SQLITE_CONSTRAINT` prefix but are NOT unique violations — this store is
 * shared by @lesto/identity's `register()` against the `users` table (four
 * NOT NULL columns plus a UNIQUE email), so treating the prefix alone as the
 * signal would swallow a genuine NOT NULL/CHECK/FK failure (e.g. a hasher
 * resolving `null` into `password_hash NOT NULL`) as a fake unique-conflict
 * retry — a silent, wrong "success". Exported so the predicate's truth table
 * is directly covered.
 */
export function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;

  const record = error as { code?: unknown; message?: unknown };

  if (record.code === "23505") return true;

  if (typeof record.code === "string" && SQLITE_UNIQUE_CODES.has(record.code)) return true;

  if (typeof record.message === "string" && record.message.includes("UNIQUE constraint failed")) {
    return true;
  }

  return false;
}

/**
 * A SQL-backed, fleet-correct {@link RateLimitStore}.
 *
 * Each `update` is one transaction (ADR 0013 §5): a locked read (`FOR UPDATE` on
 * Postgres only — SQLite rejects the clause and needs no lock, since the runtime
 * serializes every transaction over its one connection), `mutate`, then a write.
 *
 * Statements are prepared per-transaction on `tx`, **never eagerly on `db`**: on
 * Postgres a statement prepared from the pool-level handle queries through the
 * pool and silently escapes the transaction's pinned client. (Sessions, which
 * never transact, deliberately do the opposite and prepare eagerly.)
 *
 * The first row for a key cannot be locked (nothing exists to lock), so two
 * concurrent births both INSERT and the loser fails the primary key. We use a
 * plain INSERT (not upsert) so that failure is loud, then retry the whole update
 * once — the row now exists, so the retry takes the locked path. A second
 * consecutive conflict is a coded refusal, never an infinite loop. Any other
 * error propagates untouched: a rate limiter must fail closed (the request
 * errors), never fail open (a silent bypass).
 */
export function sqlRateLimitStore(
  db: SqlDatabase,
  options: { dialect?: Dialect } = {},
): SqlRateLimitStore {
  const dialect = options.dialect ?? "sqlite";

  const lockClause = dialect === "postgres" ? " FOR UPDATE" : "";

  const attempt = (
    key: string,
    mutate: (current: BucketState | undefined) => BucketState,
  ): Promise<BucketState> =>
    db.transaction(async (tx) => {
      const select = tx.prepare(
        `SELECT tokens, updated_at FROM ${TABLE} WHERE key = ?${lockClause}`,
      );

      const row = (await select.get([key])) as RateLimitRow | undefined;

      if (row !== undefined) {
        // node-postgres returns BIGINT/numeric as strings — coerce both columns.
        const current: BucketState = {
          tokens: Number(row.tokens),
          updatedAt: Number(row.updated_at),
        };

        const next = mutate(current);

        await tx
          .prepare(`UPDATE ${TABLE} SET tokens = ?, updated_at = ? WHERE key = ?`)
          .run([next.tokens, next.updatedAt, key]);

        return next;
      }

      // Absent → a plain INSERT (no upsert: the conflict is the signal a
      // concurrent birth won the race).
      const next = mutate(undefined);

      await tx
        .prepare(`INSERT INTO ${TABLE} (key, tokens, updated_at) VALUES (?, ?, ?)`)
        .run([key, next.tokens, next.updatedAt]);

      return next;
    });

  return {
    async update(key, mutate) {
      try {
        return await attempt(key, mutate);
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;

        // First conflict: the row now exists — retry once on the locked path.
        try {
          return await attempt(key, mutate);
        } catch (retryError) {
          if (!isUniqueViolation(retryError)) throw retryError;

          // A second consecutive conflict (only against a concurrent sweep):
          // a coded refusal, never an infinite loop.
          throw new RateLimitError(
            "RATELIMIT_STORE_CONFLICT",
            "Rate-limit bucket update conflicted twice.",
            { key },
          );
        }
      }
    },

    async sweep(before) {
      const { changes } = await db
        .prepare(`DELETE FROM ${TABLE} WHERE updated_at < ?`)
        .run([before]);

      return changes;
    },
  };
}

// ---------------------------------------------------------------------------
// Periodic sweep (L-f8e7d11f) — bound the durable store's ROW growth.
//
// Wiring a `db` swaps the in-memory limiter's self-bounding Map (a hard
// `maxBuckets` cap) for a SQL store, moving growth from RAM to `lesto_rate_limits`
// ROWS — one row per distinct client key (a per-IP flood, or every `login:<email>`)
// that lingers until a sweep reclaims it. `sweep(before)` is cheap and lossless (a
// row idle past its full-refill horizon is identical to no row), but the store
// starts no timer, so a durable-by-default app with no operator-run sweep grows the
// table unbounded. This is the process-safe driver that closes that gap.
// ---------------------------------------------------------------------------

/** The default sweep cadence: reclaim on a one-minute tick — the common ops grain. */
export const DEFAULT_RATELIMIT_SWEEP_INTERVAL_MS = 60_000;

/**
 * The default *retention* window: a bucket must sit idle at least this long before
 * its row is reclaimed. Deliberately CONSERVATIVE (one hour) because
 * `lesto_rate_limits` is a SHARED table — `@lesto/identity`'s login/TOTP
 * brute-force limiters key into it too — and a sweep is table-wide (`DELETE ...
 * WHERE updated_at < ?`), blind to which limiter owns a row. A retention shorter
 * than a co-tenant limiter's full-refill horizon would delete a still-throttled
 * bucket, which then re-materializes FULL on the next check — resetting a
 * brute-force counter (a limiter bypass). One hour clears the horizon of any
 * ordinary per-request / per-login limiter; raise it if you run a slower one, and
 * never set it below the SLOWEST limiter sharing the table.
 */
export const DEFAULT_RATELIMIT_SWEEP_RETENTION_MS = 3_600_000;

/** What {@link startRateLimitSweep} accepts. */
export interface RateLimitSweepOptions {
  /**
   * How long a bucket must sit idle before its row is reclaimed, in ms. Each tick
   * sweeps `updated_at < clock() - retentionMs`. MUST exceed the full-refill
   * horizon of EVERY limiter sharing the table (see
   * {@link DEFAULT_RATELIMIT_SWEEP_RETENTION_MS}). Defaults to one hour.
   */
  readonly retentionMs?: number;

  /** How often the sweep fires, in ms. Defaults to {@link DEFAULT_RATELIMIT_SWEEP_INTERVAL_MS}. */
  readonly intervalMs?: number;

  /** Epoch-ms clock, injectable for deterministic tests. Defaults to `Date.now`. */
  readonly clock?: Clock;

  /**
   * Where a sweep's rejection goes. A `sweep` that throws (a transient DB fault)
   * must not become an unhandled rejection or kill the cadence — it is caught and
   * routed here, then retried on the next tick. Absent → the fault is swallowed
   * and retried silently.
   */
  readonly onError?: (error: unknown) => void;

  /** The timer seam, injectable so tests drive the cadence with no real waiting. */
  readonly setInterval?: (callback: () => void, ms: number) => unknown;

  /** Clears a handle from {@link RateLimitSweepOptions.setInterval}. */
  readonly clearInterval?: (handle: unknown) => void;
}

/** A running sweep. {@link RateLimitSweepHandle.stop} tears down its timer. */
export interface RateLimitSweepHandle {
  stop(): void;
}

/**
 * Drive a durable {@link SqlRateLimitStore}'s `sweep` on a cadence, safely.
 *
 * Mirrors `@lesto/queue`'s `RetentionScheduler.start` — a no-overlap guard so a
 * slow sweep never stacks a second concurrent delete onto one connection, coded
 * error routing, and an injectable timer seam — but adds the one thing a
 * framework-managed default needs: it **`unref`s the timer** (when the runtime's
 * timer supports it) so a running sweep NEVER keeps the process alive or leaks
 * across a test (the repo's force-exit-timer trap). Returns a handle whose `stop`
 * clears the timer for a graceful drain.
 *
 * Each tick sweeps `updated_at < clock() - retentionMs`. Choosing `retentionMs`
 * is a SAFETY decision on a shared table — read
 * {@link DEFAULT_RATELIMIT_SWEEP_RETENTION_MS}.
 *
 *   const sweep = startRateLimitSweep(sqlRateLimitStore(db), { retentionMs: 3_600_000 });
 *   // on shutdown: sweep.stop();
 */
export function startRateLimitSweep(
  store: Pick<SqlRateLimitStore, "sweep">,
  options: RateLimitSweepOptions = {},
): RateLimitSweepHandle {
  const intervalMs = options.intervalMs ?? DEFAULT_RATELIMIT_SWEEP_INTERVAL_MS;
  const retentionMs = options.retentionMs ?? DEFAULT_RATELIMIT_SWEEP_RETENTION_MS;
  const clock = options.clock ?? (() => Date.now());
  const onError = options.onError;
  const setTimer = options.setInterval ?? ((callback, ms) => setInterval(callback, ms));
  const clearTimer = options.clearInterval ?? ((handle) => clearInterval(handle as never));

  // A non-finite / non-positive interval never fires (or throws in the runtime),
  // silently disabling the bound this exists to enforce; a negative retention would
  // sweep FUTURE-stamped rows. Fail LOUD at the call, not silently at runtime — a
  // plain Error, matching the store's maxBuckets construction guard (config
  // validation is a programmer error, not a coded runtime refusal callers branch on).
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error(
      `startRateLimitSweep intervalMs must be a positive, finite number, received ${intervalMs}.`,
    );
  }

  if (!Number.isFinite(retentionMs) || retentionMs < 0) {
    throw new Error(
      `startRateLimitSweep retentionMs must be a non-negative, finite number, received ${retentionMs}.`,
    );
  }

  // No-overlap: a slow sweep must not let the next cadence fire a second concurrent
  // delete over the same connection — skip until the in-flight one settles.
  let sweeping = false;

  const handle = setTimer(() => {
    if (sweeping) return;

    sweeping = true;

    void Promise.resolve(store.sweep(clock() - retentionMs))
      .then(
        () => undefined,
        (error: unknown) => {
          // A throwing reporter must not kill the cadence; a rejection with no
          // reporter is swallowed and retried next tick (the passive default).
          if (onError !== undefined) onError(error);
        },
      )
      .finally(() => {
        sweeping = false;
      });
  }, intervalMs);

  // Never pin the event loop open: an unref'd timer lets the process exit cleanly
  // and keeps a test from hanging on a dangling interval. `unref` is Node/Bun's
  // Timeout API and may be absent on other runtimes (or an injected fake) — guard it.
  if (typeof (handle as { unref?: unknown }).unref === "function") {
    (handle as { unref: () => void }).unref();
  }

  return {
    stop: (): void => clearTimer(handle),
  };
}

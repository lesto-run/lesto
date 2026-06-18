import { RateLimitError } from "./errors";

import type { BucketState, RateLimitStore, SqlDatabase } from "./types";

/** The single table every SQL-backed rate-limit store reads and writes. */
const TABLE = "volo_rate_limits";

/** Which dialect we are speaking — the one fork in this increment (`FOR UPDATE`). */
export type Dialect = "sqlite" | "postgres";

/**
 * A SQL rate-limit store plus the sweep the SQL backing makes cheap.
 *
 * `sweep(before)` deletes rows older than `before`. A bucket whose `updated_at`
 * is at least `capacity / refillPerSecond * 1000` ms old has fully refilled, so
 * its row is semantically identical to no row — deleting it is invisible to the
 * limiter. The CALLER owns the cadence and computes the safe threshold from its
 * policy; the framework starts no timer.
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

/**
 * Detect a unique-constraint violation, structurally — never by parsing prose
 * loosely. Postgres uses SQLSTATE `23505`; SQLite reports a message containing
 * `UNIQUE constraint failed` or a code beginning `SQLITE_CONSTRAINT`. Exported
 * so the predicate's truth table is directly covered.
 */
export function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;

  const record = error as { code?: unknown; message?: unknown };

  if (record.code === "23505") return true;

  if (typeof record.code === "string" && record.code.startsWith("SQLITE_CONSTRAINT")) return true;

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

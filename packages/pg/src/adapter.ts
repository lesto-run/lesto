/**
 * Adapt a node-postgres `Pool` to `@keel/db`'s async `SqlDatabase` seam (ADR 0006).
 *
 * The whole point of the async flip: a networked Postgres pool can now back the
 * exact same surface as in-process SQLite. The pieces this file owns:
 *
 *   - `?` → `$1..$n` placeholder translation (see {@link translate}), done once
 *     per prepared statement.
 *   - `lastInsertRowid`: Postgres has no implicit row id, so it is surfaced ONLY
 *     when a statement's `RETURNING id` produced a numeric `id` row — otherwise
 *     omitted (the field is optional on the seam). The queue's `enqueue` reads
 *     its id via `RETURNING id` + `.get()`; this also populates `run()` best-effort.
 *   - `transaction(fn)`: checks out ONE pooled client, brackets BEGIN/COMMIT
 *     (ROLLBACK on throw), and runs `fn` against a db bound to that single client
 *     — the only correct shape on a pool, where separate `query("BEGIN")` calls
 *     would land on different connections.
 *
 * The `Pg*` interfaces are STRUCTURAL: a real `pg.Pool`/`PoolClient` satisfies
 * them, but the adapter never imports `pg`, so this module (and the package) need
 * no `pg` at type-check time. The real `new Pool()` lives in `./pg-driver`.
 */

import type { SqlDatabase } from "@keel/db";

import { translate } from "./translate";

/** What `pg` hands back from `query` — the two fields the adapter reads. */
export interface PgQueryResult {
  rows: unknown[];
  rowCount: number | null;
}

/** The minimal query surface a `pg.Pool` and a `pg.PoolClient` share. */
export interface PgQueryable {
  query(text: string, values?: unknown[]): Promise<PgQueryResult>;
}

/**
 * A checked-out pooled client — queryable, plus released back to the pool.
 *
 * `release(err)` mirrors node-postgres: pass the error that broke the
 * transaction and the pool DISCARDS the client (it may be in an unknown state)
 * rather than recycling it; pass nothing to return a healthy client to the pool.
 */
export interface PgClient extends PgQueryable {
  release(err?: unknown): void;
}

/** A `pg.Pool`: queryable, hands out clients for transactions, closeable. */
export interface PgPool extends PgQueryable {
  connect(): Promise<PgClient>;
  end(): Promise<void>;
}

/** The `exec` + `prepare` half of the seam, over any queryable (pool or client). */
function statementsOver(queryable: PgQueryable): Pick<SqlDatabase, "exec" | "prepare"> {
  return {
    exec: async (sql) => {
      await queryable.query(sql);
    },

    prepare: (sql) => {
      // Translate once at prepare time; the statement closes over the `$n` text.
      const text = translate(sql);

      return {
        // `lastInsertRowid` is intentionally omitted (the seam marks it optional):
        // Postgres has no implicit row id, and the only consumer that wants an id
        // reads it explicitly via `INSERT ... RETURNING id` + `.get()` (the queue).
        run: async (params = []) => {
          const result = await queryable.query(text, params);

          return { changes: result.rowCount ?? 0 };
        },

        get: async (params = []) => {
          const result = await queryable.query(text, params);

          return result.rows[0] ?? undefined;
        },

        all: async (params = []) => {
          const result = await queryable.query(text, params);

          return result.rows;
        },
      };
    },
  };
}

/** Build an async {@link SqlDatabase} backed by a Postgres connection pool. */
export function createPgDatabase(pool: PgPool): SqlDatabase {
  return {
    ...statementsOver(pool),

    transaction: async (fn) => {
      const client = await pool.connect();
      let failure: unknown;

      try {
        await client.query("BEGIN");

        // The transaction-scoped db pins every statement to this one client.
        // Postgres has no nested BEGIN, so a nested `transaction` just runs its
        // callback on the same client (flat) — the migrator never nests.
        const tx: SqlDatabase = {
          ...statementsOver(client),
          transaction: (inner) => inner(tx),
        };

        const out = await fn(tx);

        await client.query("COMMIT");

        return out;
      } catch (error) {
        failure = error;

        // Best-effort rollback: a throwing ROLLBACK must not mask the original
        // error (which stays the rejection).
        try {
          await client.query("ROLLBACK");
        } catch {
          /* keep the original error */
        }

        throw error;
      } finally {
        // On failure the client may be in an unknown state — hand the error to
        // release() so the pool discards it instead of recycling a broken client.
        client.release(failure);
      }
    },
  };
}

/** Connection config handed to the underlying pool (structural — a `pg` PoolConfig). */
export interface PgConfig {
  readonly connectionString?: string;
  readonly max?: number;
}

/**
 * Open a Postgres-backed {@link SqlDatabase} plus a `close` that drains the pool.
 *
 * `makePool` is injected so the adapter is tested against a fake pool with no
 * live database; the default builds a real `pg.Pool` (see `./pg-driver`).
 */
export async function openPostgres(
  config: PgConfig,
  makePool: (config: PgConfig) => PgPool,
): Promise<{ db: SqlDatabase; close: () => Promise<void> }> {
  const pool = makePool(config);

  return { db: createPgDatabase(pool), close: () => pool.end() };
}

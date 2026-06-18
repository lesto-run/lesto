/**
 * A first-party Cloudflare Hyperdrive adapter for `@volo/db`.
 *
 * Hyperdrive is the ONLY Postgres a Worker can reach. A Worker has no node sockets
 * and `@volo/pg`'s `new Pool` is node-only (`createRequire("pg")`), so "SQLite local
 * → Postgres at scale, same APIs" stops at the node tier without this. Hyperdrive
 * fronts a real Postgres with edge-side pooling + connection caching and exposes a
 * `connectionString` a postgres-protocol client speaks over inside the Worker.
 * `hyperdriveToSqlDatabase` wraps such a connection in the same `SqlDatabase` surface
 * `@volo/db`'s `createDb` consumes, so a DB-driven page runs the IDENTICAL query path
 * on Workers (over Hyperdrive→Postgres) as it does on Node (over `pg`) — only the
 * driver differs. It mirrors the D1 adapter (`d1ToSqlDatabase`) one tier up: D1 is
 * the edge's SQLite, Hyperdrive is the edge's Postgres.
 *
 * A minimal STRUCTURAL `HyperdriveConnection` is declared here rather than depending
 * on `@cloudflare/workers-types` or a specific postgres client: the adapter only
 * reads `query(text, values) => { rows, rowCount }` — exactly the `node-postgres`
 * `Client`/`Pool` surface — so a consumer wires whatever postgres client it bundles
 * (node-postgres, postgres-js shimmed, etc.) to the Hyperdrive `connectionString`
 * with no extra type dependency. The package itself imports NO postgres runtime and
 * NO `node:*` builtins, so this module bundles clean for Workers (proven by the
 * dry-run worker under `test/` + the CI hyperdrive-parity job).
 *
 * The `?` → `$1..$n` placeholder translation `@volo/db` emits for every bound value
 * is the SAME one `@volo/pg` performs — imported from `@volo/pg/translate` (a leaf
 * module with zero `pg`/`node:*` imports), so there is one source of truth for the
 * dialect across both Postgres tiers.
 */

import type { SqlDatabase } from "@volo/db";
import { translate } from "@volo/pg/translate";

/** What a postgres-protocol query hands back — the two fields the adapter reads. */
export interface HyperdriveQueryResult {
  rows: unknown[];
  rowCount: number | null;
}

/**
 * The slice of a postgres connection (over the Hyperdrive `connectionString`) this
 * adapter uses — identical to node-postgres' `query(text, values)`. Inside a Worker
 * this is a postgres client `connect()`ed to `env.HYPERDRIVE.connectionString`.
 */
export interface HyperdriveConnection {
  query(text: string, values?: unknown[]): Promise<HyperdriveQueryResult>;
}

/**
 * The slice of Cloudflare's Hyperdrive binding this adapter cares about — the
 * `connectionString` a Worker hands to its postgres client. Declared for the
 * consumer's env typing; `hyperdriveToSqlDatabase` itself takes the already-opened
 * {@link HyperdriveConnection} (so it stays testable with a fake and free of any
 * postgres client dependency).
 */
export interface Hyperdrive {
  readonly connectionString: string;
}

/**
 * Adapt a postgres connection opened over a Cloudflare Hyperdrive binding to the
 * async `SqlDatabase` surface `@volo/db` consumes.
 *
 * Unlike the node `@volo/pg` driver — which checks a client out of a POOL per
 * transaction — a Worker holds ONE Hyperdrive-backed connection for the request, so
 * the transaction brackets `BEGIN`/`COMMIT` (with a best-effort `ROLLBACK` on throw
 * that never masks the original error) directly on that single connection. A nested
 * `transaction` runs flat on the same connection (Postgres has no nested `BEGIN`),
 * matching the node driver's semantics.
 *
 * `lastInsertRowid` is intentionally omitted (the seam marks it optional): Postgres
 * has no implicit row id, and the only consumer that wants one reads it via
 * `INSERT ... RETURNING id` + `.get()` — exactly as the node Postgres driver does.
 */
export function hyperdriveToSqlDatabase(connection: HyperdriveConnection): SqlDatabase {
  // The `exec` + `prepare` half of the seam, over any connection (the request
  // connection, or — once a transaction has opened — that same connection again;
  // there is only one in a Worker, so this is the same handle either way).
  const statements: Pick<SqlDatabase, "exec" | "prepare"> = {
    exec: async (sql) => {
      await connection.query(sql);
    },

    prepare: (sql) => {
      // Translate `?` → `$n` once at prepare time; the statement closes over the
      // rewritten text, exactly like the node Postgres driver.
      const text = translate(sql);

      return {
        run: async (params = []) => {
          const result = await connection.query(text, params);

          return { changes: result.rowCount ?? 0 };
        },

        get: async (params = []) => {
          const result = await connection.query(text, params);

          return result.rows[0] ?? undefined;
        },

        all: async (params = []) => {
          const result = await connection.query(text, params);

          return result.rows;
        },
      };
    },
  };

  return {
    ...statements,

    transaction: async (fn) => {
      await connection.query("BEGIN");

      // The transaction-scoped db is the same single connection; a nested
      // `transaction` runs FLAT on it (Postgres has no nested BEGIN), matching the
      // node Postgres driver — the migrator never nests.
      const tx: SqlDatabase = {
        ...statements,
        transaction: (inner) => inner(tx),
      };

      try {
        const out = await fn(tx);

        await connection.query("COMMIT");

        return out;
      } catch (error) {
        // Best-effort rollback: a throwing ROLLBACK must not mask the original
        // error (which stays the rejection).
        try {
          await connection.query("ROLLBACK");
        } catch {
          /* keep the original error */
        }

        throw error;
      }
    },
  };
}

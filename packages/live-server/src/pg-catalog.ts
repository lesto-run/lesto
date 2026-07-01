/**
 * The real Postgres **catalog probe** for the Tier-4 change source's replica-identity guard
 * (ADR 0042) — coverage-excluded socket wiring, the same discipline as the `pg` replication client
 * ({@link file://./pg-replication-client.ts}): every DECISION that reads the probe's boolean lives
 * in the shape engine and is tested against the injected `replicaIdentity` seam; what remains here
 * is the one catalog query, which has nothing to exercise but a live Postgres.
 *
 * The delete-from-shape classifier needs to know whether a shape's table is `REPLICA IDENTITY FULL`
 * — a catalog fact (`pg_class.relreplident`) the replication *stream* cannot signal — to refuse a
 * non-key-predicate shape that could otherwise silently leak. This probe answers that per table.
 *
 * **It requires `relreplident = 'f'` (FULL), nothing weaker (ADR 0042 red-team F3).** `USING INDEX`
 * (`'i'`) and `NOTHING` (`'n'`) do NOT suffice: their old tuple may omit the shape's key or filter
 * columns, so a delete-from-shape would drop (a leak) or a `rowKey` would throw. Only `FULL`
 * guarantees the complete old image the classifier's in/out/stay decision depends on.
 *
 * `pg` is an **optional peer**, loaded lazily inside the factory (never at module top) so an app on
 * the v0 SQLite poll never needs `pg` on disk merely to import `@lesto/live-server`.
 */

import { createRequire } from "node:module";

import type { PgReplicationConfig } from "./pg-replication-client";

/** The slice of a raw `pg.Client` this probe drives — typed structurally to avoid a `pg` type dep. */
interface RawPgClient {
  connect(): Promise<void>;
  query(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: ReadonlyArray<Record<string, unknown>> }>;
  end(): Promise<void>;
}

/**
 * Build the `replicaIdentity` seam the shape engine's replication path needs: a
 * `(tableName) => Promise<boolean>` that answers "is this table `REPLICA IDENTITY FULL`?" from the
 * catalog. Opens a short-lived normal (non-replication) connection per call — replica identity is
 * read once per shape at subscribe, off the hot change path, so a fresh connection is fine and
 * keeps this stateless.
 */
export function createReplicaIdentityProbe(
  config: PgReplicationConfig,
): (tableName: string) => Promise<boolean> {
  const base = typeof config === "string" ? { connectionString: config } : { ...config };

  return async (tableName: string): Promise<boolean> => {
    const require = createRequire(import.meta.url);
    const { Client } = require("pg") as {
      Client: new (config: Record<string, unknown>) => RawPgClient;
    };
    const client = new Client(base);

    await client.connect();

    try {
      // `$1::regclass` resolves the (optionally schema-qualified) name to its OID via the caller's
      // search_path — the table name is bound as a parameter, never spliced into SQL.
      const { rows } = await client.query(
        "SELECT relreplident FROM pg_class WHERE oid = $1::regclass",
        [tableName],
      );

      return rows[0]?.relreplident === "f";
    } finally {
      await client.end();
    }
  };
}

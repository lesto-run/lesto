/**
 * The real `pg` logical-replication client for the Tier-4 change source (ADR 0042) — the
 * thin, **coverage-excluded** wiring. Every decision the source makes (reconnect/backoff,
 * the slot lifecycle, identity stamping, error routing) is tested in `replication.ts`
 * against the {@link PgReplicationClient} seam; this file is only the irreducible replication
 * protocol construction, which has nothing to test but a live Postgres WAL stream.
 *
 * `pg` is an **optional peer**: a deployment using the Postgres change source installs it. It
 * is loaded lazily inside the factory (never imported at module top) so an app on the SQLite
 * v0 poll never needs `pg` on disk just to import `@lesto/live-server`. (Mirrors
 * `@lesto/pg`'s `pg-driver.ts` and `@lesto/realtime`'s `pg-client.ts`.)
 *
 * **Operational requirements this client depends on** (ADR 0042 *Consequences*):
 *  - **`REPLICA IDENTITY FULL`** on every shape-backing table whose predicate references a
 *    non-PK column. Without it Postgres logs only the old tuple's **primary key** on
 *    UPDATE/DELETE, so `oldImage` would be PK-only and the shape engine could not tell a row
 *    left a shape — a silent leak. The full old image is what {@link DecodedChange}'s
 *    `oldImage` carries, and it is logged only under `REPLICA IDENTITY FULL`.
 *  - The **`wal2json`** output plugin installed on the server (the decoder this client uses —
 *    JSON-per-change, so no binary `pgoutput` parsing here). `pgoutput` is the alternative
 *    (built-in, binary) and would swap only this file's decode step.
 *  - A logical-replication slot **pins WAL** until acknowledged: the source drops it on stop,
 *    and the deployment owns slot-lag alerting + the disk-pressure runbook.
 */

import { createRequire } from "node:module";

import type { DecodedChange, PgReplicationClient, RowImage, SystemIdentity } from "./replication";

/** Connection config for the dedicated replication client — a libpq URL or field set. */
export type PgReplicationConfig =
  | string
  | { readonly connectionString?: string; readonly [key: string]: unknown };

/** The slice of a raw `pg.Client` this wiring drives — typed structurally to avoid a `pg` type dep. */
interface RawPgClient {
  connect(): Promise<void>;
  query(sql: string): Promise<{ rows: ReadonlyArray<Record<string, unknown>> }>;
  on(event: string, listener: (...args: readonly unknown[]) => void): unknown;
  end(): Promise<void>;
}

/** One `wal2json` change object, as the plugin emits it on the copy-data stream. */
interface Wal2JsonChange {
  readonly kind: "insert" | "update" | "delete";
  readonly table: string;
  readonly columnnames?: readonly string[];
  readonly columnvalues?: readonly unknown[];
  readonly oldkeys?: {
    readonly keynames: readonly string[];
    readonly keyvalues: readonly unknown[];
  };
}

/** Zip `wal2json`'s parallel name/value arrays into a {@link RowImage}. */
function zipImage(names: readonly string[], values: readonly unknown[]): RowImage {
  const image: RowImage = {};

  for (let i = 0; i < names.length; i++) image[names[i]!] = values[i];

  return image;
}

/**
 * Map one `wal2json` change to a {@link DecodedChange}, stamping the batch's `commitLSN`.
 * Insert carries only `newImage`, delete only `oldImage`, update both (the old image needs
 * `REPLICA IDENTITY FULL`) — modeled exactly as the seam requires.
 */
function decodeChange(change: Wal2JsonChange, commitLSN: string): DecodedChange {
  const newImage = zipImage(change.columnnames ?? [], change.columnvalues ?? []);
  const oldImage = zipImage(change.oldkeys?.keynames ?? [], change.oldkeys?.keyvalues ?? []);

  switch (change.kind) {
    case "insert":
      return { op: "insert", table: change.table, commitLSN, newImage };
    case "update":
      return { op: "update", table: change.table, commitLSN, newImage, oldImage };
    default:
      return { op: "delete", table: change.table, commitLSN, oldImage };
  }
}

/**
 * Build a factory that mints a fresh dedicated logical-replication client from `config`.
 *
 * The source calls this on `start` and on every reconnect (a dropped stream needs a brand-new
 * connection). The client is opened in `replication: 'database'` mode and speaks the four
 * replication commands the seam needs; changes arrive as `wal2json` copy-data and are decoded
 * to {@link DecodedChange} (identity stamping is the source's job, not this file's).
 */
export function createPgReplicationClientFactory(
  config: PgReplicationConfig,
): () => PgReplicationClient {
  return () => {
    // Lazy + indirect so the `pg` dependency is only resolved when the Postgres change source
    // is actually constructed, never at import time.
    const require = createRequire(import.meta.url);
    const { Client } = require("pg") as {
      Client: new (config: Record<string, unknown>) => RawPgClient;
    };

    const base = typeof config === "string" ? { connectionString: config } : { ...config };
    const raw = new Client({ ...base, replication: "database" });

    let changeListener: ((change: DecodedChange) => void) | undefined;

    return {
      connect: () => raw.connect(),

      async identifySystem(): Promise<SystemIdentity> {
        // IDENTIFY_SYSTEM returns one row: { systmid, timeline, xlogpos, dbname }.
        const { rows } = await raw.query("IDENTIFY_SYSTEM");
        const row = rows[0] ?? {};

        return { systemId: String(row.systemid), timelineId: Number(row.timeline) };
      },

      async createSlot(slot: string): Promise<void> {
        // A logical slot with the wal2json plugin; persists until dropped.
        await raw.query(`CREATE_REPLICATION_SLOT ${slot} LOGICAL wal2json`);
      },

      async dropSlot(slot: string): Promise<void> {
        await raw.query(`DROP_REPLICATION_SLOT ${slot}`);
      },

      async startReplication(slot: string, startLsn?: string): Promise<void> {
        // Stream copy-data from the slot; wal2json emits one JSON object per transaction, each
        // with a `nextlsn` (the commit position) and a `change[]` array. Resume from `startLsn`
        // when given, else from the slot's confirmed position (`0/0` lets the server choose).
        raw.on("copyData", (...args: readonly unknown[]) => {
          const chunk = args[0] as { chunk?: Uint8Array } | Uint8Array | undefined;
          const bytes = chunk instanceof Uint8Array ? chunk : chunk?.chunk;

          if (bytes === undefined) return;

          const batch = JSON.parse(Buffer.from(bytes).toString("utf8")) as {
            nextlsn?: string;
            change?: readonly Wal2JsonChange[];
          };
          const commitLSN = batch.nextlsn ?? "0/0";

          for (const change of batch.change ?? [])
            changeListener?.(decodeChange(change, commitLSN));
        });

        await raw.query(`START_REPLICATION SLOT ${slot} LOGICAL ${startLsn ?? "0/0"}`);
      },

      on(event: "change" | "error", listener: (arg: never) => void): unknown {
        if (event === "change") changeListener = listener as (change: DecodedChange) => void;
        else raw.on("error", listener as (...args: readonly unknown[]) => void);

        return this;
      },

      end: () => raw.end(),
    };
  };
}

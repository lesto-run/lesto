/**
 * The real `pg` logical-replication client for the Tier-4 change source (ADR 0042) — the
 * coverage-excluded socket wiring. Every DECISION the source makes (reconnect/backoff, the slot
 * lifecycle, identity stamping, error routing) is tested in `replication.ts` against the
 * {@link PgReplicationClient} seam, and the pure `wal2json`→{@link DecodedChange} decode is
 * tested in `wal2json.ts`; what remains here is the irreducible replication-protocol
 * construction + copy-data framing, which has nothing to exercise but a live Postgres WAL stream.
 *
 * `pg` is an **optional peer**: a deployment using the Postgres change source installs it. It is
 * loaded lazily inside the factory (never imported at module top) so an app on the SQLite v0 poll
 * never needs `pg` on disk just to import `@lesto/live-server`. (Mirrors `@lesto/pg`'s
 * `pg-driver.ts` and `@lesto/realtime`'s `pg-client.ts`.)
 *
 * **⚠ UNVERIFIED — needs a live-PG shakeout before Inc4 relies on it.** This file cannot run in
 * the unit suite (no live WAL), and two things here are asserted from the protocol docs, not
 * observed: (1) whether a high-level `pg.Client` re-emits logical-replication copy-data as a
 * `copyData` event at all (it may surface only on the underlying `Connection`), and (2) the exact
 * `XLogData`/keepalive framing stripped below. Inc4 (which is the first increment to depend on a
 * real commit LSN) owns validating this against a real slot. Tracked as a follow-up task.
 *
 * **Decoder choice.** This client uses the `wal2json` output plugin (JSON-per-change — simplest
 * first real decoder). `wal2json` is a *server extension*, and managed providers vary (RDS/Aurora
 * and Supabase have it; Cloud SQL historically has not), so **`pgoutput` — built into core
 * Postgres, available wherever `wal_level=logical` is — is the portability-preferred follow-up**
 * for a framework whose moat is "runs on YOUR Postgres". The plugin is a constructor arg here so a
 * `pgoutput` decoder can be slotted behind the same seam without touching the source; that decoder
 * is a tracked follow-up (it decodes to the same {@link DecodedChange}).
 *
 * **Operational requirements** (ADR 0042 *Consequences*):
 *  - **`REPLICA IDENTITY FULL`** on every shape-backing table whose predicate references a non-PK
 *    column, or `oldImage` is PK-only and delete-from-shape silently leaks (the shape engine
 *    guards this at registration — Inc2 — via the catalog, since the stream cannot signal it).
 *  - A logical-replication slot **pins WAL** until acknowledged: the source drops it on stop, and
 *    the deployment owns slot-lag alerting + the disk-pressure runbook.
 */

import { createRequire } from "node:module";

import type { DecodedChange, PgReplicationClient, SystemIdentity } from "./replication";
import { decodeWal2JsonChange, type Wal2JsonChange } from "./wal2json";

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

/** A Postgres LSN is `<hex>/<hex>`; a client-presented resume position MUST match before it is
 * spliced into `START_REPLICATION` (a replication command cannot bind parameters). */
const LSN_PATTERN = /^[0-9A-Fa-f]+\/[0-9A-Fa-f]+$/;

/** `XLogData` messages lead with `'w'`; the wal2json JSON follows a 25-byte WAL/timestamp header. */
const XLOG_DATA = 0x77; // 'w'
const XLOG_DATA_HEADER_BYTES = 1 + 8 + 8 + 8; // msgType + walStart + walEnd + sendTime

/**
 * Strip one copy-data frame to its wal2json JSON payload, or `undefined` for a keepalive / any
 * frame that is not `XLogData` (nothing to decode). See the UNVERIFIED note above.
 */
function xlogPayload(bytes: Uint8Array): string | undefined {
  if (bytes.length === 0 || bytes[0] !== XLOG_DATA) return undefined; // keepalive ('k') or other

  return Buffer.from(bytes.subarray(XLOG_DATA_HEADER_BYTES)).toString("utf8");
}

/**
 * Build a factory that mints a fresh dedicated logical-replication client from `config`.
 *
 * The source calls this on `start` and on every reconnect (a dropped stream needs a brand-new
 * connection). The client is opened in `replication: 'database'` mode and speaks the four
 * replication commands the seam needs; changes arrive as `wal2json` copy-data and are decoded to
 * {@link DecodedChange} (identity stamping is the source's job, not this file's).
 */
export function createPgReplicationClientFactory(
  config: PgReplicationConfig,
  plugin = "wal2json",
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
        // IDENTIFY_SYSTEM returns one row: { systemid, timeline, xlogpos, dbname }.
        const { rows } = await raw.query("IDENTIFY_SYSTEM");
        const row = rows[0] ?? {};

        return { systemId: String(row.systemid), timelineId: Number(row.timeline) };
      },

      async createSlot(slot: string): Promise<void> {
        // A logical slot with the configured output plugin; persists until dropped.
        await raw.query(`CREATE_REPLICATION_SLOT ${slot} LOGICAL ${plugin}`);
      },

      async dropSlot(slot: string): Promise<void> {
        await raw.query(`DROP_REPLICATION_SLOT ${slot}`);
      },

      async startReplication(slot: string, startLsn?: string): Promise<void> {
        // A replication command takes no bind parameters, so `startLsn` is interpolated — it MUST
        // be validated first (Inc4 makes it client-presented; a bad value is an injection vector).
        if (startLsn !== undefined && !LSN_PATTERN.test(startLsn)) {
          throw new Error(`Invalid replication start LSN: ${startLsn}`);
        }

        const lsn = startLsn ?? "0/0"; // `0/0` lets the server resume from the slot's confirmed position.

        // Decode each copy-data frame: unwrap the XLogData header, JSON-parse the wal2json batch,
        // and decode each change. wal2json emits one object per transaction with a `nextlsn` (the
        // commit position — required for the Inc4 cursor, hence `include-lsn`) and a `change[]`.
        raw.on("copyData", (...args: readonly unknown[]) => {
          const arg = args[0] as { chunk?: Uint8Array } | Uint8Array | undefined;
          const bytes = arg instanceof Uint8Array ? arg : arg?.chunk;

          if (bytes === undefined) return;

          const json = xlogPayload(bytes);

          if (json === undefined) return; // keepalive / non-XLogData frame

          const batch = JSON.parse(json) as {
            nextlsn?: string;
            change?: readonly Wal2JsonChange[];
          };
          const commitLSN = batch.nextlsn ?? "0/0";

          for (const change of batch.change ?? [])
            changeListener?.(decodeWal2JsonChange(change, commitLSN));
        });

        // `include-lsn` makes wal2json stamp each batch's commit LSN (`nextlsn`); without it the
        // Inc4 resume cursor would silently be a constant.
        await raw.query(`START_REPLICATION SLOT ${slot} LOGICAL ${lsn} ("include-lsn" 'on')`);
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

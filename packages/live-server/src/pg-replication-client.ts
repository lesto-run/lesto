/**
 * The real `pg` logical-replication client for the Tier-4 change source (ADR 0042) — the
 * coverage-excluded socket wiring. Every DECISION the source makes (reconnect/backoff, the slot
 * lifecycle, identity stamping, error routing) is tested in `replication.ts` against the
 * {@link PgReplicationClient} seam, and the pure message decoders are tested against **real
 * captured bytes** in `pgoutput.ts` / `wal2json.ts`; what remains here is the irreducible
 * replication-protocol wiring — the copy-data stream, its `XLogData` framing, and standby-status
 * (LSN acknowledgement) feedback — which has nothing to exercise but a live Postgres WAL stream.
 *
 * `pg` is an **optional peer**: a deployment using the Postgres change source installs it. It is
 * loaded lazily inside the factory (never imported at module top) so an app on the SQLite v0 poll
 * never needs `pg` on disk just to import `@lesto/live-server`. (Mirrors `@lesto/pg`'s
 * `pg-driver.ts` and `@lesto/realtime`'s `pg-client.ts`.)
 *
 * **Validated against a live Postgres (2026-07-01, L-4b7edd48).** The shakeout corrected two things
 * a docs-only reading got wrong and one it was right about:
 *   - **copy-data surfaces on `client.connection`, NOT `client`** — node-postgres does not re-emit
 *     replication `copyData` on the high-level `Client`. Listening on `raw.on("copyData")` (the
 *     first draft) received **nothing**; the events are on `raw.connection`.
 *   - **the consumer MUST send Standby Status Updates** acknowledging the applied LSN, or the slot
 *     never advances its `confirmed_flush_lsn` and pins WAL forever — the disk-fill outage the
 *     source claims to guard, made real. We ack after each applied frame and on a reply-requested
 *     keepalive.
 *   - the `XLogData` (`'w'`, 25-byte header) / keepalive (`'k'`) framing was right.
 *
 * **Decoder / plugin.** Default is **`pgoutput`** — built into core Postgres (no server extension),
 * so it runs on managed providers where `wal2json` is absent (the shakeout confirmed
 * `debezium/postgres` ships no `wal2json`). `wal2json` stays selectable where the extension is
 * installed; its decoder is unit-tested but was not live-validated here (no plugin in the env).
 * pgoutput needs a **publication** (a deployment/migration concern, like the slot and REPLICA
 * IDENTITY FULL) naming the tables to stream; this client references it, it does not create it.
 *
 * **Operational requirements** (ADR 0042 *Consequences*):
 *  - **`REPLICA IDENTITY FULL`** on every shape-backing table whose predicate references a non-PK
 *    column, or the old image is key-only and delete-from-shape silently leaks (the shape engine
 *    guards this at registration — Inc2 — via the catalog, since the stream cannot signal it).
 *  - A logical-replication slot **pins WAL** until acknowledged (see standby status, above): the
 *    source drops it on stop, and the deployment owns slot-lag alerting + the disk-pressure runbook.
 */

import { createRequire } from "node:module";

import { createPgOutputDecoder } from "./pgoutput";
import type { DecodedChange, PgReplicationClient, SystemIdentity } from "./replication";
import { decodeWal2JsonChange, type Wal2JsonChange } from "./wal2json";

/** Connection config for the dedicated replication client — a libpq URL or field set. */
export type PgReplicationConfig =
  | string
  | { readonly connectionString?: string; readonly [key: string]: unknown };

/** Tuning for the real client: the output plugin and (for pgoutput) the publication to stream. */
export interface PgReplicationClientOptions {
  /** The logical-decoding output plugin. Defaults to `pgoutput` (core, portable). */
  readonly plugin?: "pgoutput" | "wal2json";

  /** The publication naming the tables pgoutput streams (a deployment concern). Defaults to `lesto_publication`. */
  readonly publication?: string;
}

/** The underlying node-postgres connection — where replication copy-data actually surfaces. */
interface RawConnection {
  on(event: "copyData", listener: (message: { chunk: Buffer }) => void): unknown;
  once(event: "replicationStart", listener: () => void): unknown;
  sendCopyFromChunk(chunk: Buffer): void;
}

/** The slice of a raw `pg.Client` this wiring drives — typed structurally to avoid a `pg` type dep. */
interface RawPgClient {
  connect(): Promise<void>;
  query(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: ReadonlyArray<Record<string, unknown>> }>;
  on(event: string, listener: (...args: readonly unknown[]) => void): unknown;
  end(): Promise<void>;
  readonly connection: RawConnection;
}

/** A Postgres LSN is `<hex>/<hex>`; a client-presented resume position MUST match before it is
 * spliced into `START_REPLICATION` (a replication command cannot bind parameters). */
const LSN_PATTERN = /^[0-9A-Fa-f]+\/[0-9A-Fa-f]+$/;

const XLOG_DATA = 0x77; // 'w' — an XLogData frame: 'w' + Int64 walStart + Int64 walEnd + Int64 time + payload
const KEEPALIVE = 0x6b; // 'k' — a primary keepalive: 'k' + Int64 walEnd + Int64 time + Byte replyRequested
const XLOG_DATA_HEADER_BYTES = 1 + 8 + 8 + 8;

/** Milliseconds between the Unix epoch and the Postgres epoch (2000-01-01), for the status clock. */
const PG_EPOCH_MS = 946_684_800_000n;

/**
 * Build a factory that mints a fresh dedicated logical-replication client from `config`.
 *
 * The source calls this on `start` and on every reconnect (a dropped stream needs a brand-new
 * connection). The client is opened in `replication: 'database'` mode and speaks the four
 * replication commands the seam needs; changes arrive on the connection's copy-data stream, are
 * unwrapped from their `XLogData` frame, decoded to {@link DecodedChange}, and acknowledged back to
 * the server so the slot advances (identity stamping is the source's job, not this file's).
 */
export function createPgReplicationClientFactory(
  config: PgReplicationConfig,
  options: PgReplicationClientOptions = {},
): () => PgReplicationClient {
  const plugin = options.plugin ?? "pgoutput";
  const publication = options.publication ?? "lesto_publication";

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
    const decoder = plugin === "pgoutput" ? createPgOutputDecoder() : undefined;
    let lastLsn = 0n; // the high-water WAL position we have applied — acknowledged to the server

    /** Acknowledge `lastLsn` so the slot advances its confirmed position (else WAL pins forever). */
    function sendStandbyStatus(): void {
      const status = Buffer.alloc(1 + 8 + 8 + 8 + 8 + 1);
      status[0] = 0x72; // 'r' — Standby Status Update
      status.writeBigUInt64BE(lastLsn, 1); // last WAL byte received
      status.writeBigUInt64BE(lastLsn, 9); // last WAL byte flushed
      status.writeBigUInt64BE(lastLsn, 17); // last WAL byte applied
      status.writeBigUInt64BE((BigInt(Date.now()) - PG_EPOCH_MS) * 1000n, 25); // clock, µs since PG epoch
      status[33] = 0; // no immediate reply requested
      raw.connection.sendCopyFromChunk(status);
    }

    /** Decode one XLogData payload into zero or more changes (pgoutput: 0–1; wal2json: 0–N). */
    function decodePayload(payload: Buffer): DecodedChange[] {
      if (decoder !== undefined) {
        const change = decoder.decode(payload);

        return change === undefined ? [] : [change];
      }

      // wal2json: the payload is a JSON transaction batch with a commit `nextlsn` and `change[]`.
      const batch = JSON.parse(payload.toString("utf8")) as {
        nextlsn?: string;
        change?: readonly Wal2JsonChange[];
      };
      const commitLSN = batch.nextlsn ?? "0/0";

      return (batch.change ?? []).map((change) => decodeWal2JsonChange(change, commitLSN));
    }

    /** One copy-data frame: acknowledge its LSN, and (for an XLogData frame) decode + emit changes. */
    function onCopyData(bytes: Buffer): void {
      if (bytes.length === 0) return;

      const lead = bytes[0];

      if (lead === KEEPALIVE) {
        const walEnd = bytes.readBigUInt64BE(1);
        if (walEnd > lastLsn) lastLsn = walEnd;
        if (bytes.readUInt8(17) === 1) sendStandbyStatus(); // the server asked for a reply
        return;
      }

      if (lead !== XLOG_DATA) return; // an unknown frame — nothing to decode

      const walStart = bytes.readBigUInt64BE(1);
      if (walStart > lastLsn) lastLsn = walStart;

      for (const change of decodePayload(bytes.subarray(XLOG_DATA_HEADER_BYTES)))
        changeListener?.(change);

      sendStandbyStatus(); // advance the slot past what we just applied
    }

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
        // A logical slot cannot be dropped on its own streaming connection (a same-connection
        // DROP_REPLICATION_SLOT deadlocks against the running COPY — proven by the live shakeout)
        // and must be INACTIVE to drop. The source ends the streaming connection before calling
        // this, so drop from a FRESH normal connection, terminating any lingering walsender and
        // retrying until the slot releases (the walsender exits a beat after the socket closes).
        const admin = new Client(base);

        await admin.connect();

        try {
          for (let attempt = 0; attempt < 40; attempt++) {
            const { rows } = await admin.query(
              "SELECT active FROM pg_replication_slots WHERE slot_name = $1",
              [slot],
            );

            if (rows.length === 0) return; // already gone

            if (rows[0]!.active !== true) {
              await admin.query("SELECT pg_drop_replication_slot($1)", [slot]);

              return;
            }

            await admin.query(
              "SELECT pg_terminate_backend(active_pid) FROM pg_replication_slots WHERE slot_name = $1 AND active_pid IS NOT NULL",
              [slot],
            );
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        } finally {
          await admin.end();
        }
      },

      startReplication(slot: string, startLsn?: string): Promise<void> {
        // A replication command takes no bind parameters, so `startLsn` is interpolated — it MUST
        // be validated first (Inc4 makes it client-presented; a bad value is an injection vector).
        if (startLsn !== undefined && !LSN_PATTERN.test(startLsn)) {
          return Promise.reject(new Error(`Invalid replication start LSN: ${startLsn}`));
        }

        const lsn = startLsn ?? "0/0"; // `0/0` lets the server resume from the slot's confirmed position.
        // pgoutput needs its proto version + the publication naming the streamed tables; wal2json
        // needs include-lsn so each batch carries its commit position (the Inc4 cursor).
        const pluginOptions =
          plugin === "pgoutput"
            ? `(proto_version '1', publication_names '${publication}')`
            : `("include-lsn" 'on')`;

        // START_REPLICATION streams — its query promise never resolves — so wire the copy-data sink
        // and resolve when the server confirms replication has started. A command error rejects.
        return new Promise<void>((resolve, reject) => {
          raw.connection.on("copyData", (message) => onCopyData(message.chunk));
          raw.connection.once("replicationStart", () => resolve());
          raw.query(`START_REPLICATION SLOT ${slot} LOGICAL ${lsn} ${pluginOptions}`).catch(reject);
        });
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

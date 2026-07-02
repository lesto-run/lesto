/**
 * The real `pg` logical-replication client for the Tier-4 change source (ADR 0042) — the
 * coverage-excluded socket wiring. Every DECISION the source makes (reconnect/backoff, the slot
 * lifecycle, identity stamping, error routing) is tested in `replication.ts` against the
 * {@link PgReplicationClient} seam; the pure message decoder is tested against **real captured
 * bytes** in `pgoutput.ts`; and the pure *byte codecs* — the outbound standby-status (LSN
 * acknowledgement) encoder and the inbound copy-data / `XLogData` frame dispatcher — are extracted
 * to the covered {@link buildStandbyStatus}/{@link parseCopyDataFrame} in `replication-frames.ts`,
 * unit-tested against exact bytes like the decode side. What remains here is the irreducible
 * `pg` wiring — opening the client, listening on `raw.connection`, and pushing/pulling copy-data
 * chunks — which has nothing to exercise but a live Postgres WAL stream (validated by the live
 * shakeout, `test/live/pgoutput-shakeout.ts`).
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
 * **Decoder.** **`pgoutput`** — built into core Postgres (no server extension), so it runs on
 * managed providers where a third-party plugin is absent (the shakeout confirmed
 * `debezium/postgres` ships no `wal2json`). It is the only decoder: `pgoutput` is a strict
 * superset of what any deployment needs (core in every PG ≥ 10), so a second plugin only added an
 * unproven code path AND a value-encoding split — `pgoutput` decodes column values as **text**
 * (`"42"`), where `wal2json` would pass native JSON (`42`), breaking the single {@link DecodedChange}
 * contract Inc2's engine relies on. A future alternate decoder is a small re-add *behind the
 * {@link PgReplicationClient} seam*, with its own live shakeout and a contract that it stringify to
 * match. pgoutput needs a **publication** (a deployment/migration concern, like the slot and REPLICA
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

import { LiveServerError } from "./errors";
import { createPgOutputDecoder } from "./pgoutput";
import { buildStandbyStatus, PG_EPOCH_MS, parseCopyDataFrame } from "./replication-frames";
import type { DecodedChange, PgReplicationClient, SystemIdentity } from "./replication";

/** Connection config for the dedicated replication client — a libpq URL or field set. */
export type PgReplicationConfig =
  | string
  | { readonly connectionString?: string; readonly [key: string]: unknown };

/** Tuning for the real client. */
export interface PgReplicationClientOptions {
  /** The publication naming the tables `pgoutput` streams (a deployment concern). Defaults to `lesto_publication`. */
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

/** The bounded slot-drop retry: poll `SLOT_DROP_ATTEMPTS` times, `SLOT_DROP_POLL_MS` apart (~2s). */
const SLOT_DROP_ATTEMPTS = 40;
const SLOT_DROP_POLL_MS = 50;

/**
 * How long `START_REPLICATION` may take to begin streaming before `start()` rejects. The command
 * accepted-but-then-silent case (a partition after send, a wedged walsender) would otherwise hang
 * the source forever; a reject lets the caller / reconnect loop recover. Generous — start is
 * near-instant in practice.
 */
const REPLICATION_START_TIMEOUT_MS = 30_000;

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
    let errorListener: ((error: unknown) => void) | undefined;
    const decoder = createPgOutputDecoder();
    let lastLsn = 0n; // the high-water WAL position we have applied — acknowledged to the server

    /** Acknowledge `lastLsn` so the slot advances its confirmed position (else WAL pins forever). */
    function sendStandbyStatus(): void {
      const clockUs = (BigInt(Date.now()) - PG_EPOCH_MS) * 1000n; // µs since the PG epoch
      raw.connection.sendCopyFromChunk(buildStandbyStatus(lastLsn, clockUs));
    }

    /** One copy-data frame: acknowledge its LSN, and (for an XLogData frame) decode + emit a change. */
    function onCopyData(bytes: Buffer): void {
      // This runs synchronously from node-postgres's `copyData` listener, so a throw (a decoder
      // refusal, or a RangeError on a truncated/garbage frame) would escape UNCAUGHT into the
      // driver's EventEmitter and can crash the process. Route it to the error sink instead, and
      // do NOT advance the ack past a frame we could not apply (so a reconnect re-reads it).
      try {
        const frame = parseCopyDataFrame(bytes);

        if (frame.kind === "keepalive") {
          if (frame.walEnd > lastLsn) lastLsn = frame.walEnd;
          if (frame.replyRequested) sendStandbyStatus(); // the server asked for a reply
          return;
        }

        if (frame.kind === "other") return; // an empty or unknown frame — nothing to decode

        if (frame.walStart > lastLsn) lastLsn = frame.walStart;

        // pgoutput decodes each XLogData payload to 0–1 changes (a control message → none).
        const change = decoder.decode(frame.payload);
        if (change !== undefined) changeListener?.(change);

        sendStandbyStatus(); // advance the slot past what we just applied
      } catch (error) {
        errorListener?.(error);
      }
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
        // A logical slot decoded by `pgoutput` (core); persists until dropped.
        await raw.query(`CREATE_REPLICATION_SLOT ${slot} LOGICAL pgoutput`);
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
          for (let attempt = 0; attempt < SLOT_DROP_ATTEMPTS; attempt++) {
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
            await new Promise((resolve) => setTimeout(resolve, SLOT_DROP_POLL_MS));
          }

          // The slot stayed active for the whole bounded retry. Do NOT return quietly — a
          // silently-undropped slot pins WAL and is the disk-fill outage this module owns. Throw a
          // coded error so the source routes it to its error sink (`#dropSlot` catches + reports).
          throw new LiveServerError(
            "LIVE_SERVER_REPLICATION_SLOT_DROP_TIMEOUT",
            `Could not drop replication slot "${slot}": still active after ${SLOT_DROP_ATTEMPTS} attempts (~${(SLOT_DROP_ATTEMPTS * SLOT_DROP_POLL_MS) / 1000}s); its WAL will accumulate.`,
            { slot },
          );
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
        // pgoutput needs its proto version + the publication naming the streamed tables.
        const pluginOptions = `(proto_version '1', publication_names '${publication}')`;

        // START_REPLICATION streams — its query promise never resolves — so wire the copy-data sink
        // and resolve when the server confirms replication has started. A command error rejects; a
        // bounded timeout rejects the accepted-but-then-silent case so `start()` can't hang forever.
        return new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            reject(
              new Error(`START_REPLICATION did not begin within ${REPLICATION_START_TIMEOUT_MS}ms`),
            );
          }, REPLICATION_START_TIMEOUT_MS);
          (timer as { unref?: () => void }).unref?.(); // a pending start must not keep the process alive

          raw.connection.on("copyData", (message) => onCopyData(message.chunk));
          raw.connection.once("replicationStart", () => {
            clearTimeout(timer);
            resolve();
          });
          raw
            .query(`START_REPLICATION SLOT ${slot} LOGICAL ${lsn} ${pluginOptions}`)
            .catch((error: unknown) => {
              clearTimeout(timer);
              reject(error as Error);
            });
        });
      },

      on(event: "change" | "error", listener: (arg: never) => void): unknown {
        if (event === "change") {
          changeListener = listener as (change: DecodedChange) => void;
        } else {
          // Capture the error sink so a decode failure in `onCopyData` can route to it too (not
          // only a raw socket error), then wire the same listener to the driver's error event.
          errorListener = listener as (error: unknown) => void;
          raw.on("error", listener as (...args: readonly unknown[]) => void);
        }

        return this;
      },

      end: () => raw.end(),
    };
  };
}

/**
 * The pure byte codecs for the Postgres logical-replication copy-data stream (ADR 0042 Tier 4) —
 * the outbound **Standby Status Update** encoder and the inbound **CopyData** frame dispatcher.
 *
 * These are the socket-free halves of `pg-replication-client.ts`. That file is the irreducible
 * `pg` socket wiring (coverage-excluded, like `@lesto/pg`'s `pg-driver.ts`); its byte logic is
 * NOT irreducible — it is exact wire math with a load-bearing failure mode, so it lives here where
 * it is unit-tested against the same real captured bytes the decode side (`pgoutput.ts`) is. The
 * **Standby Status Update** in particular is the module's disk-fill guard: without a correctly
 * encoded LSN acknowledgement the slot never advances its `confirmed_flush_lsn` and pins WAL
 * forever — so its byte layout earns a covered test, not an excluded one.
 *
 * Both are **pure**: bytes (and, for the status, a caller-supplied clock so `Date.now()` stays in
 * the excluded wiring) in, bytes / a discriminated frame out. No `pg`, no socket.
 *
 * Wire reference: PG streaming-replication protocol — a walsender sends CopyData frames tagged by a
 * leading byte (`'w'` XLogData, `'k'` Primary keepalive, others we ignore); the consumer replies
 * with `'r'` Standby Status Update frames.
 */

/** Milliseconds between the Unix epoch and the Postgres epoch (2000-01-01), for the status clock. */
export const PG_EPOCH_MS = 946_684_800_000n;

const STANDBY_STATUS_UPDATE = 0x72; // 'r' — the consumer's LSN-acknowledgement reply
const XLOG_DATA = 0x77; // 'w' — an XLogData frame: 'w' + Int64 walStart + Int64 walEnd + Int64 time + payload
const KEEPALIVE = 0x6b; // 'k' — a primary keepalive: 'k' + Int64 walEnd + Int64 time + Byte replyRequested

/** Bytes of the XLogData frame header before the `pgoutput` payload begins (`'w'` + three Int64s). */
export const XLOG_DATA_HEADER_BYTES = 1 + 8 + 8 + 8;

/**
 * Encode a **Standby Status Update** (`'r'`) acknowledging `lastLsn` as received/flushed/applied,
 * stamped with `clockUs` (microseconds since the Postgres epoch — the caller supplies it so the
 * impure `Date.now()` stays out of this pure function). Sending this is what advances the slot's
 * confirmed position; skip it and WAL pins forever (the disk-fill outage this module guards).
 */
export function buildStandbyStatus(lastLsn: bigint, clockUs: bigint): Buffer {
  const status = Buffer.alloc(1 + 8 + 8 + 8 + 8 + 1);
  status[0] = STANDBY_STATUS_UPDATE;
  status.writeBigUInt64BE(lastLsn, 1); // last WAL byte + 1 received
  status.writeBigUInt64BE(lastLsn, 9); // last WAL byte + 1 flushed
  status.writeBigUInt64BE(lastLsn, 17); // last WAL byte + 1 applied
  status.writeBigUInt64BE(clockUs, 25); // client clock, µs since the PG epoch
  status[33] = 0; // no immediate reply requested

  return status;
}

/** One dispatched CopyData frame: a keepalive, an XLogData payload, or an ignorable other frame. */
export type CopyDataFrame =
  | {
      /** A primary keepalive — carries the server's WAL end and whether it wants an immediate reply. */
      readonly kind: "keepalive";
      readonly walEnd: bigint;
      readonly replyRequested: boolean;
    }
  | {
      /** An XLogData frame — its WAL start position and the bare `pgoutput` message (header stripped). */
      readonly kind: "xlog";
      readonly walStart: bigint;
      readonly payload: Buffer;
    }
  | {
      /** Anything else (CopyDone, an unknown tag, or an empty frame) — nothing for the client to do. */
      readonly kind: "other";
    };

/**
 * Dispatch one raw CopyData frame by its leading tag byte. Pure: it only reads fields off `bytes`
 * (the caller advances its acknowledged LSN and decodes the payload). An empty or unknown frame is
 * `"other"` — the same no-op the streaming client took inline before this was extracted.
 */
export function parseCopyDataFrame(bytes: Buffer): CopyDataFrame {
  const lead = bytes[0];

  if (lead === KEEPALIVE) {
    return {
      kind: "keepalive",
      walEnd: bytes.readBigUInt64BE(1),
      replyRequested: bytes.readUInt8(17) === 1, // the server asked for an immediate ack
    };
  }

  if (lead === XLOG_DATA) {
    return {
      kind: "xlog",
      walStart: bytes.readBigUInt64BE(1),
      payload: bytes.subarray(XLOG_DATA_HEADER_BYTES),
    };
  }

  return { kind: "other" };
}

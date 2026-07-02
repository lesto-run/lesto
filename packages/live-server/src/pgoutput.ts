/**
 * The pure `pgoutput` → {@link DecodedChange} decoder (ADR 0042 Tier 4, v1 Inc1 hardening).
 *
 * `pgoutput` is Postgres's **built-in** logical-decoding output plugin (core since PG 10, no
 * server extension) — unlike `wal2json`, which is a third-party plugin absent from many managed
 * providers (a live shakeout confirmed it is missing from `debezium/postgres`). So pgoutput is the
 * portable **default** decoder for "runs on YOUR Postgres"; the `wal2json` decoder stays as an
 * opt-in where the extension is installed. Both map to the SAME {@link DecodedChange}, behind the
 * real client's decoder switch.
 *
 * This module is **pure** — a `pgoutput` message (the payload of one `XLogData` copy-data frame,
 * header already stripped) in, a `DecodedChange` (or `undefined` for a control message) out, no
 * `pg`, no socket — so it is unit-tested to the 100% bar against **real captured bytes** (the repo
 * convention: only the irreducible socket wiring is coverage-excluded). It is stateful across a
 * stream (a relation-OID → columns cache, and the current transaction's commit LSN from `Begin`),
 * so callers use ONE decoder per connection and feed it every message in order.
 *
 * **Values are TEXT-encoded** (pgoutput protocol v1 sends every column as its text representation),
 * so a `room_id int` arrives as `"42"`, not `42` — a real difference from `wal2json`'s native JSON
 * types. The shape engine (Inc2) already projects + normalizes per column type; it must coerce
 * these text values, and must not assume a decoder produces native JS types.
 *
 * Protocol reference: PG logical replication message formats (`Begin`/`Relation`/`Insert`/
 * `Update`/`Delete`/`Commit`/…) + `TupleData`. Only row-producing messages yield a change;
 * `Begin` sets the commit LSN, `Relation` populates the column cache, everything else is skipped.
 */

import { LiveServerError } from "./errors";
import type { DecodedChange, OldImageKind, RowImage } from "./replication";

/** Format a 64-bit WAL position as the canonical Postgres `HI/LO` upper-hex LSN string. */
function formatLsn(lsn: bigint): string {
  return `${(lsn >> 32n).toString(16).toUpperCase()}/${(lsn & 0xffffffffn).toString(16).toUpperCase()}`;
}

/** A cached relation: the (unqualified) table name and its column names, in wire order. */
interface Relation {
  readonly table: string;
  readonly columns: readonly string[];
}

/** A forward cursor over one pgoutput message — big-endian, like the Postgres wire protocol. */
class Reader {
  #offset = 0;

  constructor(private readonly buf: Buffer) {}

  uint8(): number {
    const value = this.buf.readUInt8(this.#offset);
    this.#offset += 1;

    return value;
  }

  uint32(): number {
    const value = this.buf.readUInt32BE(this.#offset);
    this.#offset += 4;

    return value;
  }

  int16(): number {
    const value = this.buf.readInt16BE(this.#offset);
    this.#offset += 2;

    return value;
  }

  bigUint64(): bigint {
    const value = this.buf.readBigUInt64BE(this.#offset);
    this.#offset += 8;

    return value;
  }

  /** A NUL-terminated C string. */
  cstring(): string {
    const end = this.buf.indexOf(0, this.#offset);

    // No terminator before the frame ended: `indexOf` returns -1, and `toString(_, _, -1)` would
    // yield '' while rewinding the cursor to 0 — silently corrupting every later read. Refuse.
    if (end === -1) {
      throw new LiveServerError(
        "LIVE_SERVER_REPLICATION_MALFORMED_FRAME",
        `pgoutput frame ended before a C string's NUL terminator (offset ${this.#offset}).`,
        { offset: this.#offset },
      );
    }

    const value = this.buf.toString("utf8", this.#offset, end);
    this.#offset = end + 1;

    return value;
  }

  bytes(length: number): Buffer {
    const end = this.#offset + length;

    // A `subarray` past the buffer's end CLAMPS silently — the truncation surfaces only as a bare
    // `RangeError` on the next read. Bound-check here so an overlong length prefix is a coded error.
    if (end > this.buf.length) {
      throw new LiveServerError(
        "LIVE_SERVER_REPLICATION_MALFORMED_FRAME",
        `pgoutput frame claims a ${length}-byte value at offset ${this.#offset} but only ${this.buf.length - this.#offset} byte(s) remain.`,
        { offset: this.#offset, length, remaining: this.buf.length - this.#offset },
      );
    }

    const value = this.buf.subarray(this.#offset, end);
    this.#offset = end;

    return value;
  }
}

/** Decodes an ordered `pgoutput` message stream to {@link DecodedChange}s. One per connection. */
export interface PgOutputDecoder {
  /** Decode one message; `undefined` for a control message that produces no row change. */
  decode(message: Uint8Array): DecodedChange | undefined;
}

/**
 * A `TupleData` message body: `Int16` column count, then per column a kind byte — `n` (null),
 * `u` (unchanged TOAST, not transmitted), or `t`/`b` (a length-prefixed text/binary value). Maps
 * each to its column name from the relation. `u` becomes `undefined` (the value was not sent).
 */
function readTuple(reader: Reader, columns: readonly string[]): RowImage {
  const count = reader.int16();
  const image: RowImage = {};

  for (let i = 0; i < count; i++) {
    const kind = reader.uint8();
    const column = columns[i]!;

    if (kind === 0x6e /* 'n' */) {
      image[column] = null;
    } else if (kind === 0x75 /* 'u' */) {
      image[column] = undefined;
    } else {
      // 't' (text) or 'b' (binary) — both an Int32 length then that many bytes.
      const length = reader.uint32();
      image[column] = reader.bytes(length).toString("utf8");
    }
  }

  return image;
}

export function createPgOutputDecoder(): PgOutputDecoder {
  const relations = new Map<number, Relation>();
  let commitLSN = "0/0";

  /** Resolve a relation from its OID, or refuse — pgoutput always sends `Relation` before a change. */
  function relation(oid: number): Relation {
    const found = relations.get(oid);

    if (found === undefined) {
      throw new LiveServerError(
        "LIVE_SERVER_REPLICATION_UNKNOWN_RELATION",
        `pgoutput sent a change for relation OID ${oid} before its Relation message.`,
        { oid },
      );
    }

    return found;
  }

  return {
    decode(message: Uint8Array): DecodedChange | undefined {
      const reader = new Reader(Buffer.isBuffer(message) ? message : Buffer.from(message));
      const type = reader.uint8();

      switch (type) {
        case 0x42 /* 'B' Begin */: {
          // Int64 finalLSN (the transaction's commit LSN — every change until Commit is stamped
          // with it), then Int64 commit timestamp + Int32 xid (unused here).
          commitLSN = formatLsn(reader.bigUint64());

          return undefined;
        }

        case 0x52 /* 'R' Relation */: {
          const oid = reader.uint32();
          reader.cstring(); // namespace (e.g. "public") — the shape names the unqualified table
          const table = reader.cstring();
          reader.uint8(); // replica identity setting — the engine validates this via the catalog
          const columnCount = reader.int16();
          const columns: string[] = [];

          for (let i = 0; i < columnCount; i++) {
            reader.uint8(); // column flags (1 = part of the key)
            columns.push(reader.cstring());
            reader.uint32(); // data type OID
            reader.uint32(); // atttypmod
          }

          relations.set(oid, { table, columns });

          return undefined;
        }

        case 0x49 /* 'I' Insert */: {
          const { table, columns } = relation(reader.uint32());
          reader.uint8(); // 'N' — the new-tuple marker
          const newImage = readTuple(reader, columns);

          return { op: "insert", table, commitLSN, newImage };
        }

        case 0x55 /* 'U' Update */: {
          const { table, columns } = relation(reader.uint32());
          let oldImage: RowImage = {};
          let oldImageKind: OldImageKind = "none";
          let marker = reader.uint8();

          // An optional old tuple: 'O' (full old row, only under REPLICA IDENTITY FULL) or 'K'
          // (key columns only). Absent under the default replica identity when the key did not
          // change — then oldImage stays {} and the marker stays 'none'. The marker (not the
          // decoded cell values) is what the classifier's runtime guard trusts: a 'K' tuple fills
          // its non-identity columns with null, indistinguishable by value from a genuine null.
          if (marker === 0x4f /* 'O' */ || marker === 0x4b /* 'K' */) {
            oldImageKind = marker === 0x4f ? "full" : "key";
            oldImage = readTuple(reader, columns);
            marker = reader.uint8();
          }

          // The marker MUST now be 'N' (the new tuple). Any other byte means the cursor is
          // misaligned — assuming 'N' and reading on would decode garbage, so refuse it loudly.
          if (marker !== 0x4e /* 'N' */) {
            throw new LiveServerError(
              "LIVE_SERVER_REPLICATION_MALFORMED_FRAME",
              `pgoutput Update expected the new-tuple 'N' marker but read byte 0x${marker.toString(16)}.`,
              { marker },
            );
          }

          const newImage = readTuple(reader, columns);

          return { op: "update", table, commitLSN, newImage, oldImage, oldImageKind };
        }

        case 0x44 /* 'D' Delete */: {
          const { table, columns } = relation(reader.uint32());
          // 'O' (full old row) or 'K' (key only) — a delete always carries one, never absent.
          const oldImageKind: OldImageKind = reader.uint8() === 0x4f /* 'O' */ ? "full" : "key";
          const oldImage = readTuple(reader, columns);

          return { op: "delete", table, commitLSN, oldImage, oldImageKind };
        }

        default:
          // Commit / Origin / Type / Truncate / Message / logical-streaming frames — no row change.
          return undefined;
      }
    },
  };
}

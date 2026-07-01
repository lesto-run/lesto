/**
 * The pure `wal2json` → {@link DecodedChange} decode (ADR 0042 Tier 4, v1 Inc1).
 *
 * This is the JSON-object mapping step of the real replication client, split out from the
 * socket wiring ({@link file://./pg-replication-client.ts}) precisely because it is **pure** —
 * a plain `Wal2JsonChange` in, a `DecodedChange` out, no `pg`, no socket — and therefore the
 * one part of the decode that CAN and MUST be tested to the 100% bar (the repo convention: only
 * the irreducible driver wiring is coverage-excluded, `@lesto/pg`'s `pg-driver.ts` doc). The
 * op→image correlation and the `REPLICA IDENTITY FULL` old-image dependency live here, so here
 * is exactly where the tests belong.
 *
 * `wal2json` is the first real decoder; `pgoutput` (core, no server extension) is the
 * portability-preferred follow-up — it decodes to the SAME {@link DecodedChange}, so a second
 * `decodePgOutputChange` would sit beside this behind the same seam (see the real client's doc).
 */

import type { DecodedChange, RowImage } from "./replication";

/** One `wal2json` change object, as the plugin emits it inside a transaction's `change[]`. */
export interface Wal2JsonChange {
  readonly kind: "insert" | "update" | "delete";
  readonly table: string;
  readonly columnnames?: readonly string[];
  readonly columnvalues?: readonly unknown[];
  readonly oldkeys?: {
    readonly keynames: readonly string[];
    readonly keyvalues: readonly unknown[];
  };
}

/** Zip `wal2json`'s parallel name/value arrays into a {@link RowImage} (column name → value). */
export function zipImage(names: readonly string[], values: readonly unknown[]): RowImage {
  const image: RowImage = {};

  for (let i = 0; i < names.length; i++) image[names[i]!] = values[i];

  return image;
}

/**
 * Map one `wal2json` change to a {@link DecodedChange}, stamping the batch's `commitLSN`.
 * Insert carries only `newImage`, delete only `oldImage`, update **both** — modeled exactly as
 * the seam requires.
 *
 * The `oldImage` is only as complete as the table's replica identity: under `REPLICA IDENTITY
 * FULL` it is the full old row; otherwise `wal2json` emits `oldkeys` as the primary key only (or
 * omits it → `{}`), and **this decode cannot tell the difference** — a degraded old image looks
 * like a complete one. That is by design: per ADR 0042 the guard is the shape engine's, which
 * refuses (at registration) a shape whose table cannot supply the old image its predicate needs
 * (Inc2). Inc2 must therefore validate replica identity via the catalog, never trust the stream.
 */
export function decodeWal2JsonChange(change: Wal2JsonChange, commitLSN: string): DecodedChange {
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

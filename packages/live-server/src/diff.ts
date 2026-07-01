/**
 * The pure keyed-diff core — the heart of change detection, decoupled from the poll
 * loop and the database so every branch is unit-testable.
 *
 * Given the previous authorized row set (keyed) and the next one (the shape's rows
 * *after* projection, wire-normalization, and the membership filter), it emits the
 * minimal {@link ShapeChange} list: a key only in `next` is an `insert`, a key in both
 * whose row changed is an `update`, a key only in `prev` is a `delete` — the
 * *delete-from-shape* that keeps the client's local slice exactly the authorized set.
 *
 * Rows are compared and shipped in their **wire form**: {@link normalizeWire} folds a
 * hydrated `Date` down to epoch-ms so (a) two equal timestamps are `===`-equal and never
 * emit a spurious update, and (b) the value the client stores matches the value the
 * server filtered/sorted on — server and client evaluate `matchesShape`/`compareRows`
 * over the *same* scalar types.
 */

import { rowKey } from "@lesto/live-protocol";
import type { Row, RowKey, ShapeChange, ShapeDefinition } from "@lesto/live-protocol";

/** Keep exactly the shape's projected columns, dropping any the shape did not select. */
export function projectRow(row: Row, columns: readonly string[]): Row {
  const out: Row = {};

  for (const column of columns) out[column] = row[column];

  return out;
}

/**
 * Fold a hydrated row down to its JSON wire scalars — a `Date` becomes epoch-ms (matching
 * how `@lesto/db` stores a timestamp), every other value passes through. This is the exact
 * form both the diff and the client see, so their comparisons agree.
 */
export function normalizeWire(row: Row): Row {
  const out: Row = {};

  for (const [key, value] of Object.entries(row)) {
    out[key] = value instanceof Date ? value.getTime() : value;
  }

  return out;
}

/** Value-equality over two wire rows: same keys, each cell `Object.is`-equal. */
function rowEquals(a: Row, b: Row): boolean {
  const aKeys = Object.keys(a);

  if (aKeys.length !== Object.keys(b).length) return false;

  return aKeys.every((key) => Object.is(a[key], b[key]));
}

/** The result of one diff: the changes to fan out, and the next keyed set to remember. */
export interface DiffResult {
  readonly changes: readonly ShapeChange[];
  readonly next: Map<RowKey, Row>;
}

/**
 * Diff the previous keyed set against the next rows (already projected + wire-normalized +
 * membership-filtered). Inserts/updates come first in `next` order, deletes last in `prev`
 * order — a deterministic, testable change stream.
 */
export function diffRows(
  def: ShapeDefinition,
  prev: ReadonlyMap<RowKey, Row>,
  nextRows: readonly Row[],
): DiffResult {
  const next = new Map<RowKey, Row>();
  const changes: ShapeChange[] = [];

  for (const row of nextRows) {
    const key = rowKey(row, def.key);
    next.set(key, row);

    const before = prev.get(key);

    if (before === undefined) {
      changes.push({ op: "insert", key, row });
    } else if (!rowEquals(before, row)) {
      changes.push({ op: "update", key, row });
    }
    // A key present in both with an equal row is unchanged — no frame.
  }

  for (const key of prev.keys()) {
    if (!next.has(key)) changes.push({ op: "delete", key });
  }

  return { changes, next };
}

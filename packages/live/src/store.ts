/**
 * The in-memory keyed store — one shape's authorized row slice, held on the client
 * (ADR 0042 Tier 4, v0). The SSE consumer drives it; a UI reads it. Framework-agnostic
 * on purpose: it owns the row set and the change-notification, and knows nothing of
 * React, the network, or the wire codec.
 *
 * The store keeps rows in a `Map` keyed by the shape's row identity ({@link rowKey}) so a
 * `change` frame is an O(1) set/delete, and exposes them through {@link LiveStore.getRows}
 * in the shape's total order ({@link compareRows}) — the same order the server snapshotted
 * in, so the client's view matches byte-for-byte.
 *
 * The one non-obvious contract: `getRows()` returns a **stable array reference** between
 * mutations. A UI bound through `useSyncExternalStore` compares the snapshot by identity to
 * decide whether to re-render; handing back a fresh array on every read would loop it
 * forever. So the sorted array is cached and only recomputed after a mutation dirties it.
 */

import { compareRows, rowKey } from "@lesto/live-protocol";
import type { Cursor, Row, RowKey, ShapeChange, ShapeDefinition } from "@lesto/live-protocol";

/**
 * The client-side view of one shape: mutate it from the wire, read it from a UI.
 *
 * Every mutation carries the frame's opaque **resume cursor** ({@link Cursor}) — the
 * `(systemId, timelineId, LSN)` position the change was stamped at (ADR 0042 Inc4/Inc5).
 * The in-memory default holds it in a variable (lost on reload → a full re-snapshot next
 * open); the durable OPFS-SQLite store ({@link createSqliteLiveStore}) persists it in the
 * **same transaction** as the rows, so a crash can never leave the cursor ahead of the rows
 * it points past. The cursor is opaque here on purpose — the store round-trips it, never
 * parses it (the interpretation lives server-side; see `@lesto/live-server`).
 */
export interface LiveStore {
  /**
   * Replace the whole authorized set with a fresh snapshot (the `snapshot` frame), stamping
   * the local slice at the snapshot's `cursor` (omitted only by a caller that does not track
   * one — e.g. a plain test; the wire always supplies it).
   */
  applySnapshot(rows: readonly Row[], cursor?: Cursor): void;

  /**
   * Apply one change: `insert`/`update` set the row, `delete` (from-shape) removes it, and
   * either way advances the local cursor to the change's commit `cursor`.
   */
  applyChange(change: ShapeChange, cursor?: Cursor): void;

  /**
   * Drop the local slice AND its cursor, then await the next snapshot — the always-correct
   * floor on a resync. Clearing the cursor is deliberate: a resync abandons the local
   * position, so the next snapshot re-establishes both rows and cursor from scratch.
   */
  applyResync(): void;

  /** The rows in the shape's total order — a stable reference until the next mutation. */
  getRows(): readonly Row[];

  /**
   * The cursor of the last applied frame, or `undefined` before the first frame / after a
   * resync. The read-your-writes rule ("never accept a snapshot older than an LSN already
   * applied") reads this; the durable store returns the value that survived a reload.
   */
  getCursor(): Cursor | undefined;

  /** Register a listener fired after every mutation; returns its unsubscribe. */
  subscribe(listener: () => void): () => void;
}

/**
 * Build the in-memory store for a shape. Bound to the `def` so it can key rows
 * ({@link rowKey} over `def.key`) and sort them ({@link compareRows} over the shape's
 * total order) exactly as the server did.
 */
export function createLiveStore(def: ShapeDefinition): LiveStore {
  // The authorized set, keyed by row identity so a `change` is an O(1) set/delete.
  let rowsByKey = new Map<RowKey, Row>();

  // The lazily-recomputed sorted snapshot and its dirty flag. `getRows()` recomputes only
  // when a mutation has dirtied it, so between mutations it returns the SAME array — the
  // identity stability `useSyncExternalStore` needs to stop re-rendering.
  let cache: readonly Row[] = [];
  let dirty = true;

  // The last applied frame's cursor. In-memory it is "just a variable" (ADR 0042): lost on
  // reload, so a fresh open re-snapshots — correct, since an in-memory slice has no durable
  // rows to resume against.
  let cursor: Cursor | undefined;

  const listeners = new Set<() => void>();

  // After every mutation: the cache is stale and every subscriber must be told. Kept in
  // one place so no mutation can update state without also invalidating + notifying.
  const mutated = (): void => {
    dirty = true;

    for (const listener of listeners) listener();
  };

  return {
    applySnapshot(rows, nextCursor) {
      // Build into a fresh map and swap, so a bad row (a missing key throws in `rowKey`)
      // leaves the previous state intact for the consumer to resync from, never half-applied.
      const next = new Map<RowKey, Row>();

      for (const row of rows) next.set(rowKey(row, def.key), row);

      rowsByKey = next;
      cursor = nextCursor;
      mutated();
    },

    applyChange(change, nextCursor) {
      // Trust the change's decoded `key`: the server minted it as `rowKey(row, def.key)`,
      // so `insert`/`update` set under it and a delete-from-shape removes it.
      if (change.op === "delete") rowsByKey.delete(change.key);
      else rowsByKey.set(change.key, change.row);

      cursor = nextCursor;
      mutated();
    },

    applyResync() {
      rowsByKey = new Map();
      cursor = undefined;
      mutated();
    },

    getRows() {
      if (dirty) {
        cache = [...rowsByKey.values()].toSorted((a, b) => compareRows(def, a, b));
        dirty = false;
      }

      return cache;
    },

    getCursor() {
      return cursor;
    },

    subscribe(listener) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
  };
}

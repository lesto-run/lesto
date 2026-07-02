/**
 * The shared **read model** behind both `LiveStore` implementations ({@link createLiveStore}
 * and {@link createSqliteLiveStore}, ADR 0042 Tier 4) — the pieces the two stores used to
 * duplicate verbatim, now centralized so the one subtle contract has exactly one
 * implementation.
 *
 * What this module owns:
 *
 *   - The lazy sorted-cache + dirty flag behind {@link ReadModel.getRows}. **This is the
 *     `useSyncExternalStore` stable-array-identity contract**: a UI bound through it compares
 *     the snapshot by reference to decide whether to re-render, so handing back a fresh array
 *     on every read would loop it forever. The cache is therefore recomputed only when a
 *     mutation has dirtied it (via {@link ReadModel.mutated}), and returns the SAME reference
 *     between mutations.
 *   - The `listeners` set + {@link ReadModel.subscribe} + the {@link ReadModel.mutated} notify —
 *     one place, so a mutation can never dirty the cache without also notifying subscribers (or
 *     vice versa).
 *   - The cursor variable + {@link ReadModel.getCursor} + {@link ReadModel.setCursor}.
 *   - The **optimistic overlay** (ADR 0042 Tier 4, v1 Inc6) + {@link ReadModel.setOptimistic} /
 *     {@link ReadModel.clearOptimistic}. An offline (or in-flight) write is shown *over* the
 *     authorized set: {@link ReadModel.getRows} merges the wire-driven authorized rows with the
 *     overlay (an optimistic `insert`/`update` sets a row, a `delete` removes one), overlay-wins-
 *     by-key, before sorting. The authorized tier ({@link createReadModel}'s `getRowsSnapshot`
 *     source) stays untouched — driven ONLY by the wire — so the overlay is purely additive and a
 *     rollback is just `clearOptimistic` (the authorized row, which never carried the optimistic
 *     edit, shows through again). The overlay is derived state: its single source of truth is the
 *     outbox (`./outbox`), which sets an entry on submit and clears it on the mutation's ack/reject,
 *     and rebuilds the whole overlay from the durable log on reload — so nothing here is persisted.
 *
 * What it deliberately does NOT own: `rowsByKey`, the keyed row map. The two stores drive that
 * map through different mechanisms — {@link createLiveStore} swaps in a fresh `Map` on every
 * snapshot (so a bad row throws before any state is touched), while {@link createSqliteLiveStore}
 * clears and refills one long-lived mirror `Map` that a durable write also persists. Both are
 * build-then-commit, so unifying them behind a map-owning read model is possible but out of scope;
 * keeping the map in the stores is the conservative cut, and this module need not know which. Each
 * store hands in a `getRowsSnapshot` thunk over its OWN map, read fresh every time the cache is
 * dirtied, so `getRows()` always sorts the CURRENT rows via {@link compareRows} regardless of how
 * they got there.
 */

import { compareRows, rowKey } from "@lesto/live-protocol";
import type { Cursor, Row, RowKey, ShapeChange, ShapeDefinition } from "@lesto/live-protocol";

/**
 * The shared read/subscribe/cursor surface both `LiveStore` implementations delegate to. A
 * store composes one of these per shape and drives it from its own mutation methods: update
 * `rowsByKey`, call {@link setCursor}, then call {@link mutated} — in that order, every time.
 */
export interface ReadModel {
  /**
   * The rows in the shape's total order ({@link compareRows}) — a stable reference until the
   * next {@link mutated} call. Recomputes from `getRowsSnapshot` (passed to
   * {@link createReadModel}) only when dirtied.
   */
  getRows(): readonly Row[];

  /** The cursor last set via {@link setCursor}, or `undefined` before the first one / after a clear. */
  getCursor(): Cursor | undefined;

  /**
   * Record the last-applied frame's cursor (or clear it with `undefined`, e.g. on a resync).
   * Pure bookkeeping — call {@link mutated} separately to dirty the cache and notify.
   */
  setCursor(cursor: Cursor | undefined): void;

  /**
   * Overlay one optimistic change (an `insert`/`update` sets the row, a `delete` removes it) on
   * top of the authorized set — the local, not-yet-confirmed view of a write (ADR 0042 Inc6). Keyed
   * by the change's `key`, so re-submitting the same key replaces the pending entry. Pure
   * bookkeeping — call {@link mutated} after, exactly like {@link setCursor}.
   */
  setOptimistic(change: ShapeChange): void;

  /**
   * Drop the optimistic overlay entry for `key` — the write was confirmed (its authorized echo now
   * carries the truth) or rejected (roll back to the authorized row). A no-op when none is pending.
   * Pure bookkeeping — call {@link mutated} after.
   */
  clearOptimistic(key: RowKey): void;

  /** Register a listener fired after every {@link mutated} call; returns its unsubscribe. */
  subscribe(listener: () => void): () => void;

  /**
   * Dirty the sorted-row cache and notify every current subscriber. Call this exactly once per
   * mutation, after the store's own row map (and, via {@link setCursor}, the cursor) has already
   * been updated — so a listener that reads back through {@link getRows}/{@link getCursor}
   * during the notification sees the new state, not the stale one.
   */
  mutated(): void;
}

/**
 * Build a {@link ReadModel} for a shape. `getRowsSnapshot` is a thunk over the calling store's
 * OWN `rowsByKey` map, invoked fresh every time the cache is dirtied — so this module never
 * holds (or needs to know how the store drives) the map itself, only how to sort what it sees.
 */
export function createReadModel(
  def: ShapeDefinition,
  getRowsSnapshot: () => Iterable<Row>,
): ReadModel {
  // The lazily-recomputed sorted snapshot and its dirty flag — see the module doc for why this
  // stable-reference cache is the one contract that matters.
  let cache: readonly Row[] = [];
  let dirty = true;

  let cursor: Cursor | undefined;

  // The optimistic overlay (ADR 0042 Inc6): pending client writes keyed by row identity, merged
  // over the authorized set in `getRows`. Empty in the overwhelmingly common case — kept out of the
  // merge fast-path below so a store with no in-flight writes sorts exactly as it did pre-Inc6.
  const overlay = new Map<RowKey, ShapeChange>();

  const listeners = new Set<() => void>();

  return {
    getRows() {
      if (dirty) {
        // Fast path: no pending optimistic writes → sort the authorized rows verbatim, the exact
        // pre-Inc6 behavior (and the only path every non-writing consumer ever takes).
        if (overlay.size === 0) {
          cache = [...getRowsSnapshot()].toSorted((a, b) => compareRows(def, a, b));
        } else {
          // Merge the overlay over the authorized set, overlay-wins-by-key: build the authorized
          // rows into a keyed map (their keys are always present — they came from the wire keyed),
          // then apply each pending change (a `delete` removes, an `insert`/`update` sets), and sort
          // the result in the shape's total order — the same order a later authorized echo lands in.
          const merged = new Map<RowKey, Row>();

          for (const row of getRowsSnapshot()) merged.set(rowKey(row, def.key), row);

          for (const [key, change] of overlay) {
            if (change.op === "delete") merged.delete(key);
            else merged.set(key, change.row);
          }

          cache = [...merged.values()].toSorted((a, b) => compareRows(def, a, b));
        }

        dirty = false;
      }

      return cache;
    },

    getCursor() {
      return cursor;
    },

    setCursor(nextCursor) {
      cursor = nextCursor;
    },

    setOptimistic(change) {
      overlay.set(change.key, change);
    },

    clearOptimistic(key) {
      overlay.delete(key);
    },

    subscribe(listener) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },

    mutated() {
      dirty = true;

      for (const listener of listeners) listener();
    },
  };
}

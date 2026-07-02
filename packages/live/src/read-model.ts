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
 *
 * What it deliberately does NOT own: `rowsByKey`, the keyed row map. The two stores drive that
 * map through genuinely different strategies — {@link createLiveStore} swaps in a fresh `Map` on
 * every snapshot (so a bad row throws before any state is touched), while
 * {@link createSqliteLiveStore} clears and refills one long-lived mirror `Map` that a durable
 * write also persists — and this module has no business knowing or caring which. Instead each
 * store hands in a `getRowsSnapshot` thunk over its OWN map, read fresh every time the cache is
 * dirtied, so `getRows()` always sorts the CURRENT rows via {@link compareRows} regardless of how
 * they got there.
 */

import { compareRows } from "@lesto/live-protocol";
import type { Cursor, Row, ShapeDefinition } from "@lesto/live-protocol";

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

  const listeners = new Set<() => void>();

  return {
    getRows() {
      if (dirty) {
        cache = [...getRowsSnapshot()].toSorted((a, b) => compareRows(def, a, b));
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

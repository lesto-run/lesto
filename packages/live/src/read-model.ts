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
 *   - The **optimistic overlay** (ADR 0042 Tier 4, v1 Inc6) + its lifecycle. An offline (or
 *     in-flight) write is shown *over* the authorized set: {@link ReadModel.getRows} merges the
 *     wire-driven authorized rows with the overlay (an optimistic `insert`/`update` sets a row, a
 *     `delete` removes one), overlay-wins-by-key, before sorting. The authorized tier stays
 *     untouched — driven ONLY by the wire — so the overlay is purely additive and a rollback is
 *     just dropping its entry (the authorized row, which never carried the optimistic edit, shows
 *     through again). Its single source of truth is the outbox (`./outbox`), which drives the
 *     lifecycle below and rebuilds the whole overlay from the durable log on reload — so nothing
 *     here is persisted.
 *
 * ## The overlay lifecycle: pending → held → cleared (the read-your-writes fix, `L-436724ba`)
 *
 * Each entry is keyed by its **client mutation id**, not the row key, and carries a `held` flag —
 * so two in-flight writes to the SAME row key are two independent entries, and settling one never
 * disturbs the other (the key-reuse hazard). Because the map preserves insertion (= submission)
 * order, the merge below applies entries oldest-first, so the NEWEST write to a key wins the view —
 * exactly last-write-wins locally. The three transitions the outbox drives:
 *
 *   - **{@link ReadModel.setOptimistic}** (on submit) — add a `pending` entry, shown at once.
 *   - **{@link ReadModel.holdOptimistic}** (on ack) — mark the entry `held`: the server accepted
 *     the write, but its authoritative echo lands ≤ poll/replication-interval LATER over the wire.
 *     The entry stays SHOWN (a held entry renders identically to a pending one) so there is no
 *     read-your-writes flash in that gap — the window the pre-`L-436724ba` clear-on-ack left open.
 *   - **{@link ReadModel.settleEcho}** (on that echo) — when an authorized `change`/`snapshot`
 *     touches a key, drop the OLDEST held entry for it (one echo settles one write) IN THE SAME
 *     store mutation as the authorized apply, so the swap is atomic: the held optimistic row and
 *     its now-authoritative twin are the same value, so nothing visibly changes. It notifies via
 *     {@link ReadModel.onEchoSettled} so the outbox can drop the reconciled durable row.
 *
 * A pending entry (a newer, not-yet-acked write) is never cleared by an echo — only `held` entries
 * are — so an echo for an older write can never prematurely roll back a newer optimistic view.
 * {@link ReadModel.clearOptimistic} is the escape hatch the outbox uses on reject (roll back now)
 * and on the never-echoed grace-timer backstop.
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
 * One optimistic overlay entry, keyed by client mutation id in the overlay map. `held` starts
 * false (a submitted, not-yet-acked write) and flips true on ack — see the module doc's lifecycle.
 */
interface OverlayEntry {
  /** The row identity this write targets — how the merge and {@link ReadModel.settleEcho} find it. */
  readonly key: RowKey;

  /** The optimistic change to show: an `insert`/`update` sets the row, a `delete` removes it. */
  readonly change: ShapeChange;

  /** True once the write is server-accepted (acked) and awaiting its authoritative echo. */
  held: boolean;
}

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
   * Add a `pending` optimistic entry under client mutation `id` — the local, not-yet-confirmed view
   * of a write (ADR 0042 Inc6). An `insert`/`update` sets the row, a `delete` removes it. Keyed by
   * `id` (not the row key) so two in-flight writes to one row coexist. Pure bookkeeping — call
   * {@link mutated} after, exactly like {@link setCursor}.
   */
  setOptimistic(id: string, change: ShapeChange): void;

  /**
   * Mark the entry `id` `held` — the write was acked and now awaits its authoritative echo, but must
   * keep showing meanwhile (the read-your-writes fix). Invisible to {@link getRows} (a held entry
   * renders identically to a pending one), so — unlike the others — this needs no {@link mutated}.
   * A no-op when no such entry is pending (already echo-cleared).
   */
  holdOptimistic(id: string): void;

  /**
   * Drop the optimistic entry `id` outright — the outbox's rollback path (a server reject, or the
   * never-echoed grace-timer backstop). A no-op when none is pending. Pure bookkeeping — call
   * {@link mutated} after.
   */
  clearOptimistic(id: string): void;

  /**
   * An authorized `change`/`snapshot` just touched `key`: drop the OLDEST `held` entry for it (one
   * echo settles one write) and notify {@link onEchoSettled} listeners with its id. Only `held`
   * entries are cleared — a newer pending write to the same key is left intact. Call it in the SAME
   * store mutation as the authorized apply so the swap is atomic (zero flash); dirty via
   * {@link mutated} after. A no-op when no held entry targets `key`.
   */
  settleEcho(key: RowKey): void;

  /**
   * Register a listener fired with a mutation id whenever {@link settleEcho} clears that held entry
   * — the outbox's hook to drop the now-reconciled durable log row. Returns its unsubscribe.
   */
  onEchoSettled(listener: (mutationId: string) => void): () => void;

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

  // The optimistic overlay (ADR 0042 Inc6): pending/held client writes keyed by client mutation id,
  // merged over the authorized set in `getRows`. Insertion order = submission order, so the merge
  // applies them oldest-first and the newest write to a key wins the view. Empty in the
  // overwhelmingly common case — kept out of the merge fast-path below so a store with no in-flight
  // writes sorts exactly as it did pre-Inc6.
  const overlay = new Map<string, OverlayEntry>();

  const listeners = new Set<() => void>();

  // Notified with a mutation id when `settleEcho` clears its held entry — the outbox drops the
  // reconciled durable row. Separate from `listeners` (the UI's `mutated` notify): this fires no
  // re-render, it only reconciles durable state.
  const echoListeners = new Set<(mutationId: string) => void>();

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
          // then apply each overlay entry oldest-first (a `delete` removes, an `insert`/`update`
          // sets) so a newer write to a key overwrites an older one, and sort the result in the
          // shape's total order — the same order a later authorized echo lands in.
          const merged = new Map<RowKey, Row>();

          for (const row of getRowsSnapshot()) merged.set(rowKey(row, def.key), row);

          for (const entry of overlay.values()) {
            if (entry.change.op === "delete") merged.delete(entry.key);
            else merged.set(entry.key, entry.change.row);
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

    setOptimistic(id, change) {
      overlay.set(id, { key: change.key, change, held: false });
    },

    holdOptimistic(id) {
      const entry = overlay.get(id);

      // No-op if the entry is already gone (echo-cleared before the ack landed here) — the write is
      // reconciled either way.
      if (entry !== undefined) entry.held = true;
    },

    clearOptimistic(id) {
      overlay.delete(id);
    },

    settleEcho(key) {
      // Oldest-first (insertion order): drop the first HELD entry for this key and report it. A
      // pending entry (a newer, not-yet-acked write) is skipped, so an older write's echo can never
      // roll back a newer optimistic view.
      for (const [id, entry] of overlay) {
        if (entry.key === key && entry.held) {
          overlay.delete(id);

          for (const listener of echoListeners) listener(id);

          return;
        }
      }
    },

    onEchoSettled(listener) {
      echoListeners.add(listener);

      return () => {
        echoListeners.delete(listener);
      };
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

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
 * The sorted-cache + dirty flag, the listener bookkeeping, and the cursor variable are NOT
 * owned here — they live in the shared {@link createReadModel} (`./read-model`), which this
 * store and {@link createSqliteLiveStore} both compose, so the one non-obvious contract
 * (`getRows()` returns a **stable array reference** between mutations — a UI bound through
 * `useSyncExternalStore` compares the snapshot by identity to decide whether to re-render, and
 * handing back a fresh array on every read would loop it forever) has exactly one
 * implementation. This module owns only `rowsByKey` and the three mutation methods that drive
 * it: `applySnapshot` swaps in a fresh `Map` so a bad row (a missing key throws in
 * {@link rowKey}) leaves the previous state intact, never half-applied.
 */

import { rowKey, shapeId } from "@lesto/live-protocol";
import type { Cursor, Row, RowKey, ShapeChange, ShapeDefinition } from "@lesto/live-protocol";

import { createReadModel } from "./read-model";

/**
 * One pending client write in the outbox (ADR 0042 Tier 4, v1 Inc6): the app mutation to replay
 * ({@link name}/{@link input} — the SAME authorized `POST` an online write makes) plus the
 * {@link optimistic} change shown locally until it is confirmed or rolled back. The {@link id} is a
 * client-generated mutation id — the log's ordering + idempotency key, distinct from the row's own
 * (also client-generated) primary key that the optimistic change is keyed by.
 */
export interface OutboxEntry {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
  readonly optimistic: ShapeChange;
}

/**
 * A persisted outbox entry as {@link OutboxPersistence.load} reads it back — an {@link OutboxEntry}
 * plus its durable `held` state (`L-436724ba`). A `held` entry is one the server already accepted
 * (acked); on reload the outbox rebuilds its overlay WITHOUT re-queuing it for replay, so a
 * server-accepted write is never re-submitted. A pending entry (`held: false`) is re-queued to drain.
 */
export interface LoadedOutboxEntry extends OutboxEntry {
  readonly held: boolean;
}

/**
 * A durable home for the outbox — the OPFS half of "an offline write survives reload" (ADR 0042
 * Inc6). {@link createSqliteLiveStore} implements it over its SQLite FIFO chain; the in-memory
 * store has none (its outbox is session-only). The outbox module (`./outbox`) drives it: it
 * {@link load}s the persisted log once at open (rebuilding the overlay), {@link append}s on submit,
 * flips an acked entry to held with {@link markHeld}, and {@link remove}s it once its echo lands (or
 * it is rejected). Writes are enqueued (fire-and-forget); await the store's `whenIdle` for
 * durability in a test or before teardown.
 */
export interface OutboxPersistence {
  /** The persisted entries in submission order, each with its `held` state — read once at store open. */
  load(): readonly LoadedOutboxEntry[];

  /**
   * Durably append one entry, `held: false` (enqueued on the store's write chain). The returned
   * promise is a **per-write durability signal**: it resolves once THIS entry has settled on the
   * chain (committed, or — on the rare durable-write failure — reported to the store's `onError`), so
   * a caller can await one write reaching disk without awaiting the whole store's `whenIdle`. Like
   * `whenIdle`, it never rejects; a failure surfaces through `onError` (the in-memory queue stays
   * authoritative for the session). See {@link SubmitHandle.durable} (`./outbox`), which surfaces it
   * per submit.
   */
  append(entry: OutboxEntry): Promise<void>;

  /**
   * Durably flip the entry `id` to `held` — the server acked it, so it must survive reload as
   * accepted (rebuilt into the overlay, not re-queued for replay) until its echo lands. Enqueued on
   * the store's write chain.
   */
  markHeld(id: string): void;

  /** Durably remove the entry with `id` (enqueued on the store's write chain). */
  remove(id: string): void;
}

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
   * either way advances the local cursor to the change's commit `cursor`. This is also a write's
   * **authoritative echo** — so applying it atomically settles a held optimistic entry for the same
   * key (`L-436724ba`), swapping the held row for its now-authoritative twin with no visible flash.
   */
  applyChange(change: ShapeChange, cursor?: Cursor): void;

  /**
   * Drop the local slice AND its cursor, then await the next snapshot — the always-correct
   * floor on a resync. Clearing the cursor is deliberate: a resync abandons the local
   * position, so the next snapshot re-establishes both rows and cursor from scratch.
   *
   * Note the optimistic overlay is deliberately NOT cleared here: a resync abandons the
   * *authorized* position, but a still-pending offline write is unrelated server state that must
   * survive to be replayed — the outbox owns clearing it (on ack/reject), never the wire.
   */
  applyResync(): void;

  /**
   * Overlay an optimistic (not-yet-confirmed) write on top of the authorized set — shown locally
   * the instant it is made, even offline (ADR 0042 Inc6). Keyed by client mutation `id` (so two
   * in-flight writes to one row coexist); an `insert`/`update` sets the row, a `delete` removes it.
   * Does NOT touch the authorized set or the cursor (both are wire-only) — the overlay is purely
   * additive, so dropping the entry is a complete rollback. The outbox (`./outbox`) is the sole
   * caller and the overlay's source of truth.
   */
  applyOptimistic(id: string, change: ShapeChange): void;

  /**
   * Mark the optimistic entry `id` **held** — the server acked the write, but its authoritative echo
   * lands over the wire ≤ poll/replication-interval later. Holding keeps it shown across that gap so
   * there is no read-your-writes flash (`L-436724ba`); {@link applyChange}/{@link applySnapshot}
   * clear it when the echo arrives. Invisible to {@link getRows}, so no re-render fires. A no-op when
   * none is pending.
   */
  holdOptimistic(id: string): void;

  /**
   * Drop the optimistic overlay entry `id` outright — the outbox's rollback path (a server reject, or
   * the never-echoed grace-timer backstop). A no-op when none is pending.
   */
  clearOptimistic(id: string): void;

  /**
   * Register a listener fired with a mutation id when a HELD optimistic entry is cleared by its
   * authorized echo (see {@link applyChange}). The outbox (`./outbox`) uses it to drop the reconciled
   * durable log row. Returns its unsubscribe. It fires DURING the echo's store mutation, *before* the
   * `mutated()` notification, so a listener must only reconcile side state (as the outbox does) and
   * must NOT read {@link getRows} synchronously — the sorted view is dirtied but not yet recomputed.
   */
  onEchoSettled(listener: (mutationId: string) => void): () => void;

  /** The rows in the shape's total order — a stable reference until the next mutation. */
  getRows(): readonly Row[];

  /**
   * The cursor of the last applied frame, or `undefined` before the first frame / after a resync.
   * {@link connectLiveData} reads it at connect time to seed the `?lastEventId=` resume — on a cold
   * reload of a durable store this is the value that survived (read right after hydration, so it
   * equals the persisted cursor). Note during a live session it tracks the in-memory (optimistic)
   * position, which a durable store's persisted cursor may briefly lag while a write is in flight
   * or the tier is frozen; the connect-time read is unaffected (it happens once, post-hydration).
   */
  getCursor(): Cursor | undefined;

  /** Register a listener fired after every mutation; returns its unsubscribe. */
  subscribe(listener: () => void): () => void;

  /**
   * The stable id ({@link shapeId}) of the shape this store was built for. Optional so a
   * hand-rolled `LiveStore` (none exist in this repo today) need not populate it — but both
   * {@link createLiveStore} and {@link createSqliteLiveStore} always do. `createLiveQuery`
   * reads it (when present) to guard against a `def`/store shape mismatch: a caller-supplied
   * store built from a DIFFERENT `ShapeDefinition` than the `def` it is paired with, which
   * would otherwise key/sort/subscribe by one shape while the store holds rows for another —
   * silently.
   */
  readonly shapeId?: string;

  /**
   * The durable outbox, when this store has one — {@link createSqliteLiveStore} exposes it (the
   * OPFS half of "an offline write survives reload"), the in-memory store does not. Optional so the
   * outbox module (`./outbox`) degrades to a session-only queue against a non-durable store rather
   * than requiring one.
   */
  readonly outbox?: OutboxPersistence;
}

/**
 * Build the in-memory store for a shape. Bound to the `def` so it can key rows
 * ({@link rowKey} over `def.key`) and sort them ({@link compareRows} over the shape's
 * total order) exactly as the server did.
 */
export function createLiveStore(def: ShapeDefinition): LiveStore {
  // The authorized set, keyed by row identity so a `change` is an O(1) set/delete.
  let rowsByKey = new Map<RowKey, Row>();

  // The shared read model owns the sorted-cache, the listeners, and the cursor. It reads
  // `rowsByKey` fresh (via the thunk) every time it recomputes, so swapping in a whole new map
  // below is invisible to it.
  const readModel = createReadModel(def, () => rowsByKey.values());

  return {
    applySnapshot(rows, nextCursor) {
      // Build into a fresh map and swap, so a bad row (a missing key throws in `rowKey`)
      // leaves the previous state intact for the consumer to resync from, never half-applied.
      const next = new Map<RowKey, Row>();

      for (const row of rows) next.set(rowKey(row, def.key), row);

      rowsByKey = next;
      readModel.setCursor(nextCursor);
      // Each snapshotted row is a potential echo — settle a held optimistic write for its key in
      // this same mutation, so the swap to the authoritative row is atomic (no flash). Settles one
      // held write per key; a rare second held write to the same key waits for its own echo/grace.
      for (const row of rows) readModel.settleEcho(rowKey(row, def.key));
      readModel.mutated();
    },

    applyChange(change, nextCursor) {
      // Trust the change's decoded `key`: the server minted it as `rowKey(row, def.key)`,
      // so `insert`/`update` set under it and a delete-from-shape removes it.
      if (change.op === "delete") rowsByKey.delete(change.key);
      else rowsByKey.set(change.key, change.row);

      readModel.setCursor(nextCursor);
      // The change IS this key's authoritative echo — settle a held optimistic write for it here,
      // in the same mutation, so its held row is replaced by the identical authoritative one with
      // no intervening frame where the row is sourced from neither tier.
      readModel.settleEcho(change.key);
      readModel.mutated();
    },

    applyResync() {
      rowsByKey = new Map();
      readModel.setCursor(undefined);
      readModel.mutated();
    },

    applyOptimistic(id, change) {
      readModel.setOptimistic(id, change);
      readModel.mutated();
    },

    holdOptimistic(id) {
      // Held is invisible to `getRows` (a held entry renders like a pending one), so no `mutated`.
      readModel.holdOptimistic(id);
    },

    clearOptimistic(id) {
      readModel.clearOptimistic(id);
      readModel.mutated();
    },

    onEchoSettled: readModel.onEchoSettled,

    getRows: readModel.getRows,
    getCursor: readModel.getCursor,
    subscribe: readModel.subscribe,

    shapeId: shapeId(def),
  };
}

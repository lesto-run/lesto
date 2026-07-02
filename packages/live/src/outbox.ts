/**
 * `createLiveMutations` — the offline-write **outbox** (ADR 0042 Tier 4, v1 Inc6).
 *
 * A write made while `live()` is open is applied to the local store IMMEDIATELY (optimistically)
 * and appended to a durable log, then — when online — replayed as the app's **normal authorized
 * mutation `POST`**: the same validation, authorization, and CSRF every online write passes. There
 * is deliberately no bespoke sync-write server and no direct client→queue channel; the server-side
 * `@lesto/queue` is reached only *through* those authorized mutations, exactly as an online request
 * would (the ADR's precision, preserved). This module owns none of that transport — it takes the
 * app's mutation call as an injected {@link MutationSubmitter} seam, exactly as `connectLiveData`
 * takes the `EventSource` seam: the app wires `@lesto/client`'s `createMutationClient` (or any
 * `POST`) into it, so `@lesto/live` grows no dependency on the client and the whole drain is
 * test-fakeable.
 *
 * ## The lifecycle: submit → drain → held → cleared (`L-436724ba`)
 *
 * The store's optimistic overlay (`./read-model`) and this module's pending queue share a lifetime,
 * but an acked write does NOT clear immediately — it is held until its echo, which is what closes the
 * read-your-writes flash:
 *
 *   - **submit** → apply the optimistic change to the overlay (a `pending` entry), append the entry
 *     to the queue AND the durable log, then try to drain.
 *   - **ack** (`"ok"` — the server accepted the write) → drop it from the drain QUEUE (it must never
 *     replay), but do NOT clear the overlay: mark the entry **held** ({@link LiveStore.holdOptimistic}
 *     + {@link OutboxPersistence.markHeld}) and arm a grace timer. The write stays SHOWN. The server's
 *     authoritative echo arrives over the normal replication wire ≤ poll/replication-interval later,
 *     landing in the AUTHORIZED set under the SAME client-generated primary key; when it applies,
 *     {@link LiveStore.applyChange}/`applySnapshot` clears the held entry IN THAT SAME MUTATION — the
 *     held optimistic row and its authoritative twin are the same value, so nothing visibly changes.
 *     That is the fix: pre-`L-436724ba` the overlay cleared on ack, leaving a window where the row was
 *     sourced from neither tier (a flash); now it is held across the gap. The store notifies us via
 *     {@link LiveStore.onEchoSettled} so we drop the reconciled durable row and cancel the grace timer.
 *   - **grace** (the echo never comes — e.g. the write does not match the shape's filter, or under
 *     resync/reconnect) → the grace timer fires and clears the held overlay + durable row. This is the
 *     bounded backstop: its worst case (a lagging echo cleared a beat early) is exactly the pre-fix
 *     behavior, never incorrectness. A true LSN-exact hold is the ADR 0042 vNext refinement.
 *   - **reject** (`"rejected"` — the server refused it) → drop the queue + log entry and clear the
 *     overlay immediately. Because the overlay is purely additive over the authorized set, clearing
 *     it IS the rollback: the authorized row (which never carried the edit) shows through again.
 *   - **retry** (`"retry"` — transport failed / still offline) → keep the entry (and the overlay)
 *     and stop draining, preserving order; the next {@link LiveMutations.flush} retries it.
 *
 * On reload the durable log is the single source of truth: {@link createLiveMutations} reads it
 * back ({@link LiveStore.outbox}`.load()`) and re-applies each entry's optimistic change to the
 * overlay, so an offline write is visible again before the network reconnects. A **held** entry
 * rebuilds as held (shown, but NOT re-queued — the server already accepted it) with a fresh grace
 * timer; a pending entry is re-queued, and a `flush` drains it. Against a non-durable (in-memory)
 * store the queue is session-only: the same surface (including hold-until-echo within the session),
 * without the survives-reload guarantee.
 *
 * ## Delivery is AT-LEAST-ONCE — the replayed mutation must be idempotent
 *
 * The durable `remove` on ack is enqueued behind the store's write chain, not awaited, so a reload
 * in the narrow window between a write's ack and its log entry's durable removal will re-hydrate and
 * REPLAY that already-accepted write. This is deliberate — exactly-once across a crash needs a
 * distributed commit the client cannot have — so the contract is **at-least-once**, and the replayed
 * mutation must be idempotent. The client-generated primary key is what makes it so: the server's
 * insert lands under the same key (an upsert / conflict-ignore), and the echo settles the optimistic
 * row rather than duplicating it. A mutation whose id is NOT the row's own key must carry its own
 * idempotency key. Symmetrically, a write is durable only once the store's writes settle (await the
 * durable store's `whenIdle`), NOT synchronously at `submit` return — a crash within that sub-`whenIdle`
 * window loses an un-persisted offline write, the same async-persist window the durable row/cursor
 * writes have.
 *
 * ## The submit → durable window: `whenIdle` vs the per-write signal
 *
 * That window (submit returns, the durable append lands a beat later) is closable at two granularities.
 * The store-level {@link LiveStore.outbox}-backed `whenIdle` waits for *every* queued write to settle —
 * the right, simple tool for teardown and tests. For an app that wants a stronger per-write "saved"
 * confirmation without stalling on unrelated in-flight writes, {@link LiveMutations.submit} also hands
 * back a {@link SubmitHandle.durable} promise that resolves once THIS entry's append reaches the durable
 * log. Both share the store's contract: they resolve whether the durable write committed or failed-and-
 * was-reported (a failure surfaces via the store's `onError`, never as a rejection), and against a
 * non-durable (in-memory) store there is no durable tier, so `durable` is already-resolved — the write
 * is as durable as it will get the instant it is made (session memory).
 */

import type { LiveStore, OutboxEntry } from "./store";
import type { ShapeChange } from "@lesto/live-protocol";

/**
 * The outcome of replaying one queued write through the app's mutation `POST` — a three-way
 * classification the app maps its own result onto:
 *
 *   - `"ok"` — the server accepted it (a 2xx / `{ ok: true }`). Drop it; the echo carries the truth.
 *   - `"rejected"` — the server refused it (validation, authorization, a business `{ ok: false }`).
 *     Roll it back locally; replaying it again would only be refused again.
 *   - `"retry"` — the call never reached a verdict (offline, a transport failure). Keep it and
 *     retry on the next flush; this is the ordinary offline case, not an error.
 *
 * Mapping `@lesto/client`'s `MutationResult`: `ok: true` → `"ok"`; `ok: false` with code
 * `MUTATION_TRANSPORT_FAILED` / `MUTATION_CSRF_FETCH_FAILED` → `"retry"`; any other `ok: false` →
 * `"rejected"`.
 */
export type MutationOutcome = "ok" | "rejected" | "retry";

/**
 * The injected seam that replays one queued mutation as the app's authorized `POST` and classifies
 * the result. Never expected to throw — a thrown error is treated as a transient `"retry"` and
 * reported to {@link LiveMutationsOptions.onError} — but throwing is tolerated so a naive seam
 * cannot wedge the drain.
 */
export type MutationSubmitter = (name: string, input: unknown) => Promise<MutationOutcome>;

/**
 * The injected timer seam behind the held-overlay grace backstop (`L-436724ba`): schedule `cb` to run
 * after `ms`. Fire-and-forget by design — an un-fired timer is harmless (the callback is idempotent),
 * so there is deliberately no cancel handle. Defaults to `setTimeout`; a test injects a fake that
 * captures the callback to fire deterministically.
 */
export type ScheduleGrace = (cb: () => void, ms: number) => void;

/**
 * How long a held (acked, not-yet-echoed) write stays shown before the grace backstop clears it — a
 * few seconds, comfortably past a healthy poll/replication interval so the echo normally wins the
 * race, short enough that a never-echoed write does not linger. Overridable via
 * {@link LiveMutationsOptions.graceMs}.
 */
export const DEFAULT_GRACE_MS = 5_000;

/** One optimistic write handed to {@link LiveMutations.submit}. */
export interface SubmitMutation {
  /** The mutation name — the authorized `POST /__lesto/mutations/:name` target replayed on drain. */
  readonly name: string;

  /** The mutation input — replayed verbatim as the `POST` body (JSON). Optional (a no-arg mutation). */
  readonly input?: unknown;

  /**
   * The optimistic change to show locally until the write is confirmed or rolled back. Its `key`
   * MUST be the row's client-generated primary key, so the server's later echo (same key) settles
   * under it rather than as a duplicate — the reconciliation the last-write-wins model needs.
   */
  readonly optimistic: ShapeChange;

  /**
   * An explicit client mutation id (the log's ordering + idempotency key). Optional — a fresh
   * unique id is generated ({@link LiveMutationsOptions.newId}) when omitted. Supply one only to
   * make a submit idempotent across retries; it MUST be unique per logical write.
   */
  readonly id?: string;
}

/** What {@link LiveMutations.submit} hands back: the queued entry's id plus a per-write durability signal. */
export interface SubmitHandle {
  /**
   * The queued entry's client mutation id (the log's ordering + idempotency key) — available
   * synchronously, e.g. to correlate a later ack or to key UI. Equals a supplied {@link SubmitMutation.id}
   * or the freshly minted one.
   */
  readonly id: string;

  /**
   * Resolves once THIS write has reached the durable outbox log — the per-write analog of the durable
   * store's `whenIdle`, scoped to one entry so an app can confirm a single write is "saved" without
   * awaiting every unrelated in-flight write. Resolves whether the durable append committed or failed-
   * and-was-reported (a failure surfaces through {@link LiveMutationsOptions.onError} on a durable store,
   * never as a rejection). Against a non-durable store it is already-resolved — there is no durable tier,
   * so the write is as durable as it will get the instant it is made.
   */
  readonly durable: Promise<void>;
}

/** What {@link createLiveMutations} accepts. */
export interface LiveMutationsOptions {
  /** The store whose optimistic overlay the writes drive, and whose durable outbox persists them. */
  readonly store: LiveStore;

  /** The seam that replays a queued write as the app's authorized mutation `POST`. */
  readonly submit: MutationSubmitter;

  /**
   * Notified when the {@link submit} seam itself throws (rather than resolving an outcome) — the
   * throw is treated as a transient `"retry"`, so the drain stops and the entry is kept. Absent →
   * the throw is swallowed after keeping the entry.
   */
  readonly onError?: (error: unknown) => void;

  /**
   * Mint a client mutation id for a submit that supplies none. Defaults to `crypto.randomUUID()`.
   * Injected so a test gets deterministic ids.
   */
  readonly newId?: () => string;

  /**
   * How long a held (acked) write stays shown before the grace backstop clears it, in ms. Defaults
   * to {@link DEFAULT_GRACE_MS}. The echo normally clears the entry first; this only bites when no
   * echo ever lands (a filtered write, or a resync/reconnect in the gap).
   */
  readonly graceMs?: number;

  /**
   * The timer seam behind the grace backstop — defaults to `setTimeout`. Injected so a test fires the
   * grace deterministically without real time. See {@link ScheduleGrace}.
   */
  readonly schedule?: ScheduleGrace;
}

/** The outbox handle: submit optimistic writes, drain them, and read the pending count. */
export interface LiveMutations {
  /**
   * Apply an optimistic write, durably enqueue it, and try to drain immediately. Returns a
   * {@link SubmitHandle} — the entry `id` (synchronous) plus a `durable` promise that resolves when
   * this write reaches the durable log. Online, the write replays at once; offline, the
   * {@link MutationSubmitter} returns `"retry"` and the entry stays queued (and shown optimistically)
   * until {@link flush} succeeds.
   */
  submit(mutation: SubmitMutation): SubmitHandle;

  /**
   * Drain the pending queue in submission order through the {@link MutationSubmitter}, settling each
   * write (ack/reject → clear; retry → stop). Call it when the app comes back online (a `window`
   * `online` event, a stream reconnect). Re-entrant-safe: a call made while one drain is in flight
   * returns that SAME in-flight promise (the running loop already sees every queued entry), so
   * awaiting `flush()` always awaits an actual drain to completion rather than racing it.
   */
  flush(): Promise<void>;

  /** How many writes are still pending (queued, not yet acked or rejected). */
  pending(): number;
}

/** The default client mutation id — a UUID, unique within a session (see {@link LiveMutationsOptions.newId}). */
const defaultNewId = (): string => globalThis.crypto.randomUUID();

/** The default grace timer — a fire-and-forget `setTimeout` (see {@link ScheduleGrace}). */
const defaultSchedule: ScheduleGrace = (cb, ms) => {
  setTimeout(cb, ms);
};

/**
 * Build the offline-write outbox over a store and an authorized-mutation seam. On construction it
 * rehydrates any durably-persisted writes (rebuilding the optimistic overlay, holding the acked ones)
 * so an offline write survives reload; the caller drains the pending ones with a
 * {@link LiveMutations.flush} once online.
 */
export function createLiveMutations(options: LiveMutationsOptions): LiveMutations {
  const {
    store,
    submit,
    onError,
    newId = defaultNewId,
    graceMs = DEFAULT_GRACE_MS,
    schedule = defaultSchedule,
  } = options;

  // The pending queue, front = oldest — writes still awaiting an ack.
  const queue: OutboxEntry[] = [];

  // Ids of HELD writes (acked, awaiting their echo). Tracked so the grace backstop knows which are
  // still outstanding and skips one already reconciled by its echo — see `onGrace` / `onEchoSettled`.
  const heldIds = new Set<string>();

  // The never-echoed backstop: the grace window elapsed with no authoritative echo, so drop the held
  // overlay (revealing the authorized truth — the write simply is not in this shape) and its durable
  // row. A no-op once the echo already reconciled the write (its id left `heldIds`), so a late-firing
  // timer is harmless — which is why the timer needs no cancel handle.
  const onGrace = (id: string): void => {
    if (!heldIds.has(id)) return;

    heldIds.delete(id);
    store.clearOptimistic(id);
    store.outbox?.remove(id);
  };

  // Hold a just-acked write until its echo: track it and arm the grace backstop.
  const hold = (id: string): void => {
    heldIds.add(id);
    schedule(() => onGrace(id), graceMs);
  };

  // The echo landed: the store already cleared the held overlay atomically (`settleEcho`) and told us
  // here — so drop the now-reconciled durable row. The grace timer, if still pending, no-ops above.
  store.onEchoSettled((id) => {
    heldIds.delete(id);
    store.outbox?.remove(id);
  });

  // Rehydrate from durability: re-apply each persisted write's optimistic change so a reload paints it
  // before the network reconnects. A HELD entry (the server already accepted it) rebuilds as held with
  // a fresh grace timer and is NOT re-queued — it must not replay; a pending entry is re-queued to drain.
  for (const entry of store.outbox?.load() ?? []) {
    store.applyOptimistic(entry.id, entry.optimistic);

    if (entry.held) {
      store.holdOptimistic(entry.id);
      hold(entry.id);
    } else {
      queue.push(entry);
    }
  }

  // One drain at a time. The GUARD is the boolean `draining` (set/cleared synchronously around the
  // loop), NOT the promise: a drain over an empty queue settles synchronously (it never awaits), so
  // keying re-entry off the returned promise would leave a resolved promise latched and wedge every
  // later drain. `current` is that returned promise, so a caller (or a listener flushing from inside
  // the overlay-clear notification) AWAITS the running drain rather than racing it. The loop reads
  // `queue` fresh each pass, so a `submit` during a drain is picked up within the same run.
  let draining = false;
  let current: Promise<void> = Promise.resolve();

  // Settle the front entry after its verdict. On **ack** the server accepted it: drop it from the
  // drain queue (it must never replay) but HOLD the overlay + durable row until its echo lands — the
  // read-your-writes fix (`L-436724ba`). On **reject** roll it back now: clear the overlay and the
  // durable row (the additive overlay makes clearing it the rollback). Only the front is ever settled
  // (FIFO), and a concurrent `submit` only ever appends, so `shift()` removes exactly this entry.
  const settle = (entry: OutboxEntry, outcome: "ok" | "rejected"): void => {
    queue.shift();

    if (outcome === "ok") {
      store.holdOptimistic(entry.id);
      store.outbox?.markHeld(entry.id);
      hold(entry.id);
    } else {
      store.clearOptimistic(entry.id);
      store.outbox?.remove(entry.id);
    }
  };

  const drainLoop = async (): Promise<void> => {
    try {
      for (;;) {
        // Front = oldest. `undefined` means the queue drained — stop (this also narrows `entry`
        // to a defined `OutboxEntry` for the rest of the loop under `noUncheckedIndexedAccess`).
        const entry = queue[0];

        if (entry === undefined) return;

        let outcome: MutationOutcome;

        try {
          outcome = await submit(entry.name, entry.input);
        } catch (error) {
          // A throwing seam is a transient failure, not a rejection: keep the entry (and its order)
          // and stop, exactly like an explicit `"retry"`. Report so the app can observe it.
          onError?.(error);

          return;
        }

        // Still offline / transport failed → stop draining, keep this and every later entry queued
        // and shown optimistically; a later `flush` retries from here.
        if (outcome === "retry") return;

        // "ok" (accepted — held until the echo lands under the same key) or "rejected" (rolled back):
        // settle it and continue to the next queued write.
        settle(entry, outcome);
      }
    } finally {
      draining = false;
    }
  };

  const flush = (): Promise<void> => {
    // A drain already running? Hand back its promise to await. Otherwise start one, latching the
    // boolean guard synchronously so a re-entrant call cannot start a second interleaved drain.
    if (draining) return current;

    draining = true;
    current = drainLoop();

    return current;
  };

  return {
    submit(mutation) {
      const id = mutation.id ?? newId();

      const entry: OutboxEntry = {
        id,
        name: mutation.name,
        input: mutation.input,
        optimistic: mutation.optimistic,
      };

      queue.push(entry);

      // Durably log BEFORE applying the optimistic overlay. `applyOptimistic` notifies subscribers
      // synchronously, and a subscriber that submits from inside that notification would otherwise
      // enqueue ITS durable append ahead of this one — inverting submission order in the log, which
      // `hydrate` replays by `rowid`. Appending first keeps the persisted order = submission order.
      // (The two are independent — an in-memory overlay vs a durable table — so the order is free.)
      //
      // Capture the append's per-write durability signal for the handle. A non-durable store has no
      // `outbox`, so there is nothing to persist — `durable` resolves at once (as durable as it gets).
      const durable = store.outbox?.append(entry) ?? Promise.resolve();

      store.applyOptimistic(id, mutation.optimistic);

      // Fire-and-forget: online this sends now; offline the seam returns `"retry"` and it stays.
      // (A caller wanting to await the drain calls `flush()`, which returns the same in-flight run.)
      void flush();

      return { id, durable };
    },

    flush,

    pending: () => queue.length,
  };
}

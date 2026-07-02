/**
 * `createCrossTabLiveQuery` — one leader syncs, the rest mirror (ADR 0042 Tier 4, v1 Inc7).
 *
 * Open the same `live()` query in five tabs and you do NOT want five sync connections — the
 * HTTP/1.1 6-connection cap, five times the server fan-out, five durable stores fighting over one
 * origin's storage. This wires the ADR's answer: a **Web Locks leader** (`./leader`) elects exactly
 * one tab to own the sync connection and the store, and a **BroadcastChannel** fans that leader's
 * rendered view to the follower tabs, which re-render from it without a connection of their own.
 * When the leader tab closes the browser releases its lock, a follower is promoted, and it opens the
 * connection — leadership failover with no heartbeat (see `./leader`).
 *
 * ## Why the leader relays its rendered rows rather than followers reading the shared store
 *
 * The ADR frames followers as "re-querying the shared local store". In practice the durable store is
 * OPFS-SQLite over the **SyncAccessHandle Pool VFS** (`./opfs-sqlite`), which takes an *exclusive*
 * per-origin handle — only one tab can hold it open. So the faithful implementation of "the rest
 * mirror" is: the leader owns that single durable copy and **broadcasts its rendered `getRows()`
 * slice** (authorized rows merged with the optimistic overlay) on every change; each follower drives
 * a plain in-memory store from those broadcasts. Followers therefore mirror the leader's exact view —
 * including its read-your-writes optimistic edits — for free, and "never persist one" (ADR §Store):
 * only the leader writes OPFS. The cost is bandwidth on a large slice (a whole-slice broadcast per
 * change); the frame-diff refinement is a noted vNext, deliberately out of Inc7.
 *
 * ## Failover resumes, it does not re-snapshot
 *
 * A promoted follower already holds the last-broadcast view. It seeds a fresh (empty) leader store
 * with it so the swap shows no flash, then opens the connection — which resumes from that view's
 * cursor (`connectLiveData` seeds `?lastEventId=`), so the server replays only what was missed rather
 * than re-sending the whole slice. A durable leader store that hydrated its OWN persisted slice is
 * left authoritative (not seeded over). This is why the store persists the cursor atomically with the
 * rows (Inc5): it is the linchpin that makes leadership handoff cheap.
 *
 * ## Seams, SSR-safety, and the React binding
 *
 * Both browser primitives are reached through an injected {@link CrossTabEnvironment} — Web Locks via
 * {@link RequestLock}, BroadcastChannel via {@link BroadcastChannelSeam} — so importing this module is
 * SSR-safe (the globals are touched only inside {@link browserCrossTabEnvironment}'s methods, never at
 * import) and the whole coordinator is test-fakeable with an in-process lock queue + message bus. The
 * result is a {@link LiveQuery} — the same `{ subscribe, getSnapshot, disconnect }` triple
 * `createLiveQuery` returns — so `@lesto/live/react`'s `useLiveQuery(() => createCrossTabLiveQuery(def,
 * opts), deps)` binds it with no new hook (the factory runs client-only inside an effect).
 */

// Every `postMessage` here is a `BroadcastChannel.postMessage`, whose signature is a single
// structured-clonable message — no `targetOrigin` argument exists (that belongs to
// `window.postMessage`). The unicorn rule cannot tell the two APIs apart, so disable it file-wide.
// oxlint-disable unicorn/require-post-message-target-origin
import { shapeId } from "@lesto/live-protocol";
import type { Cursor, Row, ShapeDefinition } from "@lesto/live-protocol";

import { connectLiveData } from "./consumer";
import type { LiveEnvironment, LiveMessageEvent } from "./consumer";
import { electLeader } from "./leader";
import type { RequestLock } from "./leader";
import type { LiveQuery } from "./live-query";
import { createLiveStore } from "./store";
import type { LiveStore } from "./store";

/**
 * The minimal `BroadcastChannel` surface this coordinator drives — post a message to the OTHER tabs
 * on the channel (never back to the sender), receive theirs, and close. The browser's
 * `BroadcastChannel` satisfies it through {@link browserCrossTabEnvironment}; a test injects a fake
 * in-process bus. `close()` stops delivery, which is the coordinator's whole teardown for the channel
 * — no `removeEventListener` needed, so it is deliberately not in the surface.
 */
export interface BroadcastChannelSeam {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  close(): void;
}

/**
 * The injected browser seams cross-tab coordination needs: the Web Locks request (leader election)
 * and a BroadcastChannel opener (the fan-out). Bundled so an app overrides both together, or accepts
 * the {@link browserCrossTabEnvironment} default.
 */
export interface CrossTabEnvironment {
  /** Request a named Web Lock — passed straight to {@link electLeader}. */
  readonly requestLock: RequestLock;

  /** Open a named BroadcastChannel for the fan-out. */
  openChannel(name: string): BroadcastChannelSeam;
}

/**
 * The default {@link CrossTabEnvironment} over the browser's native `navigator.locks` and
 * `BroadcastChannel`. Both globals are touched only inside these methods — never at import — so a
 * module that merely imports `@lesto/live` stays SSR-safe, exactly like `browserLiveEnvironment`.
 */
export const browserCrossTabEnvironment: CrossTabEnvironment = {
  requestLock: (name, options, callback) => navigator.locks.request(name, options, callback),

  openChannel(name) {
    const channel = new BroadcastChannel(name);

    return {
      postMessage: (message) => channel.postMessage(message),
      addEventListener: (type, listener) =>
        channel.addEventListener(type, (event) => listener(event as MessageEvent)),
      close: () => channel.close(),
    };
  },
};

/**
 * The store the leader owns for a term, plus how to release it. An app opts into durability by
 * returning a {@link createSqliteLiveStore} here with a `dispose` that flushes and closes its OPFS
 * handle; the default is a fresh in-memory store with no teardown.
 */
export interface LeaderStore {
  /** The store the leader drives from the sync connection and broadcasts to followers. */
  readonly store: LiveStore;

  /**
   * Release the store when this leadership term ends via {@link LiveQuery.disconnect} (best-effort,
   * possibly async — e.g. `await store.whenIdle()` then close the OPFS handle). NOT run on tab
   * close, where the OS reclaims the handle with no JS running.
   */
  readonly dispose?: () => void | Promise<void>;
}

/** Options for {@link createCrossTabLiveQuery}. */
export interface CreateCrossTabLiveQueryOptions {
  /** The Web Locks + BroadcastChannel seams. Defaults to {@link browserCrossTabEnvironment}. */
  readonly environment?: CrossTabEnvironment;

  /**
   * Build the store the leader owns for a term. Defaults to a fresh in-memory
   * {@link createLiveStore}; return a durable {@link createSqliteLiveStore} (with a `dispose`) to
   * persist the leader's slice across reload. Called once per leadership win (each tab that becomes
   * leader builds its own), and awaited — it may open OPFS asynchronously.
   */
  readonly createLeaderStore?: () => LeaderStore | Promise<LeaderStore>;

  /** The leader's data-stream path — forwarded to {@link connectLiveData}. Defaults to its default. */
  readonly path?: string;

  /** The leader's `EventSource` seam — forwarded to {@link connectLiveData}. Defaults to the browser's. */
  readonly liveEnvironment?: LiveEnvironment;

  /** Notified of a stream error / corrupt frame on the LEADER's connection (informational). */
  readonly onStreamError?: (event: LiveMessageEvent) => void;

  /** Notified when leadership setup fails (e.g. the durable store cannot open). */
  readonly onError?: (error: unknown) => void;

  /** Override the Web Lock name. Defaults to `lesto-live-leader:<shapeId>` (per-shape leadership). */
  readonly lockName?: string;

  /** Override the BroadcastChannel name. Defaults to `lesto-live:<shapeId>` (per-shape fan-out). */
  readonly channelName?: string;
}

/**
 * A follower's request for the current state (it just opened, or was promoted), or the leader's
 * rendered slice + cursor. Sent over BroadcastChannel, which structured-clones — rows are already
 * plain JSON, so no serialization is needed.
 */
type CrossTabMessage =
  | { readonly t: "hello" }
  | { readonly t: "snapshot"; readonly rows: readonly Row[]; readonly cursor: Cursor | undefined };

/**
 * Open a cross-tab-coordinated live query: exactly one tab (the Web Locks leader) holds the sync
 * connection and durable store; the rest mirror its rendered view over BroadcastChannel; leadership
 * fails over automatically on tab close. Returns the same {@link LiveQuery} handle `createLiveQuery`
 * does — a drop-in for `useLiveQuery` — with `disconnect` also relinquishing leadership and closing
 * the channel.
 */
export function createCrossTabLiveQuery<R extends Row = Row>(
  def: ShapeDefinition,
  options: CreateCrossTabLiveQueryOptions = {},
): LiveQuery<R> {
  const environment = options.environment ?? browserCrossTabEnvironment;
  const createLeaderStore =
    options.createLeaderStore ?? ((): LeaderStore => ({ store: createLiveStore(def) }));

  const id = shapeId(def);
  const lockName = options.lockName ?? `lesto-live-leader:${id}`;
  const channelName = options.channelName ?? `lesto-live:${id}`;

  // The stable façade: local listeners the UI subscribes to, notified on every underlying mutation
  // AND on a store swap (follower → leader). Reading through `current` keeps `getSnapshot`/`subscribe`
  // valid across the swap, so the store instance can change under a subscribed `useSyncExternalStore`.
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  // Start as a follower: an in-memory store driven by the leader's broadcasts (never persisted).
  let current: LiveStore = createLiveStore(def);
  let unsubscribeCurrent = current.subscribe(notify);

  const setStore = (next: LiveStore): void => {
    unsubscribeCurrent();
    current = next;
    unsubscribeCurrent = current.subscribe(notify);
    notify(); // the visible rows just changed to the new store's slice
  };

  const channel = environment.openChannel(channelName);

  // Set while acting as leader — the leader's "broadcast my rendered slice now". A follower's is
  // undefined, so it ignores `hello`. Cleared on teardown.
  let leaderPublish: (() => void) | undefined;

  // Leadership-term resources, torn down idempotently by `stopLeading` (on disconnect) — never on
  // tab close, where the browser reclaims the lock + OPFS handle with no JS running.
  let leaderDisconnect: (() => void) | undefined;
  let unsubscribeBroadcast: (() => void) | undefined;
  let leaderDispose: (() => void | Promise<void>) | undefined;
  let acting = false; // true from the instant leadership is won through its teardown

  const stopLeading = (): void => {
    acting = false;
    leaderPublish = undefined;
    unsubscribeBroadcast?.();
    unsubscribeBroadcast = undefined;
    leaderDisconnect?.();
    leaderDisconnect = undefined;

    const dispose = leaderDispose;

    leaderDispose = undefined;
    // Best-effort, possibly-async release of the durable store (flush + close its OPFS handle).
    if (dispose !== undefined) void Promise.resolve(dispose());
  };

  channel.addEventListener("message", (event) => {
    const message = event.data as CrossTabMessage | undefined;

    if (message === undefined) return;

    if (message.t === "hello") {
      // A follower asking for the current state — only the leader answers (a follower's
      // `leaderPublish` is undefined). Covers a tab that joined during a quiet period, when no
      // change has broadcast the slice yet.
      leaderPublish?.();
    } else if (!acting) {
      // A follower applies the leader's rendered slice verbatim. The leader ignores snapshots (it
      // never receives its own, and there is only ever one leader), so this is guarded on `!acting`.
      current.applySnapshot(message.rows, message.cursor);
    }
  });

  // Ask the current leader (if any) to send the state now. If there is no leader yet, the tab that
  // wins the lock broadcasts on becoming leader, so a fresh follower is never left empty for long.
  channel.postMessage({ t: "hello" } satisfies CrossTabMessage);

  const election = electLeader({
    requestLock: environment.requestLock,
    name: lockName,
    ...(options.onError === undefined ? {} : { onError: options.onError }),
    onLeadership: async () => {
      acting = true;

      const { store, dispose } = await createLeaderStore();

      leaderDispose = dispose;

      // Seed a fresh (empty) leader store with the follower view we already hold, so the swap shows
      // no flash and the connection resumes from that view's cursor. A durable store that hydrated
      // its own slice is left authoritative — not seeded over.
      if (store.getRows().length === 0) {
        const seedRows = current.getRows();

        if (seedRows.length > 0) store.applySnapshot(seedRows, current.getCursor());
      }

      setStore(store);

      // Broadcast the leader's rendered slice on every change, and once now so existing followers
      // (and a just-promoted term) converge immediately.
      const publish = (): void => {
        channel.postMessage({
          t: "snapshot",
          rows: store.getRows(),
          cursor: store.getCursor(),
        } satisfies CrossTabMessage);
      };

      leaderPublish = publish;
      unsubscribeBroadcast = store.subscribe(publish);
      publish();

      // Open the ONE sync connection. It resumes from the store's cursor (seeded above, or the
      // durable store's hydrated one) via `connectLiveData`'s `?lastEventId=` seed.
      leaderDisconnect = connectLiveData({
        def,
        store,
        ...(options.path === undefined ? {} : { path: options.path }),
        ...(options.liveEnvironment === undefined ? {} : { environment: options.liveEnvironment }),
        ...(options.onStreamError === undefined ? {} : { onError: options.onStreamError }),
      });

      // The cleanup `electLeader` runs when leadership is relinquished on `disconnect` (idempotent
      // with the direct call there).
      return stopLeading;
    },
  });

  return {
    subscribe(listener) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },

    getSnapshot: () => current.getRows() as readonly R[],

    disconnect() {
      // Tear the leadership term down at once (stop the network now), then relinquish the lock so a
      // follower is promoted; its `electLeader` cleanup calls `stopLeading` again — a no-op.
      stopLeading();
      election.release();
      channel.close();
      unsubscribeCurrent();
    },
  };
}

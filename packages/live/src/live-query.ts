/**
 * `createLiveQuery` — the reactive handle that ties a {@link LiveStore} to a live
 * `GET /__lesto/live-data` subscription (ADR 0042 Tier 4, v0). It creates the store, opens
 * the SSE consumer against it, and returns a `{ subscribe, getSnapshot, disconnect }`
 * triple — exactly the shape React's `useSyncExternalStore(subscribe, getSnapshot)` wants,
 * with no React dependency here. The typed `live()` builder that mints the `def` is a later
 * increment in this package; the `useLiveQuery` React binding lands in `@lesto/ui`.
 *
 * `def` and `options.store` are two independent inputs — a caller may hand in an
 * already-opened durable store built from its OWN `def` earlier (e.g. across a reload). If the
 * two disagree, the store's rows are keyed/sorted/filtered by one shape while this call
 * subscribes and reads by another — silently wrong. {@link createLiveQuery} guards against that
 * by comparing `shapeId(def)` to the store's own `shapeId` (populated by both
 * {@link createLiveStore} and {@link createSqliteLiveStore}) whenever the store exposes one,
 * throwing `LIVE_STORE_SHAPE_MISMATCH` rather than silently subscribing to the wrong shape.
 */

import { shapeId } from "@lesto/live-protocol";
import type { Row, ShapeDefinition } from "@lesto/live-protocol";

import { connectLiveData } from "./consumer";
import type { LiveEnvironment, LiveMessageEvent } from "./consumer";
import { LiveClientError } from "./errors";
import { createLiveStore } from "./store";
import type { LiveStore } from "./store";

/**
 * A live view of one shape's rows. `subscribe`/`getSnapshot` are the
 * `useSyncExternalStore` contract (the snapshot is a stable reference between mutations);
 * `disconnect` closes the underlying stream. Generic over the row type `R` a typed `live()`
 * projects; defaults to the opaque {@link Row}.
 */
export interface LiveQuery<R extends Row = Row> {
  /** Register a listener fired after every mutation; returns its unsubscribe. */
  subscribe(listener: () => void): () => void;

  /** The rows in the shape's total order — a stable reference until the next mutation. */
  getSnapshot(): readonly R[];

  /** Close the underlying live-data stream. */
  disconnect(): void;
}

/** Options for {@link createLiveQuery} — the consumer's, minus the store it owns. */
export interface CreateLiveQueryOptions {
  /** The data-stream path the app mounted. Defaults to `/__lesto/live-data`. */
  readonly path?: string;

  /** The `EventSource` seam — defaults to the browser's native `EventSource`. */
  readonly environment?: LiveEnvironment;

  /** Notified of a stream error or a corrupt frame that forced a resync (informational). */
  readonly onError?: (event: LiveMessageEvent) => void;

  /**
   * The store to drive. Defaults to a fresh in-memory {@link createLiveStore}; pass an
   * already-opened durable {@link createSqliteLiveStore} to opt into OPFS-SQLite persistence
   * (it is async to build, so the caller awaits it and hands it in here).
   */
  readonly store?: LiveStore;
}

/**
 * Build a {@link LiveQuery} for a bound shape: create its store, open the live subscription
 * that drives it, and hand back the `useSyncExternalStore`-shaped handle. `getSnapshot`
 * narrows the store's opaque rows to `R` — the projection a typed `live()` guarantees.
 */
export function createLiveQuery<R extends Row = Row>(
  def: ShapeDefinition,
  options?: CreateLiveQueryOptions,
): LiveQuery<R> {
  const store = options?.store ?? createLiveStore(def);

  // A duck-typed check, not a required field: `LiveStore.shapeId` is optional (see `./store`),
  // so a store that does not expose one (none exist in this repo today, but the field is
  // deliberately non-breaking for a future hand-rolled one) skips the guard entirely rather
  // than being forced to grow it. Both stores this package ships DO populate it, so the
  // default no-`store` path above — which always builds its store from this very `def` — can
  // never mismatch, and only a caller-supplied store can trip this.
  if (store.shapeId !== undefined) {
    const expected = shapeId(def);

    if (store.shapeId !== expected) {
      throw new LiveClientError(
        "LIVE_STORE_SHAPE_MISMATCH",
        `createLiveQuery's def (shape "${expected}") does not match the store it was given ` +
          `(shape "${store.shapeId}") — the store was built from a different ShapeDefinition.`,
        { defShapeId: expected, storeShapeId: store.shapeId },
      );
    }
  }

  const disconnect = connectLiveData({
    def,
    store,
    // Conditional spread so an absent option keeps the consumer's own default, rather than
    // forcing `undefined` through under `exactOptionalPropertyTypes`.
    ...(options?.path === undefined ? {} : { path: options.path }),
    ...(options?.environment === undefined ? {} : { environment: options.environment }),
    ...(options?.onError === undefined ? {} : { onError: options.onError }),
  });

  return {
    subscribe: store.subscribe,
    getSnapshot: () => store.getRows() as readonly R[],
    disconnect,
  };
}

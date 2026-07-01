/**
 * `createLiveQuery` — the reactive handle that ties a {@link LiveStore} to a live
 * `GET /__lesto/live-data` subscription (ADR 0042 Tier 4, v0). It creates the store, opens
 * the SSE consumer against it, and returns a `{ subscribe, getSnapshot, disconnect }`
 * triple — exactly the shape React's `useSyncExternalStore(subscribe, getSnapshot)` wants,
 * with no React dependency here. The typed `live()` builder that mints the `def` is a later
 * increment in this package; the `useLiveQuery` React binding lands in `@lesto/ui`.
 */

import type { Row, ShapeDefinition } from "@lesto/live-protocol";

import { connectLiveData } from "./consumer";
import type { LiveEnvironment, LiveMessageEvent } from "./consumer";
import { createLiveStore } from "./store";

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
  const store = createLiveStore(def);

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

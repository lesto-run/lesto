/**
 * @lesto/live — the browser client for local-first sync (ADR 0042 Tier 4, v0).
 *
 * Three framework-agnostic pieces that turn a bound shape into a live, in-memory slice:
 *
 *   - {@link createLiveStore} — the in-memory keyed store: `snapshot`/`change`/`resync`
 *     mutate it, {@link LiveStore.getRows} reads it in the shape's total order behind a
 *     stable-reference cache (the `useSyncExternalStore` contract).
 *   - {@link connectLiveData} — the `GET /__lesto/live-data` SSE consumer that drives a
 *     store, over an injectable `EventSource` seam (SSR-safe, test-fakeable).
 *   - {@link createLiveQuery} — the `{ subscribe, getSnapshot, disconnect }` handle that
 *     wires the two together, ready for a React `useSyncExternalStore` binding elsewhere.
 *
 * Unlike `@lesto/ui`'s topic-driven `connectLive` (ADR 0027/0040), this wire carries
 * auth-scoped ROW DATA — the deliberate ADR 0042 split. No React/preact dependency lives
 * here; the ORM `live()` builder and the `useLiveQuery` hook are later increments.
 */

export { createLiveStore } from "./store";
export type { LiveStore } from "./store";

export { browserLiveEnvironment, connectLiveData, DEFAULT_LIVE_DATA_PATH } from "./consumer";
export type {
  ConnectLiveDataOptions,
  LiveEnvironment,
  LiveEventSource,
  LiveMessageEvent,
} from "./consumer";

export { createLiveQuery } from "./live-query";
export type { CreateLiveQueryOptions, LiveQuery } from "./live-query";

export { live } from "./builder";
export type { LiveQueryBuilder } from "./builder";

export { LiveClientError } from "./errors";
export type { LiveClientErrorCode } from "./errors";

// Re-export the protocol types that appear in this package's public surface, so a consumer
// binds to `@lesto/live` alone (a typed `live()` still mints the `ShapeDefinition`).
export type { Row, RowKey, ShapeChange, ShapeDefinition } from "@lesto/live-protocol";

/**
 * @lesto/live — the browser client for local-first sync (ADR 0042 Tier 4, v0).
 *
 * Framework-agnostic pieces that turn a bound shape into a live slice:
 *
 *   - {@link createLiveStore} — the in-memory keyed store (the default): `snapshot`/`change`/
 *     `resync` mutate it, {@link LiveStore.getRows} reads it in the shape's total order behind a
 *     stable-reference cache (the `useSyncExternalStore` contract).
 *   - {@link createSqliteLiveStore} — the opt-in **durable** store (ADR 0042 v1 Inc5): the same
 *     surface backed by SQLite, persisting the row batch AND the resume cursor atomically so the
 *     slice survives reload. Its browser OPFS engine (`openOpfsSqliteDatabase`) is the separate
 *     opt-in `@lesto/live/opfs` subpath — kept off this barrel so a consumer that never opts into
 *     the durable store never pulls the optional `@sqlite.org/sqlite-wasm` peer into its graph.
 *   - {@link connectLiveData} — the `GET /__lesto/live-data` SSE consumer that drives a
 *     store, over an injectable `EventSource` seam (SSR-safe, test-fakeable).
 *   - {@link createLiveQuery} — the `{ subscribe, getSnapshot, disconnect }` handle that
 *     wires the two together, ready for a React `useSyncExternalStore` binding elsewhere.
 *   - {@link createLiveMutations} — the offline-write **outbox** (ADR 0042 v1 Inc6): a write is
 *     applied to the store optimistically and durably logged, then replayed on reconnect through
 *     the app's normal authorized mutation `POST` (an injected seam); a server-rejected write rolls
 *     back locally, and against a durable store the log survives reload.
 *
 * Unlike `@lesto/ui`'s topic-driven `connectLive` (ADR 0027/0040), this wire carries
 * auth-scoped ROW DATA — the deliberate ADR 0042 split. No React/preact dependency lives
 * here; the ORM `live()` builder and the `useLiveQuery` hook are later increments.
 */

export { createLiveStore } from "./store";
export type { LiveStore } from "./store";

export { createSqliteLiveStore } from "./sqlite-store";
export type { CreateSqliteLiveStoreOptions, SqliteLiveStore } from "./sqlite-store";

export type { LoadedOutboxEntry, OutboxEntry, OutboxPersistence } from "./store";

export { createLiveMutations, DEFAULT_GRACE_MS } from "./outbox";
export type {
  LiveMutations,
  LiveMutationsOptions,
  MutationOutcome,
  MutationSubmitter,
  ScheduleGrace,
  SubmitHandle,
  SubmitMutation,
} from "./outbox";

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
export type { Cursor, Row, RowKey, ShapeChange, ShapeDefinition } from "@lesto/live-protocol";

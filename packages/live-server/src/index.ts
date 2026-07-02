/**
 * @lesto/live-server — the server shape engine for local-first sync (ADR 0042 Tier 4).
 *
 *   - {@link createShapeEngine} — runs registered shapes against the ORM and fans an
 *     initial snapshot + a change tail (insert / update / delete-from-shape) to
 *     subscribers. v0 detects change by a full-table poll ({@link diffRows} the core).
 *   - {@link diffRows} / {@link projectRow} / {@link normalizeWire} — the pure change /
 *     projection / wire-normalization core, decoupled from the poll and the database.
 *
 *   - {@link createPgReplicationSource} — the v1 Postgres logical-replication change source
 *     (a dedicated slot, keyed by commit LSN + system identity), the production replacement
 *     for the v0 poll as the change feed (Inc1).
 *   - {@link prepareShapeClassifier} — the v1 per-row **delete-from-shape** classifier, bound to a
 *     shape behind its `REPLICA IDENTITY FULL` guard so it cannot fail open: it applies a
 *     replication change's old/new images to the shape (in/out/stay) → a `ShapeChange` (Inc2).
 *     {@link predicateNeedsOldImage} / {@link assertReplicaIdentity} are the registration guard
 *     primitives, and {@link assertOldImageComplete} is the per-change runtime re-check (old-tuple
 *     marker + predicate-column presence).
 *   - {@link createImageCoercer} — the `@lesto/db`-backed coercer that projects a raw `pgoutput`
 *     image to a shape's typed wire row (reusing `coerceCell` + `normalizeWire` for byte-parity with
 *     the v0 read path); {@link requiredOldImageColumns} is the value-presence check's column set.
 *   - {@link createReplicaIdentityProbe} — the real (pg) `relreplident = 'f'` catalog probe backing
 *     the engine's `replicaIdentity` seam. These are wired into {@link createShapeEngine} via its
 *     `replication` option: the engine consumes the change source in place of the poll (Inc2).
 *
 *   - {@link createLiveDataHttpHandlers} — the app-mounted `GET /__lesto/live-data`
 *     handler that streams a shape's snapshot + change tail over the runtime's
 *     long-lived-stream kind; {@link ShapeConnection} is its tested outbound core.
 *
 *   - {@link encodeResumeCursor} / {@link decodeResumeCursor} / {@link ShapeReplayRing} — LSN-exact
 *     resume (Inc4): the `(systemId, timelineId, LSN)` cursor and the per-shape replay ring behind
 *     "a reconnect replays EXACTLY the missed changes, or re-snapshots on a failover/restore or an
 *     LSN aged past retention — never silently misses a change". Wired into {@link createShapeEngine}
 *     (the replication path stamps + retains changes) and {@link createLiveDataHttpHandlers} (which
 *     decodes `Last-Event-ID` and replays or re-snapshots accordingly).
 */

export { LiveServerError } from "./errors";
export type { LiveServerErrorCode } from "./errors";

export { diffRows, normalizeWire, projectRow } from "./diff";
export type { DiffResult } from "./diff";

export {
  assertOldImageComplete,
  assertReplicaIdentity,
  predicateNeedsOldImage,
  prepareShapeClassifier,
} from "./classify";
export type { ImageCoercer } from "./classify";

export { createImageCoercer, requiredOldImageColumns } from "./coerce";

export { createReplicaIdentityProbe } from "./pg-catalog";

export { createShapeEngine } from "./engine";
export type {
  ReplayChange,
  ReplicationSourceConfig,
  ShapeChangeListener,
  ShapeEngine,
  ShapeEngineOptions,
  ShapeResume,
  ShapeSubscription,
  TimerSeam,
} from "./engine";

// LSN-exact resume (Inc4): the `(systemId, timelineId, LSN)` cursor codec + the per-shape replay
// ring behind "a reconnect replays EXACTLY the missed changes, or re-snapshots". The wire cursor
// stays opaque to the client — encode/decode live only here, on the server.
export { compareLsn, decodeResumeCursor, encodeResumeCursor, ShapeReplayRing } from "./resume";
export type { ReplayItem, ResumeCursor, RingReconcile, ShapeReplayRingOptions } from "./resume";

export { createPgReplicationSource, DEFAULT_SLOT } from "./replication";
export type {
  ChangeHandler,
  ChangeSource,
  DecodedChange,
  OldImageKind,
  PgReplicationClient,
  PgReplicationSource,
  PgReplicationSourceOptions,
  ReplicationChange,
  RowImage,
  SourceErrorHandler,
  SystemIdentity,
} from "./replication";

// The real (pg) replication client factory — the production `createClient` for the source. Its
// default `pgoutput` decoder is validated end-to-end against a live Postgres slot
// (`test/live/pgoutput-shakeout.ts`, L-4b7edd48); the pure decoders it drives are unit-tested
// against real captured bytes. The `pg` peer is loaded lazily, so importing this stays free.
export { createPgReplicationClientFactory } from "./pg-replication-client";
export type { PgReplicationClientOptions, PgReplicationConfig } from "./pg-replication-client";

export { ShapeConnection } from "./connection";
export type { FrameController, ShapeConnectionOptions } from "./connection";

export { createLiveDataHttpHandlers, openShapeStream, subscribeSource } from "./http-handlers";
export type {
  LiveDataHttpHandlers,
  LiveDataHttpOptions,
  ShapeStreamConfig,
  ShapeStreamSource,
  StreamTimers,
} from "./http-handlers";

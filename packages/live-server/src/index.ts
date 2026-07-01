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
 *     for the v0 poll as the change feed. Inc1 ships the tap itself; swapping the engine to
 *     consume it (delete-from-shape via old/new images) is Inc2.
 *
 *   - {@link createLiveDataHttpHandlers} — the app-mounted `GET /__lesto/live-data`
 *     handler that streams a shape's snapshot + change tail over the runtime's
 *     long-lived-stream kind; {@link ShapeConnection} is its tested outbound core.
 */

export { LiveServerError } from "./errors";
export type { LiveServerErrorCode } from "./errors";

export { diffRows, normalizeWire, projectRow } from "./diff";
export type { DiffResult } from "./diff";

export { createShapeEngine } from "./engine";
export type {
  ShapeChangeListener,
  ShapeEngine,
  ShapeEngineOptions,
  ShapeSubscription,
  TimerSeam,
} from "./engine";

export { createPgReplicationSource, DEFAULT_SLOT } from "./replication";
export type {
  ChangeHandler,
  ChangeSource,
  DecodedChange,
  PgReplicationClient,
  PgReplicationSource,
  PgReplicationSourceOptions,
  ReplicationChange,
  RowImage,
  SourceErrorHandler,
  SystemIdentity,
} from "./replication";

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

/**
 * The shape engine — runs registered shapes against the ORM and fans authorized row
 * data (an initial snapshot + a change tail) to subscribers.
 *
 * **v0 change source: a full-table poll standing in for logical replication.** On every
 * tick the engine re-reads each active shape's table through `@lesto/db`, projects each
 * row to the shape's columns, folds it to wire form, and keeps only the rows that satisfy
 * the shape's predicate ({@link matchesShape}) — the *authorization/membership point,
 * where the principal's shape lives, never the database's output* (ADR 0042). It then
 * diffs that set against the last one and emits inserts / updates / delete-from-shape.
 * This is O(table) per tick — the deliberate v0 coarse floor.
 *
 * **v1 change source: a Postgres logical-replication tap.** When a {@link ChangeSource}
 * ({@link file://./replication.ts}) is configured, the engine consumes it *instead of*
 * polling: it seeds each shape's snapshot from the same `@lesto/db` read, then applies the
 * source's incremental old/new row images through the per-row **delete-from-shape**
 * classifier ({@link prepareShapeClassifier}) — projecting + coercing each image to the
 * shape's typed wire row ({@link createImageCoercer}), guarding the old image's completeness
 * per change ({@link assertOldImageComplete}), and fanning the resulting authorized change.
 * This is additive: the v0 SQLite poll is kept intact for dev parity; the two are mutually
 * exclusive per engine (behind the {@link ShapeEngineOptions.replication} seam), and both
 * share the one authz seam ({@link matchesShape}) so the security decision never forks.
 *
 * Safety: a shape names its table and columns as **strings**, so the engine validates
 * every one against a **registry of real `@lesto/db` tables** before it runs anything —
 * an unknown table/column, or a key column that is not provably unique, is refused
 * (never compiled into a query over an unvalidated identifier). The predicate itself is
 * structured and re-evaluated by us, so a client cannot inject SQL by naming a shape.
 */

import {
  compareRows,
  matchesShape,
  rowKey,
  shapeId,
  validateShapeDefinition,
} from "@lesto/live-protocol";
import type { Cursor, Row, RowKey, ShapeChange, ShapeDefinition } from "@lesto/live-protocol";
import type { Db, Table } from "@lesto/db";

import { prepareShapeClassifier } from "./classify";
import { createImageCoercer, requiredOldImageColumns } from "./coerce";
import { diffRows, normalizeWire, projectRow } from "./diff";
import { LiveServerError } from "./errors";
import type { ChangeSource, ReplicationChange, SystemIdentity } from "./replication";
import { encodeResumeCursor, isValidLsn, ShapeReplayRing } from "./resume";
import type { ResumeCursor } from "./resume";

/** The default full-table poll interval — 1s, tight enough to feel live in the dev loop. */
const DEFAULT_POLL_MS = 1000;

/** The default per-shape replay-ring window — the engine-side stand-in for the slot's WAL retention. */
const DEFAULT_REPLAY_MAX_ENTRIES = 1024;
const DEFAULT_REPLAY_MAX_AGE_MS = 300_000;

/**
 * The LSN sentinel a v1 snapshot cursor uses before any change has flowed through a shape — its
 * baseline "you are caught up to here". A reconnect from `0/0` replays the whole retained ring
 * (idempotently), which is sound; once real changes flow the baseline advances to the latest LSN.
 */
const LSN_BASE = "0/0";

/**
 * The timer seam — injected so a test drives ticks deterministically; defaults to a real,
 * `unref`'d interval (a poll loop must never keep the process alive on its own).
 */
export interface TimerSeam {
  setInterval(callback: () => void, ms: number): unknown;

  clearInterval(handle: unknown): void;
}

const realTimers: TimerSeam = {
  setInterval: (callback, ms) => {
    const timer = setInterval(callback, ms);

    timer.unref();

    return timer;
  },
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

/** A subscriber's per-change callback — one authorized change, stamped with its cursor. */
export type ShapeChangeListener = (change: ShapeChange, cursor: Cursor) => void;

/**
 * A subscriber's resync callback — fired (at most once) when the engine DROPS this shape because its
 * own server-side view diverged: a classifier throw (a refused key change, an incomplete old image)
 * or a dropped malformed-LSN change leaves the engine's `rows` and replay ring missing a change, so
 * the shape can no longer be trusted to tail or replay. The subscriber must purge its durable slice
 * and re-snapshot (a fresh subscribe re-seeds from the DB). Distinct from `onChange`, which only ever
 * carries an authorized incremental change. See {@link ShapeEngine.subscribe}'s `onResync` param.
 */
export type ShapeResyncListener = () => void;

/** One replayed change on resume — the change plus the cursor to re-stamp its frame with. */
export interface ReplayChange {
  readonly change: ShapeChange;
  readonly cursor: Cursor;
}

/**
 * How a connection should be brought up to date, decided from the reconnect cursor it presented
 * (ADR 0042 Inc4, LSN-exact resume):
 *
 *   - **`snapshot`** — send the full authorized snapshot. A fresh client (no cursor), or a
 *     re-snapshot: a cursor from a different cluster/timeline, aged past the ring, or a v0 (poll)
 *     stream. The client's `snapshot` frame authoritatively REPLACES its local slice, so a row it
 *     lost access to while away never lingers.
 *   - **`replay`** — send ONLY the missed changes (no snapshot); the client keeps its local slice
 *     and applies them, catching up LSN-exactly with no full re-fetch.
 */
export type ShapeResume =
  | { readonly kind: "snapshot" }
  | { readonly kind: "replay"; readonly changes: readonly ReplayChange[] };

/** What {@link ShapeEngine.subscribe} hands back: the initial snapshot + a way to stop. */
export interface ShapeSubscription {
  /** The shape's stable id (its subscribe/cache key). */
  readonly shapeId: string;

  /** The shape's current authorized rows, in the shape's total order — the initial snapshot. */
  readonly snapshot: readonly Row[];

  /** The cursor the snapshot was taken at; the change tail continues from here. */
  readonly cursor: Cursor;

  /**
   * How to reconcile the presented reconnect cursor: send the {@link snapshot}, or replay exactly
   * the missed changes. `{ kind: "snapshot" }` when no resumable cursor was presented (a fresh
   * client, or the coarse re-snapshot floor).
   */
  readonly resume: ShapeResume;

  /** Detach this subscriber; the shape stops being polled once its last subscriber leaves. */
  unsubscribe(): void;
}

/** The shape engine — subscribe to a shape, receive its snapshot + live change tail. */
export interface ShapeEngine {
  /**
   * Register interest in a shape: validate it against the table registry, seed (or reuse)
   * the shape's current authorized row set, and return the snapshot plus a change
   * subscription. Rejects (a coded {@link LiveServerError}) an unknown table/column or a
   * non-unique key column.
   *
   * `since` is the decoded reconnect cursor a resuming client presented (its `Last-Event-ID`), or
   * `undefined` for a fresh subscribe. When it proves continuity against the shape's replay ring
   * (v1 path only), the returned {@link ShapeSubscription.resume} carries the exact missed changes
   * to replay; otherwise it says `snapshot` (the re-snapshot floor).
   *
   * `onResync` (optional) is invoked if the engine later DROPS this shape because its server-side
   * view diverged (a classifier throw, a malformed-LSN change) — the subscriber must purge its slice
   * and re-snapshot. See {@link ShapeResyncListener}.
   */
  subscribe(
    def: ShapeDefinition,
    onChange: ShapeChangeListener,
    since?: ResumeCursor,
    onResync?: ShapeResyncListener,
  ): Promise<ShapeSubscription>;

  /** The number of distinct shapes currently being polled (introspection / tests). */
  readonly activeShapes: number;

  /** Stop the poll loop and drop every shape — the engine's teardown. */
  stop(): void;
}

/** One subscriber to a shape: its change sink, plus an optional resync sink (a shape-drop signal). */
interface ShapeSubscriber {
  readonly onChange: ShapeChangeListener;
  readonly onResync: ShapeResyncListener | undefined;
}

/** One live shape: its definition, table, keyed authorized rows, cursor, and subscribers. */
interface ShapeEntry {
  readonly def: ShapeDefinition;
  readonly table: Table;
  rows: Map<RowKey, Row>;
  cursor: number;
  readonly subscribers: Set<ShapeSubscriber>;

  /**
   * The shape's bound replication classifier — present only on the v1 change-source path, built
   * once at subscribe behind the `REPLICA IDENTITY FULL` guard. Applies one replication change's
   * old/new images (in/out/stay) to a {@link ShapeChange}, or `undefined` when the change does not
   * affect this shape. Absent on the v0 poll path.
   */
  readonly classify?: ((change: ReplicationChange) => ShapeChange | undefined) | undefined;

  /**
   * The shape's per-shape replay ring — present only on the v1 change-source path (Inc4). It
   * retains recently delivered changes keyed by commit LSN so a reconnecting client can replay
   * exactly what it missed. Absent on the v0 poll path (SQLite has no LSN → resync-on-reconnect).
   */
  readonly ring?: ShapeReplayRing | undefined;
}

/** Apply one classified change to a shape's keyed set so a later subscriber's snapshot is current. */
function applyChange(entry: ShapeEntry, change: ShapeChange): void {
  if (change.op === "delete") entry.rows.delete(change.key);
  else entry.rows.set(change.key, change.row);
}

/**
 * The **v0 (poll-path)** wire cursor: the shape's internal monotonic counter, versioned so it can
 * never be mistaken for a resumable position. SQLite has no LSN, so the poll path cannot prove
 * continuity — a `v0:` cursor {@link decodeResumeCursor}-decodes to `undefined`, forcing the coarse
 * re-snapshot floor (ADR 0042 acceptance (e)) on every reconnect. The `v0:` prefix is the guardrail
 * that kept Inc4's move to a `(systemId, timelineId, LSN)` token an *additive* wire change: because
 * nothing ever treated the cursor as a bare integer, the v1 `encodeResumeCursor` slots in beside it.
 * The v1 (replication) path mints its resumable cursor through {@link encodeResumeCursor} instead.
 */
function pollCursor(entry: ShapeEntry): Cursor {
  return `v0:${entry.cursor}`;
}

/**
 * Reconcile a reconnect cursor against a shape's replay ring. No cursor (a fresh client), or the
 * v0 poll path (no ring), → `snapshot`. Otherwise the ring decides: replay exactly the missed
 * changes — each re-stamped with its own LSN cursor so the client's `Last-Event-ID` keeps
 * advancing — or `snapshot`, the re-snapshot floor (a different cluster/timeline, or an LSN aged
 * past the retained window). Because the ring proved `since`'s identity matches, the replayed
 * cursors reuse it.
 */
function resumeFor(entry: ShapeEntry, since: ResumeCursor | undefined): ShapeResume {
  if (since === undefined || entry.ring === undefined) return { kind: "snapshot" };

  const reconcile = entry.ring.reconcile(since);

  if (reconcile.kind === "resync") return { kind: "snapshot" };

  const changes = reconcile.changes.map((item) => ({
    change: item.change,
    cursor: encodeResumeCursor({
      systemId: since.systemId,
      timelineId: since.timelineId,
      lsn: item.lsn,
    }),
  }));

  return { kind: "replay", changes };
}

/**
 * The v1 logical-replication change-source seam. Providing it switches the engine off the v0 poll
 * and onto {@link ChangeSource}'s incremental feed — both are bundled so opting in requires both the
 * feed and the catalog probe that guards each shape's replica identity (TypeScript enforces the
 * pair, so the guard can never be forgotten).
 *
 * **Precondition — `@lesto/db`-managed tables (ADR 0042, L-85a7660d).** Every shape-backing table on
 * this path must be defined through `@lesto/db` (`createTableSql`), so its `boolean`/`timestamp`
 * columns store as `INTEGER` and the replication tail's text-encoded values coerce byte-identically to
 * the v0 snapshot read. A **native pg** `boolean`/`timestamptz` column (raw DDL, a pre-existing table)
 * would silently desync snapshot vs. tail — see {@link createImageCoercer}. Not enforced at runtime;
 * treat it as an operational contract of using the replication source.
 */
export interface ReplicationSourceConfig {
  /**
   * The change feed to consume — a started {@link ChangeSource} (its `start`/`stop` slot lifecycle
   * is the caller's to own; the engine only subscribes to `onChange`). The feed is FULL and
   * unfiltered; the engine applies the shape's authorization to it.
   */
  readonly source: ChangeSource;

  /**
   * Whether a table is `REPLICA IDENTITY FULL` — the catalog fact (`pg_class.relreplident = 'f'`)
   * the delete-from-shape guard needs but the stream cannot signal. Called once per shape at
   * subscribe; a non-key-predicate shape on a non-`FULL` table is refused
   * (`LIVE_SERVER_REPLICA_IDENTITY_INSUFFICIENT`). Backed in production by the coverage-excluded
   * `createReplicaIdentityProbe`.
   */
  readonly replicaIdentity: (tableName: string) => Promise<boolean>;

  /**
   * The per-shape replay-ring window (Inc4) — the engine-side stand-in for the replication slot's
   * WAL retention. A reconnect within it replays its missed changes; one from before it (evicted)
   * re-snapshots. `maxEntries` defaults to 1024, `maxAgeMs` to 5 minutes, `now` to `Date.now`.
   */
  readonly replay?: {
    readonly maxEntries?: number;
    readonly maxAgeMs?: number;
    readonly now?: () => number;
  };
}

/** Options for {@link createShapeEngine}. */
export interface ShapeEngineOptions {
  /** The ORM handle the engine reads shapes through (the initial snapshot, both change sources). */
  readonly db: Db;

  /** The tables a shape may reference — the allowlist the shape is validated against. */
  readonly tables: readonly Table[];

  /** The full-table poll interval in ms. Defaults to 1000. Ignored when {@link replication} is set. */
  readonly pollMs?: number;

  /** The timer seam (injected for tests); defaults to a real, `unref`'d interval. */
  readonly timers?: TimerSeam;

  /**
   * The v1 logical-replication change source. When present the engine consumes it instead of
   * polling; when absent the engine runs the v0 SQLite full-table poll (dev parity).
   */
  readonly replication?: ReplicationSourceConfig;

  /**
   * Notified of a change-processing error (a failed poll query, a row missing its key, an
   * incomplete replication old image) so a tick/change can never crash the loop.
   */
  readonly onError?: (error: unknown) => void;
}

/**
 * Build a shape engine over a `@lesto/db` handle and a table registry.
 *
 * The poll loop starts lazily with the first shape and stops when the last subscriber
 * leaves, so an idle engine holds no timer. A tick is re-entrancy-guarded — a slow query
 * can never overlap the next tick — and any error inside it is routed to `onError`, never
 * thrown out of the timer.
 */
export function createShapeEngine(options: ShapeEngineOptions): ShapeEngine {
  const { db, onError, replication } = options;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const timers = options.timers ?? realTimers;

  const replayMaxEntries = replication?.replay?.maxEntries ?? DEFAULT_REPLAY_MAX_ENTRIES;
  const replayMaxAgeMs = replication?.replay?.maxAgeMs ?? DEFAULT_REPLAY_MAX_AGE_MS;
  const replayNow = replication?.replay?.now ?? Date.now;

  const tableMap = new Map<string, Table>(options.tables.map((table) => [table.tableName, table]));
  const shapes = new Map<string, ShapeEntry>();

  let pollHandle: unknown;
  let ticking = false;

  /**
   * The live database's identity, captured from the replication feed (every change is stamped with
   * it — Inc1). It anchors a fresh shape's v1 snapshot cursor: a reconnecting client compares its
   * cursor's `(systemId, timelineId)` against this to decide replay-vs-re-snapshot. `undefined`
   * until the first change flows (on the poll path it stays `undefined`, and the v0 cursor is used).
   */
  let liveIdentity: SystemIdentity | undefined;

  /** Validate a shape against the registry, returning its (real) table or throwing. */
  function resolveTable(def: ShapeDefinition): Table {
    const table = tableMap.get(def.table);

    if (table === undefined) {
      throw new LiveServerError(
        "LIVE_SERVER_UNKNOWN_TABLE",
        `Shape references table "${def.table}", which is not registered.`,
        { table: def.table },
      );
    }

    for (const column of def.columns) {
      if (!(column in table.byKey)) {
        throw new LiveServerError(
          "LIVE_SERVER_UNKNOWN_COLUMN",
          `Shape references column "${column}", which is not on table "${def.table}".`,
          { table: def.table, column },
        );
      }
    }

    // `def.key ∈ def.columns` (the protocol's validateShapeDefinition guarantees it) and
    // every column was just checked against the table, so the key column exists here.
    const keySpec = table.byKey[def.key]!;

    if (!keySpec.primaryKey && !keySpec.unique) {
      throw new LiveServerError(
        "LIVE_SERVER_NON_UNIQUE_KEY",
        `Shape key column "${def.key}" is neither a primary key nor unique, so it cannot identify rows.`,
        { table: def.table, key: def.key },
      );
    }

    return table;
  }

  /** Read a shape's current authorized row set: full-table read → project → wire → filter. */
  async function fetchRows(def: ShapeDefinition, table: Table): Promise<Row[]> {
    const raw = (await db.select().from(table).all()) as unknown as Row[];
    const out: Row[] = [];

    for (const row of raw) {
      const wire = normalizeWire(projectRow(row, def.columns));

      if (matchesShape(def, wire)) out.push(wire);
    }

    return out;
  }

  /** Re-read one shape, diff it, advance its cursor, and fan the changes to its subscribers. */
  async function tickShape(entry: ShapeEntry): Promise<void> {
    const nextRows = await fetchRows(entry.def, entry.table);
    const { changes, next } = diffRows(entry.def, entry.rows, nextRows);

    entry.rows = next;

    if (changes.length === 0) return;

    entry.cursor += 1;
    const cursor = pollCursor(entry);

    for (const change of changes) {
      for (const subscriber of entry.subscribers) subscriber.onChange(change, cursor);
    }
  }

  /** One poll tick over every active shape, guarded so ticks never overlap or crash the loop. */
  async function runTick(): Promise<void> {
    if (ticking) return;

    ticking = true;

    try {
      // Iterating the live map is safe: the `ticking` guard prevents an overlapping tick,
      // and Map iteration tolerates a shape unsubscribed (skipped) or added (seeded, so a
      // same-tick diff is a no-op) between `await`s.
      for (const entry of shapes.values()) {
        await tickShape(entry);
      }
    } catch (error) {
      onError?.(error);
    } finally {
      ticking = false;
    }
  }

  function ensurePolling(): void {
    if (pollHandle === undefined) {
      pollHandle = timers.setInterval(() => void runTick(), pollMs);
    }
  }

  function stopPolling(): void {
    if (pollHandle !== undefined) {
      timers.clearInterval(pollHandle);
      pollHandle = undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // v1: the logical-replication change-source path (mutually exclusive with the poll).
  // ---------------------------------------------------------------------------

  /**
   * Build a shape's bound replication classifier: the `@lesto/db`-backed coercer + the shape's
   * required old-image SQL columns, handed to the guarded `prepareShapeClassifier`, which folds in
   * BOTH guards — the registration-time replica identity check (throws
   * `LIVE_SERVER_REPLICA_IDENTITY_INSUFFICIENT` here if the shape needs the old image — a non-key
   * filter, OR a key that is a UNIQUE non-primary-key column, `keyIsPrimaryKey` below — but the table
   * is not `FULL`) and, in the closure it returns, the per-change old-image completeness re-check
   * (`LIVE_SERVER_OLD_IMAGE_INCOMPLETE` on a post-registration `FULL`→`DEFAULT` downgrade, or on an
   * unchanged external-TOAST predicate column absent from an otherwise-`FULL` old image). Awaits the
   * catalog probe, so it runs at subscribe, off the change path.
   */
  async function buildClassifier(
    def: ShapeDefinition,
    table: Table,
  ): Promise<(change: ReplicationChange) => ShapeChange | undefined> {
    const hasFullReplicaIdentity = await replication!.replicaIdentity(def.table);
    // `resolveTable` proved `def.key ∈ table` before this runs, so `byKey[def.key]` is present. A key
    // that is UNIQUE but not the primary key needs the FULL old image just as a non-key filter does
    // (see predicateNeedsOldImage) — thread the catalog fact so the registration guard sees it.
    const keyIsPrimaryKey = table.byKey[def.key]!.primaryKey;

    return prepareShapeClassifier(
      def,
      keyIsPrimaryKey,
      hasFullReplicaIdentity,
      createImageCoercer(def, table),
      requiredOldImageColumns(def, table),
    );
  }

  /**
   * Drop a shape whose server-side view has diverged and tell its subscribers to resync. A
   * classifier throw (a refused key change, an incomplete old image) or a dropped malformed-LSN
   * change happens BEFORE `applyChange`/`ring.record`, so the engine's OWN `rows` and replay ring
   * are left missing that change — the entry itself is diverged, not merely the client's slice. A
   * `resync` frame alone would be theater: a racing (or subsequent) re-subscribe would reuse the
   * still-alive diverged entry and re-serve the leak from `[...rows.values()]`. So remove the entry
   * FIRST — any re-subscribe then re-seeds from the DB (`fetchRows`) and re-runs the replica-identity
   * guard (a persistent misconfiguration surfaces as the loud registration error; a transient failure
   * converges) — THEN fan the resync so every subscriber purges its durable slice and re-snapshots.
   * (ADR 0042, L-802b3e7b.)
   */
  function dropShape(id: string, entry: ShapeEntry): void {
    shapes.delete(id);
    if (shapes.size === 0) stopPolling();

    for (const subscriber of entry.subscribers) {
      // Isolate each resync sink like the `onChange` fan-out: `dropShape` runs from
      // `onSourceChange`'s catch AND its invalid-LSN branch — OUTSIDE the per-shape try — so a
      // throwing sink would escape the change feed and wedge every shape's tail, breaking this
      // module's "one shape can never wedge the shared feed" invariant. Route it to `onError`.
      try {
        subscriber.onResync?.();
      } catch (error) {
        onError?.(error);
      }
    }
  }

  /**
   * The source's change sink: for every active shape on the change's table, classify the change and
   * — if it affects that shape — apply it, record it in the shape's replay ring, stamp it with a
   * resumable `(systemId, timelineId, LSN)` cursor, and fan it. Each shape is guarded independently:
   * a coercion/completeness/key-change throw routes to `onError` AND drops the diverged shape
   * (subscribers resync) — confined to that shape, so one misconfigured shape can never wedge the
   * shared feed nor leave its own subscribers silently stale.
   */
  function onSourceChange(change: ReplicationChange): void {
    // Reject a malformed commit LSN at ingest, before it can enter any shape's replay ring: a bad
    // LSN there would later throw in `compareLsn`'s `BigInt` parse on an UNRELATED reconnect's
    // reconcile (a cross-connection crash). The real `pgoutput` client always formats a valid LSN;
    // a custom `PgReplicationClient` that does not is a contract violation, surfaced loudly here.
    if (!isValidLsn(change.commitLSN)) {
      onError?.(
        new LiveServerError(
          "LIVE_SERVER_INVALID_LSN",
          `Replication change carried a malformed commit LSN "${change.commitLSN}".`,
          { lsn: change.commitLSN, table: change.table },
        ),
      );

      // The change is dropped entirely, so every shape on its table is now missing it — the same
      // server-side divergence a classifier throw causes. Drop each so its subscribers re-snapshot
      // rather than diverge silently until they happen to reconnect.
      for (const [id, entry] of shapes) {
        if (entry.def.table === change.table) dropShape(id, entry);
      }

      return;
    }

    // Capture the live database's identity from every change (Inc1 stamps it), even one that
    // matches no active shape — so a fresh shape's snapshot cursor is anchored to the current
    // cluster/timeline the moment any change has flowed.
    liveIdentity = { systemId: change.systemId, timelineId: change.timelineId };

    for (const [id, entry] of shapes) {
      if (entry.def.table !== change.table) continue;

      try {
        // Invariant: this sink is only wired when `replication` is set, and every shape registered
        // on a replication engine is built WITH a classifier (see `subscribe`), so `classify` is
        // present here — the poll path never reaches this function.
        const shapeChange = entry.classify!(change);

        if (shapeChange === undefined) continue;

        applyChange(entry, shapeChange);

        // Inc4: stamp the real commit LSN + system identity onto the cursor (no longer a discarded
        // counter), and retain the change in the shape's replay ring so a reconnecting client can
        // replay it LSN-exactly. The ring resets itself if `identity` crossed a failover.
        const identity = { systemId: change.systemId, timelineId: change.timelineId };
        entry.ring!.record(identity, change.commitLSN, shapeChange);
        const cursor = encodeResumeCursor({ ...identity, lsn: change.commitLSN });

        for (const subscriber of entry.subscribers) subscriber.onChange(shapeChange, cursor);
      } catch (error) {
        // The reachable throw here is the classifier's (a refused key change / incomplete old image);
        // it runs BEFORE applyChange/ring.record, so this shape's rows AND ring are missing the change
        // — the entry is diverged. Route the error to the operator, then drop the shape so its
        // subscribers purge + re-snapshot and any re-subscribe re-seeds from the DB — never leave the
        // diverged entry alive to re-serve the leak (L-802b3e7b).
        onError?.(error);
        dropShape(id, entry);
      }
    }
  }

  /**
   * The wire cursor a subscribe hands back with its snapshot. On the v1 path, anchor it to the live
   * identity + the shape's latest applied LSN (or the `0/0` baseline before any change), so a
   * reconnecting client can prove continuity against the ring. Before any change has revealed the
   * identity — and on the whole poll path — fall back to the (non-resumable) v0 cursor, which safely
   * forces a re-snapshot on reconnect.
   */
  function snapshotCursor(entry: ShapeEntry): Cursor {
    if (entry.ring !== undefined && liveIdentity !== undefined) {
      const ringIdentity = entry.ring.identity();
      const latest = entry.ring.latestLsn();

      // Stamp the shape's latest applied LSN only when the ring belongs to the SAME identity the
      // live feed is on now. In a narrow post-failover window a change on ANOTHER table advances
      // `liveIdentity` to the new (systemId, timelineId) while this shape's ring still holds
      // pre-failover entries — stamping its `latest` would mint a new-identity/stale-timeline-LSN
      // mix (`v1:newId:newTl:<old-lsn>`). Fall back to the `0/0` baseline instead, so the cursor is
      // obviously-correct. An empty ring (no change yet, or all evicted) also baselines here.
      if (
        ringIdentity !== undefined &&
        latest !== undefined &&
        ringIdentity.systemId === liveIdentity.systemId &&
        ringIdentity.timelineId === liveIdentity.timelineId
      ) {
        return encodeResumeCursor({ ...liveIdentity, lsn: latest });
      }

      return encodeResumeCursor({ ...liveIdentity, lsn: LSN_BASE });
    }

    return pollCursor(entry);
  }

  // Subscribe to the feed once, for the engine's life: the sink is a no-op until a shape registers,
  // and `stop()` detaches it. (The source's own start/stop + slot lifecycle is the caller's.)
  const detachSource = replication?.source.onChange(onSourceChange);

  return {
    async subscribe(def, onChange, since, onResync) {
      // Two gates: the protocol's structural trust boundary (key ∈ columns, scalar
      // values, a total order), then the engine's registry check (real table/columns,
      // unique key). Only then does anything touch the database.
      const validated = validateShapeDefinition(def);
      const table = resolveTable(validated);
      const id = shapeId(validated);

      let entry = shapes.get(id);

      if (entry === undefined) {
        // On the replication path, build the shape's guarded classifier BEFORE seeding — a shape
        // whose predicate needs the old image but whose table is not FULL is refused here (the
        // registration guard), so a rejected `subscribe` never seeds a shape it cannot safely tail.
        const classify = replication ? await buildClassifier(validated, table) : undefined;

        // The v1 replay ring (Inc4): retains recently delivered changes keyed by commit LSN so a
        // reconnecting client can replay LSN-exactly. Only on the replication path — the poll path
        // has no LSN, so it always re-snapshots on reconnect (the safe v0 floor).
        const ring = replication
          ? new ShapeReplayRing({
              maxEntries: replayMaxEntries,
              maxAgeMs: replayMaxAgeMs,
              now: replayNow,
            })
          : undefined;

        // Seed the shape's current set BEFORE publishing the entry, so a concurrent poll tick /
        // source change never sees a half-seeded shape. (A rare concurrent first-subscribe of the
        // same shape could seed twice; benign — the later entry simply wins.)
        //
        // UNFENCED seed↔tail window (ADR 0042, L-85e3eb10): on the replication path this snapshot is
        // a point-in-time `db.all()` taken at subscribe, while the source streams from the slot's OWN
        // confirmed LSN — with no fence between the two. A change committing between this read's
        // snapshot point and the entry being published (`shapes.set` below, after which
        // `onSourceChange` starts matching this shape) can be LOST or double-applied. Benign for keyed
        // inserts within a session (a re-insert overwrites by key; the classifier is idempotent per
        // key), but the shape can diverge until re-subscribe. Inc4 delivers the RESUME machinery
        // (the `(systemId, timelineId, LSN)` cursor + replay ring below) so a reconnect never
        // silently misses; a fully-fenced snapshot LSN (capture `pg_current_wal_lsn()` and
        // `START_REPLICATION` from it) is the remaining real-client coordination, tracked separately.
        const seeded = await fetchRows(validated, table);
        entry = {
          def: validated,
          table,
          rows: new Map(seeded.map((row) => [rowKey(row, validated.key), row])),
          cursor: 0,
          subscribers: new Set(),
          classify,
          ring,
        };
        shapes.set(id, entry);

        // The two change sources are mutually exclusive: poll only when there is no replication feed.
        if (replication === undefined) ensurePolling();
      }

      const active = entry;
      const subscriber: ShapeSubscriber = { onChange, onResync };
      active.subscribers.add(subscriber);

      const snapshot = [...active.rows.values()].toSorted((a, b) => compareRows(validated, a, b));

      // Reconcile the reconnect cursor against the ring BEFORE returning: replay the missed changes,
      // or fall back to the full snapshot (a fresh client, or the re-snapshot floor).
      const resume = resumeFor(active, since);

      let done = false;
      const unsubscribe = (): void => {
        if (done) return;
        done = true;

        const current = shapes.get(id);
        if (current === undefined) return;

        current.subscribers.delete(subscriber);

        if (current.subscribers.size === 0) {
          shapes.delete(id);
          if (shapes.size === 0) stopPolling();
        }
      };

      return { shapeId: id, snapshot, cursor: snapshotCursor(active), resume, unsubscribe };
    },

    get activeShapes() {
      return shapes.size;
    },

    stop() {
      stopPolling();
      detachSource?.();
      shapes.clear();
    },
  };
}

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
import { createImageCoercer } from "./coerce";
import { diffRows, normalizeWire, projectRow } from "./diff";
import { LiveServerError } from "./errors";
import type { ChangeSource, ReplicationChange } from "./replication";

/** The default full-table poll interval — 1s, tight enough to feel live in the dev loop. */
const DEFAULT_POLL_MS = 1000;

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

/** What {@link ShapeEngine.subscribe} hands back: the initial snapshot + a way to stop. */
export interface ShapeSubscription {
  /** The shape's stable id (its subscribe/cache key). */
  readonly shapeId: string;

  /** The shape's current authorized rows, in the shape's total order — the initial snapshot. */
  readonly snapshot: readonly Row[];

  /** The cursor the snapshot was taken at; the change tail continues from here. */
  readonly cursor: Cursor;

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
   */
  subscribe(def: ShapeDefinition, onChange: ShapeChangeListener): Promise<ShapeSubscription>;

  /** The number of distinct shapes currently being polled (introspection / tests). */
  readonly activeShapes: number;

  /** Stop the poll loop and drop every shape — the engine's teardown. */
  stop(): void;
}

/** One live shape: its definition, table, keyed authorized rows, cursor, and subscribers. */
interface ShapeEntry {
  readonly def: ShapeDefinition;
  readonly table: Table;
  rows: Map<RowKey, Row>;
  cursor: number;
  readonly subscribers: Set<ShapeChangeListener>;

  /**
   * The shape's bound replication classifier — present only on the v1 change-source path, built
   * once at subscribe behind the `REPLICA IDENTITY FULL` guard. Applies one replication change's
   * old/new images (in/out/stay) to a {@link ShapeChange}, or `undefined` when the change does not
   * affect this shape. Absent on the v0 poll path.
   */
  readonly classify?: ((change: ReplicationChange) => ShapeChange | undefined) | undefined;
}

/** Apply one classified change to a shape's keyed set so a later subscriber's snapshot is current. */
function applyChange(entry: ShapeEntry, change: ShapeChange): void {
  if (change.op === "delete") entry.rows.delete(change.key);
  else entry.rows.set(change.key, change.row);
}

/**
 * The v1 logical-replication change-source seam. Providing it switches the engine off the v0 poll
 * and onto {@link ChangeSource}'s incremental feed — both are bundled so opting in requires both the
 * feed and the catalog probe that guards each shape's replica identity (TypeScript enforces the
 * pair, so the guard can never be forgotten).
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

  const tableMap = new Map<string, Table>(options.tables.map((table) => [table.tableName, table]));
  const shapes = new Map<string, ShapeEntry>();

  let pollHandle: unknown;
  let ticking = false;

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
    const cursor = String(entry.cursor);

    for (const change of changes) {
      for (const subscriber of entry.subscribers) subscriber(change, cursor);
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
   * Build a shape's bound replication classifier: the `@lesto/db`-backed coercer handed to the
   * guarded `prepareShapeClassifier`, which folds in BOTH guards — the registration-time replica
   * identity check (throws `LIVE_SERVER_REPLICA_IDENTITY_INSUFFICIENT` here if the shape needs the
   * old image but the table is not `FULL`) and, in the closure it returns, the per-change old-image
   * completeness re-check (`LIVE_SERVER_OLD_IMAGE_INCOMPLETE` on a post-registration `FULL`→`DEFAULT`
   * downgrade). Awaits the catalog probe, so it runs at subscribe, off the change path.
   */
  async function buildClassifier(
    def: ShapeDefinition,
    table: Table,
  ): Promise<(change: ReplicationChange) => ShapeChange | undefined> {
    const hasFullReplicaIdentity = await replication!.replicaIdentity(def.table);

    return prepareShapeClassifier(def, hasFullReplicaIdentity, createImageCoercer(def, table));
  }

  /**
   * The source's change sink: for every active shape on the change's table, classify the change and
   * — if it affects that shape — apply it, advance the cursor, and fan it. Each shape is guarded
   * independently (a coercion/completeness/key-change throw routes to `onError` and is confined to
   * that shape) so one misconfigured shape can never wedge the shared feed.
   */
  function onSourceChange(change: ReplicationChange): void {
    for (const entry of shapes.values()) {
      if (entry.def.table !== change.table) continue;

      try {
        // Invariant: this sink is only wired when `replication` is set, and every shape registered
        // on a replication engine is built WITH a classifier (see `subscribe`), so `classify` is
        // present here — the poll path never reaches this function.
        const shapeChange = entry.classify!(change);

        if (shapeChange === undefined) continue;

        applyChange(entry, shapeChange);
        entry.cursor += 1;
        const cursor = String(entry.cursor);

        for (const subscriber of entry.subscribers) subscriber(shapeChange, cursor);
      } catch (error) {
        onError?.(error);
      }
    }
  }

  // Subscribe to the feed once, for the engine's life: the sink is a no-op until a shape registers,
  // and `stop()` detaches it. (The source's own start/stop + slot lifecycle is the caller's.)
  const detachSource = replication?.source.onChange(onSourceChange);

  return {
    async subscribe(def, onChange) {
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

        // Seed the shape's current set BEFORE publishing the entry, so a concurrent poll tick /
        // source change never sees a half-seeded shape. (A rare concurrent first-subscribe of the
        // same shape could seed twice; benign — the later entry simply wins.)
        const seeded = await fetchRows(validated, table);
        entry = {
          def: validated,
          table,
          rows: new Map(seeded.map((row) => [rowKey(row, validated.key), row])),
          cursor: 0,
          subscribers: new Set(),
          classify,
        };
        shapes.set(id, entry);

        // The two change sources are mutually exclusive: poll only when there is no replication feed.
        if (replication === undefined) ensurePolling();
      }

      const active = entry;
      active.subscribers.add(onChange);

      const snapshot = [...active.rows.values()].toSorted((a, b) => compareRows(validated, a, b));

      let done = false;
      const unsubscribe = (): void => {
        if (done) return;
        done = true;

        const current = shapes.get(id);
        if (current === undefined) return;

        current.subscribers.delete(onChange);

        if (current.subscribers.size === 0) {
          shapes.delete(id);
          if (shapes.size === 0) stopPolling();
        }
      };

      return { shapeId: id, snapshot, cursor: String(active.cursor), unsubscribe };
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

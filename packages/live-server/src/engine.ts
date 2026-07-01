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
 * This is O(table) per tick — the deliberate v0 coarse floor; v1 replaces the poll with a
 * `pgoutput` replication tap keyed by commit LSN, but the engine's diff + authz seam are
 * unchanged.
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

import { diffRows, normalizeWire, projectRow } from "./diff";
import { LiveServerError } from "./errors";

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
}

/** Options for {@link createShapeEngine}. */
export interface ShapeEngineOptions {
  /** The ORM handle the engine reads shapes through. */
  readonly db: Db;

  /** The tables a shape may reference — the allowlist the shape is validated against. */
  readonly tables: readonly Table[];

  /** The full-table poll interval in ms. Defaults to 1000. */
  readonly pollMs?: number;

  /** The timer seam (injected for tests); defaults to a real, `unref`'d interval. */
  readonly timers?: TimerSeam;

  /** Notified of a poll error (a failed query, a row missing its key) so a tick can never crash the loop. */
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
  const { db, onError } = options;
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
        // Seed the shape's current set BEFORE publishing the entry, so a concurrent poll
        // tick never sees a half-seeded shape. (A rare concurrent first-subscribe of the
        // same shape could seed twice; benign for v0 — the later entry simply wins.)
        const seeded = await fetchRows(validated, table);
        entry = {
          def: validated,
          table,
          rows: new Map(seeded.map((row) => [rowKey(row, validated.key), row])),
          cursor: 0,
          subscribers: new Set(),
        };
        shapes.set(id, entry);
        ensurePolling();
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
      shapes.clear();
    },
  };
}

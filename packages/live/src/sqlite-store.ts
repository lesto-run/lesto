/**
 * The **durable** client store — one shape's authorized row slice held in SQLite instead of
 * a `Map` (ADR 0042 Tier 4, v1 Inc5). Opt-in; the in-memory {@link createLiveStore} stays
 * the default. In the browser the SQLite is `@sqlite.org/sqlite-wasm` over the Origin Private
 * File System ({@link openOpfsSqliteDatabase}); under a test it is a plain better-sqlite3 adapter.
 * Either way this file speaks only the async {@link SqlDatabase} seam, so nothing here is
 * browser-bound and everything is testable.
 *
 * ## The one invariant that matters: rows and the cursor advance atomically
 *
 * Resume hinges on the client knowing *exactly* which changes it has already applied. So the
 * last-applied `(systemId, timelineId, LSN)` {@link Cursor} lives in a single-row meta table
 * (`lesto_live_cursor`) and is written in the **same transaction** as every row batch. A crash
 * mid-write therefore leaves a consistent `(rows, cursor)` pair — never rows-ahead-of-cursor (a
 * change silently re-applied on resume) or, the dangerous one, **cursor-ahead-of-rows** (a change
 * silently dropped, because resume would start past a row that was never persisted). SQLite's
 * transaction gives us that atomicity for free; the discipline is only ever putting the two
 * writes in one {@link SqlDatabase.transaction} span.
 *
 * ## Sync reads over an async engine
 *
 * A UI reads the store through `useSyncExternalStore`, which is synchronous, so `getRows()`
 * cannot `await` SQLite. The store therefore keeps an in-memory **mirror** (`rowsByKey`) that a
 * mutation updates synchronously — instant local reads, and the same stable-reference
 * `getRows()` cache the in-memory store documents — while the durable write is enqueued behind
 * it. The mirror is the live read model; SQLite is the durability tier that survives reload.
 * On open we hydrate the mirror (and the cursor) from SQLite, so a reload paints the last
 * persisted slice before the network reconnects.
 *
 * ## Write ordering + failure
 *
 * Durable writes run FIFO on an internal promise chain, so batches land in mutation order even
 * though each is async, and a failure never rolls back the mirror (the live session stays
 * correct). A failed write **freezes** the durable tier: subsequent *incremental* writes are
 * dropped so the persisted cursor cannot advance past the row the failed write never wrote, while
 * a full-slice write (a snapshot or resync) still runs — it restores a consistent (rows, cursor)
 * pair and thaws the tier. The failure is surfaced to `onError` so the app can force that resync.
 * {@link SqliteLiveStore.whenIdle} resolves once the currently-queued writes have settled — for
 * graceful teardown and deterministic tests.
 */

import { compareRows, rowKey, shapeId } from "@lesto/live-protocol";
import type { Cursor, Row, RowKey, ShapeChange, ShapeDefinition } from "@lesto/live-protocol";
import type { SqlDatabase } from "@lesto/db";

import type { LiveStore } from "./store";

/** A durable {@link LiveStore} plus a hook to await its outstanding durable writes. */
export interface SqliteLiveStore extends LiveStore {
  /**
   * Resolve once every durable write queued *so far* has settled (committed or failed-and-
   * reported). Use it to flush before teardown, or to await durability in a test. Writes
   * queued after the call are not awaited — call it again.
   */
  whenIdle(): Promise<void>;
}

/** Options for {@link createSqliteLiveStore}. */
export interface CreateSqliteLiveStoreOptions {
  /** The bound shape — keys and sorts rows exactly as the server did, and namespaces the tables. */
  readonly def: ShapeDefinition;

  /**
   * The SQLite engine, as the async {@link SqlDatabase} seam. Its `transaction` MUST pin one
   * connection for the whole span (the atomicity this store's guarantee rests on) —
   * `@lesto/runtime`'s `openSqlite` and {@link openOpfsSqliteDatabase} both do.
   */
  readonly db: SqlDatabase;

  /**
   * Notified when a durable write fails (the mirror is already correct; durability lagged).
   * A handler typically triggers a resync. Absent → the failure is swallowed after keeping the
   * write chain alive.
   */
  readonly onError?: (error: unknown) => void;
}

/** The empty settle handler for the write chain — a rolled-back write needs no follow-up. */
const noop = (): void => {};

/** The two tables the durable store owns — created idempotently, shared across shapes by `shape` key. */
const SCHEMA_SQL =
  "CREATE TABLE IF NOT EXISTS lesto_live_rows (" +
  "shape TEXT NOT NULL, key TEXT NOT NULL, row TEXT NOT NULL, PRIMARY KEY (shape, key));" +
  "CREATE TABLE IF NOT EXISTS lesto_live_cursor (shape TEXT PRIMARY KEY, cursor TEXT);";

/**
 * Build the durable OPFS-SQLite store for a shape. Awaits the schema install and hydrates the
 * in-memory mirror + cursor from any previously-persisted slice, so the returned store is
 * immediately readable (and reflects a prior session on reload). All later mutations mirror
 * synchronously and persist atomically behind the FIFO write chain.
 */
export async function createSqliteLiveStore(
  options: CreateSqliteLiveStoreOptions,
): Promise<SqliteLiveStore> {
  const { def, db, onError } = options;
  const shape = shapeId(def);

  await db.exec(SCHEMA_SQL);

  // Hydrate the read model from durability. A reload lands here with the last persisted slice.
  const rowsByKey = new Map<RowKey, Row>();

  const persistedRows = (await db
    .prepare("SELECT key, row FROM lesto_live_rows WHERE shape = ?")
    .all([shape])) as ReadonlyArray<{ key: string; row: string }>;

  for (const { key, row } of persistedRows) {
    rowsByKey.set(key as RowKey, JSON.parse(row) as Row);
  }

  // A cleared cursor is a row DELETE, never a stored NULL, so the column is always non-null
  // when present — a missing row (fresh open / post-resync) is simply `undefined`.
  const persistedCursor = (await db
    .prepare("SELECT cursor FROM lesto_live_cursor WHERE shape = ?")
    .get([shape])) as { cursor: string } | undefined;

  let cursor: Cursor | undefined = persistedCursor?.cursor;

  // The lazy sorted-snapshot cache — identical contract to the in-memory store: `getRows()`
  // returns the SAME array between mutations so `useSyncExternalStore` stops re-rendering.
  let cache: readonly Row[] = [];
  let dirty = true;

  const listeners = new Set<() => void>();

  // Every mutation dirties the read cache and notifies subscribers — one place, so a mirror
  // update can never skip either.
  const mutated = (): void => {
    dirty = true;

    for (const listener of listeners) listener();
  };

  const report = onError ?? noop;

  // The FIFO durability chain: each write runs only after the previous has settled, so batches
  // persist in mutation order, and `whenIdle` (the tail) resolves whether a write committed or
  // failed-and-was-reported — it never rejects.
  //
  // The `frozen` guard closes the one gap transaction-atomicity alone does not. A crash (a torn
  // write) cannot advance the cursor past unpersisted rows — each write is one atomic transaction.
  // But a *non-fatal* mid-session failure (e.g. the browser's storage quota) could: if an
  // incremental write fails while a later one commits, the persisted cursor would sit past the
  // row the failed write never wrote — a silent drop on reload. So a failure freezes the tier and
  // incremental writes stop; only a full-slice write (a snapshot or resync, `replaces`) runs while
  // frozen — it re-establishes a consistent (rows, cursor) pair and thaws. The persisted cursor
  // therefore always matches the persisted rows, so a reload resumes from a point the rows reached.
  let frozen = false;
  let writeChain: Promise<void> = Promise.resolve();

  // Run one durable write, honoring the freeze. Kept as a plain async function (not a `.then`
  // callback) so its side-effecting control flow reads straight.
  const runWrite = async (
    work: (tx: SqlDatabase) => Promise<void>,
    replaces: boolean,
  ): Promise<void> => {
    if (frozen && !replaces) return;

    try {
      await db.transaction((tx) => work(tx));

      if (replaces) frozen = false;
    } catch (error) {
      frozen = true;
      report(error);
    }
  };

  const enqueue = (work: (tx: SqlDatabase) => Promise<void>, replaces: boolean): void => {
    writeChain = writeChain.then(() => runWrite(work, replaces));
  };

  // Persist a whole-slice replacement (a snapshot / a resync) with its cursor, atomically:
  // clear this shape's rows, insert the batch, then upsert (or clear) the cursor — all in one
  // transaction, so the cursor never lands without the rows it points past.
  const persistSnapshot = (rows: readonly Row[], nextCursor: Cursor | undefined): void => {
    enqueue(async (tx) => {
      await tx.prepare("DELETE FROM lesto_live_rows WHERE shape = ?").run([shape]);

      const insert = tx.prepare("INSERT INTO lesto_live_rows (shape, key, row) VALUES (?, ?, ?)");

      for (const row of rows) {
        await insert.run([shape, rowKey(row, def.key), JSON.stringify(row)]);
      }

      await persistCursor(tx, nextCursor);
    }, true);
  };

  // Persist one row op with its cursor, atomically.
  const persistChange = (change: ShapeChange, nextCursor: Cursor | undefined): void => {
    enqueue(async (tx) => {
      if (change.op === "delete") {
        await tx
          .prepare("DELETE FROM lesto_live_rows WHERE shape = ? AND key = ?")
          .run([shape, change.key]);
      } else {
        await tx
          .prepare(
            "INSERT INTO lesto_live_rows (shape, key, row) VALUES (?, ?, ?) " +
              "ON CONFLICT(shape, key) DO UPDATE SET row = excluded.row",
          )
          .run([shape, change.key, JSON.stringify(change.row)]);
      }

      await persistCursor(tx, nextCursor);
    }, false);
  };

  // Upsert the single cursor row, or delete it when the cursor is cleared (a resync). Always
  // runs inside the caller's transaction — that colocation IS the atomicity guarantee.
  const persistCursor = async (tx: SqlDatabase, nextCursor: Cursor | undefined): Promise<void> => {
    if (nextCursor === undefined) {
      await tx.prepare("DELETE FROM lesto_live_cursor WHERE shape = ?").run([shape]);

      return;
    }

    await tx
      .prepare(
        "INSERT INTO lesto_live_cursor (shape, cursor) VALUES (?, ?) " +
          "ON CONFLICT(shape) DO UPDATE SET cursor = excluded.cursor",
      )
      .run([shape, nextCursor]);
  };

  return {
    applySnapshot(rows, nextCursor) {
      // Build the fresh mirror first (a bad row throws in `rowKey`) and swap only on success,
      // so a malformed snapshot leaves the live slice — and the durable one — untouched, never
      // half-applied. Then persist the same batch atomically.
      const next = new Map<RowKey, Row>();

      for (const row of rows) next.set(rowKey(row, def.key), row);

      rowsByKey.clear();
      for (const [key, row] of next) rowsByKey.set(key, row);

      cursor = nextCursor;
      persistSnapshot(rows, nextCursor);
      mutated();
    },

    applyChange(change, nextCursor) {
      if (change.op === "delete") rowsByKey.delete(change.key);
      else rowsByKey.set(change.key, change.row);

      cursor = nextCursor;
      persistChange(change, nextCursor);
      mutated();
    },

    applyResync() {
      rowsByKey.clear();
      cursor = undefined;
      // Clear rows AND cursor together — the durable floor mirrors the in-memory floor.
      persistSnapshot([], undefined);
      mutated();
    },

    getRows() {
      if (dirty) {
        cache = [...rowsByKey.values()].toSorted((a, b) => compareRows(def, a, b));
        dirty = false;
      }

      return cache;
    },

    getCursor() {
      return cursor;
    },

    subscribe(listener) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },

    whenIdle() {
      return writeChain;
    },
  };
}

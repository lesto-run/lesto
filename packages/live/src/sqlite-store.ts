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
 * `getRows()` cache the in-memory store documents (both now delegate to the shared
 * {@link createReadModel}) — while the durable write is enqueued behind it. The mirror is the
 * live read model's row source; SQLite is the durability tier that survives reload. On open we
 * hydrate the mirror (and the cursor) from SQLite, so a reload paints the last persisted slice
 * before the network reconnects.
 *
 * ## Hydration runs inside the same transactional FIFO as every write
 *
 * The schema install (`CREATE TABLE IF NOT EXISTS`) and the two hydration `SELECT`s run inside
 * a single {@link SqlDatabase.transaction} span, exactly like every later write. This matters
 * because several shapes can share one OPFS database (the default single `lesto-live.sqlite3`):
 * `SqlDatabase.transaction` pins one connection and serializes on its FIFO chain, so opening
 * shape B while shape A has a write transaction in flight queues B's schema install + reads
 * behind A's commit, instead of letting them run as bare `exec`/`prepare` calls that could
 * interleave into A's open `BEGIN..COMMIT` span on the shared connection.
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
 *
 * ## The offline-write outbox (Inc6)
 *
 * A third table, `lesto_live_outbox`, durably holds pending client writes made while offline (or
 * simply in flight) — the OPFS half of "an offline write survives reload". It is driven by the
 * outbox module (`./outbox`) through the {@link LiveStore.outbox} capability this store exposes,
 * NOT by the wire. Its writes share the FIFO chain (so they serialize on the one connection and
 * `whenIdle` awaits them) but bypass the rows/cursor freeze (`enqueueRaw`): the outbox is an
 * independent table, and a frozen tier must never silently drop a durable offline write. The
 * optimistic *view* of those writes is not persisted separately — it is rebuilt into the read
 * model's overlay from this log on reload, so the log is the single source of truth.
 */

import { rowKey, shapeId } from "@lesto/live-protocol";
import type { Cursor, Row, RowKey, ShapeChange, ShapeDefinition } from "@lesto/live-protocol";
import type { SqlDatabase } from "@lesto/db";

import { createReadModel } from "./read-model";
import type { LiveStore, OutboxEntry } from "./store";

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

/**
 * The three tables the durable store owns — created idempotently, shared across shapes by `shape`
 * key. `lesto_live_outbox` is the offline-write log (ADR 0042 Inc6): one row per pending mutation,
 * ordered by insertion (`rowid`), so a write made offline survives reload and is replayed on
 * reconnect through the app's normal authorized mutation `POST` (see `./outbox`).
 */
const SCHEMA_SQL =
  "CREATE TABLE IF NOT EXISTS lesto_live_rows (" +
  "shape TEXT NOT NULL, key TEXT NOT NULL, row TEXT NOT NULL, PRIMARY KEY (shape, key));" +
  "CREATE TABLE IF NOT EXISTS lesto_live_cursor (shape TEXT PRIMARY KEY, cursor TEXT);" +
  "CREATE TABLE IF NOT EXISTS lesto_live_outbox (" +
  "shape TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, input TEXT NOT NULL, " +
  "optimistic TEXT NOT NULL, PRIMARY KEY (shape, id));";

/** What hydration reads back out of SQLite before the store is usable. */
interface Hydrated {
  readonly rowsByKey: Map<RowKey, Row>;
  readonly cursor: Cursor | undefined;
  readonly outbox: readonly OutboxEntry[];
}

/**
 * Install the schema (idempotently) and read back this shape's persisted rows + cursor + outbox,
 * all in one `db.transaction` span — see the module doc's "Hydration runs inside the same
 * transactional FIFO as every write" section for why this must not run as bare `exec`/`prepare`
 * calls.
 */
async function hydrate(db: SqlDatabase, shape: string): Promise<Hydrated> {
  return db.transaction(async (tx) => {
    await tx.exec(SCHEMA_SQL);

    const rowsByKey = new Map<RowKey, Row>();

    const persistedRows = (await tx
      .prepare("SELECT key, row FROM lesto_live_rows WHERE shape = ?")
      .all([shape])) as ReadonlyArray<{ key: string; row: string }>;

    for (const { key, row } of persistedRows) {
      rowsByKey.set(key as RowKey, JSON.parse(row) as Row);
    }

    // A cleared cursor is a row DELETE, never a stored NULL, so the column is always non-null
    // when present — a missing row (fresh open / post-resync) is simply `undefined`.
    const persistedCursor = (await tx
      .prepare("SELECT cursor FROM lesto_live_cursor WHERE shape = ?")
      .get([shape])) as { cursor: string } | undefined;

    // The pending offline writes, in submission order (`rowid`) — replayed on reconnect. `input`
    // and `optimistic` are the JSON the writer stored (see `persistOutboxAppend`); parse them back
    // to the `OutboxEntry` shape the outbox module rebuilds its queue + overlay from.
    const persistedOutbox = (await tx
      .prepare(
        "SELECT id, name, input, optimistic FROM lesto_live_outbox WHERE shape = ? ORDER BY rowid",
      )
      .all([shape])) as ReadonlyArray<{
      id: string;
      name: string;
      input: string;
      optimistic: string;
    }>;

    const outbox = persistedOutbox.map<OutboxEntry>((entry) => ({
      id: entry.id,
      name: entry.name,
      input: JSON.parse(entry.input) as unknown,
      optimistic: JSON.parse(entry.optimistic) as ShapeChange,
    }));

    return { rowsByKey, cursor: persistedCursor?.cursor, outbox };
  });
}

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

  // Hydrate the read model from durability. A reload lands here with the last persisted slice AND
  // the pending offline writes (`hydratedOutbox`), which the outbox module reads back via
  // `outbox.load()` to rebuild its queue and re-apply the optimistic overlay before reconnect.
  const { rowsByKey, cursor: hydratedCursor, outbox: hydratedOutbox } = await hydrate(db, shape);

  // The shared read model owns the sorted-cache, the listeners, and the cursor — identical
  // contract to the in-memory store: `getRows()` returns the SAME array between mutations so
  // `useSyncExternalStore` stops re-rendering. It reads `rowsByKey` fresh (via the thunk), so
  // this store's clear-and-refill mutation strategy below is invisible to it.
  const readModel = createReadModel(def, () => rowsByKey.values());

  readModel.setCursor(hydratedCursor);

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

      // A caller's `onError` that itself throws must never wedge the chain: an unhandled rejection
      // here would strand every later write (including the full-slice write meant to thaw the tier)
      // and reject `whenIdle`, which is contracted never to reject.
      try {
        report(error);
      } catch {
        // Swallow: the write already rolled back atomically; the report is best-effort.
      }
    }
  };

  const enqueue = (work: (tx: SqlDatabase) => Promise<void>, replaces: boolean): void => {
    writeChain = writeChain.then(() => runWrite(work, replaces));
  };

  // Run one outbox write. Like `runWrite` but with NO `frozen` gate and no freeze-on-failure: the
  // outbox is an independent table whose consistency does not interact with the (rows, cursor)
  // atomicity the freeze protects, and a frozen tier must NOT silently drop a durable offline write
  // — that would lose it across a reload, the one thing this log exists to prevent. A failure is
  // reported (the in-memory queue stays authoritative for the session), never frozen. A throwing
  // `onError` must not wedge the chain, same as `runWrite`.
  const runRaw = async (work: (tx: SqlDatabase) => Promise<void>): Promise<void> => {
    try {
      await db.transaction((tx) => work(tx));
    } catch (error) {
      try {
        report(error);
      } catch {
        // Swallow: the write rolled back atomically; the report is best-effort.
      }
    }
  };

  // Enqueue an outbox write on the SAME FIFO chain (so it serializes on the one pinned connection
  // and `whenIdle` awaits it), outside the rows/cursor freeze — see {@link runRaw}.
  const enqueueRaw = (work: (tx: SqlDatabase) => Promise<void>): void => {
    writeChain = writeChain.then(() => runRaw(work));
  };

  // Durably append one outbox entry. `input` and `optimistic` are stored as JSON — `input ?? null`
  // mirrors the mutation client's own `JSON.stringify(input ?? null)`, so a no-arg mutation's
  // `undefined` round-trips to `null` exactly as its replayed `POST` body would. An `INSERT OR
  // REPLACE` (upsert on the (shape, id) PK) keeps a resubmit of the same id idempotent.
  const persistOutboxAppend = (entry: OutboxEntry): void => {
    enqueueRaw(async (tx) => {
      await tx
        .prepare(
          "INSERT INTO lesto_live_outbox (shape, id, name, input, optimistic) VALUES (?, ?, ?, ?, ?) " +
            "ON CONFLICT(shape, id) DO UPDATE SET name = excluded.name, input = excluded.input, " +
            "optimistic = excluded.optimistic",
        )
        .run([
          shape,
          entry.id,
          entry.name,
          JSON.stringify(entry.input ?? null),
          JSON.stringify(entry.optimistic),
        ]);
    });
  };

  // Durably remove one outbox entry (its mutation was acked or rejected).
  const persistOutboxRemove = (id: string): void => {
    enqueueRaw(async (tx) => {
      await tx.prepare("DELETE FROM lesto_live_outbox WHERE shape = ? AND id = ?").run([shape, id]);
    });
  };

  // Persist a whole-slice replacement (a snapshot / a resync) with its cursor, atomically:
  // clear this shape's rows, insert the batch, then upsert (or clear) the cursor — all in one
  // transaction, so the cursor never lands without the rows it points past.
  const persistSnapshot = (rows: readonly Row[], nextCursor: Cursor | undefined): void => {
    enqueue(async (tx) => {
      await tx.prepare("DELETE FROM lesto_live_rows WHERE shape = ?").run([shape]);

      // Upsert (not a plain INSERT) so a snapshot carrying a duplicate key is last-wins — matching
      // the mirror's `Map`, which dedups silently; a plain INSERT would throw on the PK and freeze
      // the tier, diverging the durable slice from the mirror on the very same input.
      const insert = tx.prepare(
        "INSERT INTO lesto_live_rows (shape, key, row) VALUES (?, ?, ?) " +
          "ON CONFLICT(shape, key) DO UPDATE SET row = excluded.row",
      );

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

      readModel.setCursor(nextCursor);
      persistSnapshot(rows, nextCursor);
      readModel.mutated();
    },

    applyChange(change, nextCursor) {
      if (change.op === "delete") rowsByKey.delete(change.key);
      else rowsByKey.set(change.key, change.row);

      readModel.setCursor(nextCursor);
      persistChange(change, nextCursor);
      readModel.mutated();
    },

    applyResync() {
      rowsByKey.clear();
      readModel.setCursor(undefined);
      // Clear rows AND cursor together — the durable floor mirrors the in-memory floor. The outbox
      // is untouched: a resync abandons the authorized slice, but a pending offline write is
      // unrelated state that must still be replayed (the outbox owns clearing it, not the wire).
      persistSnapshot([], undefined);
      readModel.mutated();
    },

    applyOptimistic(change) {
      // Overlay only — the authorized rows/cursor are wire-only, and durability of the optimistic
      // view comes from the outbox log (rebuilt into the overlay on reload), not the rows table.
      readModel.setOptimistic(change);
      readModel.mutated();
    },

    clearOptimistic(key) {
      readModel.clearOptimistic(key);
      readModel.mutated();
    },

    getRows: readModel.getRows,
    getCursor: readModel.getCursor,
    subscribe: readModel.subscribe,

    shapeId: shape,

    // The durable outbox (ADR 0042 Inc6): `load` returns what hydration read (submission order),
    // `append`/`remove` enqueue on the FIFO chain outside the rows freeze (see `enqueueRaw`).
    outbox: {
      load: () => hydratedOutbox,
      append: persistOutboxAppend,
      remove: persistOutboxRemove,
    },

    whenIdle() {
      return writeChain;
    },
  };
}

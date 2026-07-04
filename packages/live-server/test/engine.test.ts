import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDb, createTableSql, defineTable, eq, integer, text, timestamp } from "@lesto/db";
import type { Db, SqlDatabase } from "@lesto/db";
import { LiveProtocolError } from "@lesto/live-protocol";
import type { Cursor, Row, ShapeChange, ShapeDefinition } from "@lesto/live-protocol";

import { createShapeEngine, decodeResumeCursor, LiveServerError } from "../src/index";
import type {
  ChangeHandler,
  ChangeSource,
  OldImageKind,
  ReplicationChange,
  RowImage,
  ShapeEngine,
  ShapeResume,
  TimerSeam,
} from "../src/index";

// ---------------------------------------------------------------------------
// Test rig: an in-memory SQLite adapted to `SqlDatabase` (async terminals), plus a
// hand-fired timer seam so every poll tick is deterministic.
// ---------------------------------------------------------------------------

function adapt(database: Database.Database): SqlDatabase {
  const adapted: SqlDatabase = {
    exec: async (statement) => {
      database.exec(statement);
    },
    prepare: (statement) => {
      const stmt = database.prepare(statement);

      return {
        run: async (params = []) => stmt.run(...(params as never[])),
        get: async (params = []) => stmt.get(...(params as never[])),
        all: async (params = []) => stmt.all(...(params as never[])),
      };
    },
    transaction: async (fn) => {
      database.exec("BEGIN");

      try {
        const out = await fn(adapted);
        database.exec("COMMIT");

        return out;
      } catch (error) {
        try {
          database.exec("ROLLBACK");
        } catch {
          /* preserve the original error */
        }

        throw error;
      }
    },
  };

  return adapted;
}

const messages = defineTable("messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  roomId: integer("room_id").notNull(),
  body: text("body").notNull(),
  createdAt: timestamp("created_at").notNull(),
});

/** The room-1 shape: `messages WHERE room_id = 1`, oldest first, keyed by id. */
function room1Shape(overrides: Partial<ShapeDefinition> = {}): ShapeDefinition {
  return {
    table: "messages",
    key: "id",
    columns: ["id", "roomId", "body", "createdAt"],
    where: [{ column: "roomId", op: "eq", value: 1 }],
    orderBy: { column: "createdAt", direction: "asc" },
    ...overrides,
  };
}

/** A hand-fired interval seam — the test calls `fire()` to run one poll tick. */
function fakeTimers(): { seam: TimerSeam; fire(): void; running(): boolean } {
  let callback: (() => void) | undefined;

  return {
    seam: {
      setInterval: (cb) => {
        callback = cb;

        return "handle";
      },
      clearInterval: () => {
        callback = undefined;
      },
    },
    fire: () => callback?.(),
    running: () => callback !== undefined,
  };
}

/** Drain the microtask + macrotask queue so an async poll tick settles. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Assert a resume decision is a `replay` and narrow it. */
const asReplay = (resume: ShapeResume): Extract<ShapeResume, { kind: "replay" }> => {
  expect(resume.kind).toBe("replay");

  return resume as Extract<ShapeResume, { kind: "replay" }>;
};

let raw: Database.Database;
let db: Db;
let timers: ReturnType<typeof fakeTimers>;
let engine: ShapeEngine;

beforeEach(async () => {
  raw = new Database(":memory:");
  db = createDb(adapt(raw));
  await db.exec(createTableSql(messages));
  timers = fakeTimers();
  engine = createShapeEngine({ db, tables: [messages], timers: timers.seam });
});

afterEach(() => {
  engine.stop();
  raw.close();
});

async function insert(roomId: number, body: string, createdAt: number): Promise<void> {
  await db
    .insert(messages)
    .values({ roomId, body, createdAt: new Date(createdAt) })
    .run();
}

/** Collect every change a subscription delivers, with its cursor. */
function collector(): {
  onChange: (c: ShapeChange, cur: Cursor) => void;
  changes: ShapeChange[];
  cursors: Cursor[];
} {
  const changes: ShapeChange[] = [];
  const cursors: Cursor[] = [];

  return {
    onChange: (change, cursor) => {
      changes.push(change);
      cursors.push(cursor);
    },
    changes,
    cursors,
  };
}

describe("subscribe — snapshot + registry validation", () => {
  it("returns the current authorized rows in total order, at cursor 0", async () => {
    await insert(1, "first", 100);
    await insert(2, "other room", 150);
    await insert(1, "second", 200);

    const sub = await engine.subscribe(room1Shape(), () => {});

    expect(sub.shapeId).toMatch(/^messages:/);
    expect(sub.cursor).toBe("v0:0"); // opaque, versioned — poll path, see engine.ts pollCursor
    expect((sub.snapshot as Row[]).map((r) => r.body)).toEqual(["first", "second"]);
    // Only room-1 rows, and the timestamp is folded to epoch-ms on the wire.
    expect(sub.snapshot[0]).toEqual({ id: 1, roomId: 1, body: "first", createdAt: 100 });
    expect(engine.activeShapes).toBe(1);
  });

  it("rejects an unknown table", async () => {
    await expect(engine.subscribe(room1Shape({ table: "ghosts" }), () => {})).rejects.toMatchObject(
      { code: "LIVE_SERVER_UNKNOWN_TABLE" },
    );
  });

  it("rejects an unknown column", async () => {
    const def = room1Shape({ columns: ["id", "roomId", "body", "createdAt", "ghost"] });

    await expect(engine.subscribe(def, () => {})).rejects.toBeInstanceOf(LiveServerError);
    await expect(engine.subscribe(def, () => {})).rejects.toMatchObject({
      code: "LIVE_SERVER_UNKNOWN_COLUMN",
    });
  });

  it("rejects a key column that is not primary-key or unique", async () => {
    const def = room1Shape({ key: "body" });

    await expect(engine.subscribe(def, () => {})).rejects.toMatchObject({
      code: "LIVE_SERVER_NON_UNIQUE_KEY",
    });
  });

  it("rejects a structurally invalid shape at the protocol boundary", async () => {
    const def = room1Shape({ key: "not_a_column" });

    await expect(engine.subscribe(def, () => {})).rejects.toBeInstanceOf(LiveProtocolError);
  });
});

describe("poll — the change tail", () => {
  it("delivers an insert for a new matching row", async () => {
    const sink = collector();
    await engine.subscribe(room1Shape(), sink.onChange);

    await insert(1, "hi", 100);
    timers.fire();
    await flush();

    expect(sink.changes).toEqual([
      { op: "insert", key: "1", row: { id: 1, roomId: 1, body: "hi", createdAt: 100 } },
    ]);
    expect(sink.cursors).toEqual(["v0:1"]);
  });

  it("delivers an update when a row changes, and nothing when it does not", async () => {
    await insert(1, "hi", 100);
    const sink = collector();
    await engine.subscribe(room1Shape(), sink.onChange);

    timers.fire();
    await flush();
    expect(sink.changes).toEqual([]); // no change since the snapshot

    await db.update(messages).set({ body: "edited" }).where(eq(messages.id, 1)).run();
    timers.fire();
    await flush();

    expect(sink.changes).toEqual([
      { op: "update", key: "1", row: { id: 1, roomId: 1, body: "edited", createdAt: 100 } },
    ]);
  });

  // ADR 0042 acceptance (c), on-row case (v0 poll): an on-row authorization column leaving the
  // shape propagates a delete-from-shape without waiting for any interval — see the acceptance
  // matrix in http-handlers.test.ts for the full letter-by-letter gate.
  it("delivers a delete-from-shape when a row is updated OUT of the shape", async () => {
    await insert(1, "hi", 100);
    const sink = collector();
    await engine.subscribe(room1Shape(), sink.onChange);

    // Move the row to another room: it fails the predicate → delete-from-shape.
    await db.update(messages).set({ roomId: 2 }).where(eq(messages.id, 1)).run();
    timers.fire();
    await flush();

    expect(sink.changes).toEqual([{ op: "delete", key: "1" }]);
  });

  it("delivers a delete when a row is removed from the table", async () => {
    await insert(1, "hi", 100);
    const sink = collector();
    await engine.subscribe(room1Shape(), sink.onChange);

    await db.delete(messages).where(eq(messages.id, 1)).run();
    timers.fire();
    await flush();

    expect(sink.changes).toEqual([{ op: "delete", key: "1" }]);
  });
});

describe("fan-out + lifecycle", () => {
  it("shares one shape across subscribers and fans changes to all", async () => {
    const a = collector();
    const b = collector();

    await engine.subscribe(room1Shape(), a.onChange);
    const subB = await engine.subscribe(room1Shape(), b.onChange);

    expect(engine.activeShapes).toBe(1); // same shape reused
    expect(subB.cursor).toBe("v0:0");

    await insert(1, "hi", 100);
    timers.fire();
    await flush();

    expect(a.changes).toHaveLength(1);
    expect(b.changes).toHaveLength(1);
  });

  it("stops polling only when the LAST subscriber of the LAST shape leaves", async () => {
    const subA1 = await engine.subscribe(room1Shape(), () => {});
    const subA2 = await engine.subscribe(room1Shape(), () => {});
    const subB = await engine.subscribe(room1Shape({ where: [] }), () => {}); // a distinct shape

    expect(engine.activeShapes).toBe(2);
    expect(timers.running()).toBe(true);

    subA1.unsubscribe();
    expect(engine.activeShapes).toBe(2); // A still has subA2

    subA2.unsubscribe();
    expect(engine.activeShapes).toBe(1); // A gone, B remains → still polling
    expect(timers.running()).toBe(true);

    subB.unsubscribe();
    expect(engine.activeShapes).toBe(0);
    expect(timers.running()).toBe(false); // last shape gone → poll stopped
  });

  it("unsubscribe is idempotent and safe after the shape is already gone", async () => {
    const sub = await engine.subscribe(room1Shape(), () => {});

    sub.unsubscribe();
    sub.unsubscribe(); // idempotent — no throw

    const sub2 = await engine.subscribe(room1Shape(), () => {});
    engine.stop(); // drops every shape out from under the subscription
    sub2.unsubscribe(); // shape already gone — no throw
    expect(engine.activeShapes).toBe(0);
  });

  it("stop() on an engine that never polled is a no-op", () => {
    const idle = createShapeEngine({ db, tables: [messages], timers: fakeTimers().seam });

    expect(() => idle.stop()).not.toThrow();
  });

  it("defaults to real, unref'd timers (start on subscribe, clear on stop)", async () => {
    // No `timers` injected: the default seam's setInterval (unref'd) runs on the first
    // subscribe and its clearInterval runs on stop. The 1s interval never fires in this
    // fast test, so no real poll happens — this exercises the default wiring only.
    const real = createShapeEngine({ db, tables: [messages] });

    const sub = await real.subscribe(room1Shape(), () => {});
    expect(real.activeShapes).toBe(1);

    real.stop();
    sub.unsubscribe();
    expect(real.activeShapes).toBe(0);
  });
});

/** A hand-driven {@link ChangeSource}: `emit` fires a change at every wired sink. */
function fakeSource(): {
  source: ChangeSource;
  emit(change: ReplicationChange): void;
  subscribers(): number;
} {
  const handlers = new Set<ChangeHandler>();

  return {
    source: {
      start: async () => {},
      onChange: (handler) => {
        handlers.add(handler);

        return () => {
          handlers.delete(handler);
        };
      },
      onError: () => () => {},
      stop: async () => {},
    },
    emit: (change) => {
      for (const handler of handlers) handler(change);
    },
    subscribers: () => handlers.size,
  };
}

/** A `replicaIdentity` seam reporting FULL only for the named tables. */
const fullFor =
  (...names: string[]) =>
  async (table: string): Promise<boolean> =>
    names.includes(table);

describe("replication change source — the v1 change path", () => {
  const STAMP = { commitLSN: "0/1", systemId: "sys", timelineId: 1 } as const;
  const ins = (newImage: RowImage): ReplicationChange => ({
    op: "insert",
    table: "messages",
    newImage,
    ...STAMP,
  });
  const upd = (
    oldImage: RowImage,
    newImage: RowImage,
    oldImageKind: OldImageKind = "full",
  ): ReplicationChange => ({
    op: "update",
    table: "messages",
    oldImage,
    newImage,
    oldImageKind,
    ...STAMP,
  });
  const del = (oldImage: RowImage, oldImageKind: OldImageKind = "full"): ReplicationChange => ({
    op: "delete",
    table: "messages",
    oldImage,
    oldImageKind,
    ...STAMP,
  });

  it("consumes the source instead of polling — the poll timer never starts, stop() detaches the sink", async () => {
    const src = fakeSource();
    const e = createShapeEngine({
      db,
      tables: [messages],
      timers: timers.seam,
      replication: { source: src.source, replicaIdentity: fullFor("messages") },
    });

    await e.subscribe(room1Shape(), () => {});

    expect(timers.running()).toBe(false); // no poll loop on the replication path
    expect(src.subscribers()).toBe(1);

    e.stop();
    expect(src.subscribers()).toBe(0); // stop() detaches the change sink
  });

  it("delivers an insert (typed wire row) when a replication insert enters the shape", async () => {
    const src = fakeSource();
    const sink = collector();
    const e = createShapeEngine({
      db,
      tables: [messages],
      replication: { source: src.source, replicaIdentity: fullFor("messages") },
    });
    await e.subscribe(room1Shape(), sink.onChange);

    src.emit(ins({ id: "1", room_id: "1", body: "hi", created_at: "100" }));

    expect(sink.changes).toEqual([
      { op: "insert", key: "1", row: { id: 1, roomId: 1, body: "hi", createdAt: 100 } },
    ]);
    // Inc4: the replication tail stamps the resumable `(systemId, timelineId, LSN)` cursor
    // (no longer a bare `v0:` counter) from the change's commit LSN + system identity.
    expect(sink.cursors).toEqual(["v1:sys:1:0/1"]);
    e.stop();
  });

  it("delivers nothing for a replication insert that does not enter the shape", async () => {
    const src = fakeSource();
    const sink = collector();
    const e = createShapeEngine({
      db,
      tables: [messages],
      replication: { source: src.source, replicaIdentity: fullFor("messages") },
    });
    await e.subscribe(room1Shape(), sink.onChange);

    src.emit(ins({ id: "1", room_id: "2", body: "hi", created_at: "100" }));

    expect(sink.changes).toEqual([]);
    e.stop();
  });

  // ADR 0042 acceptance (b) + (c) on-row case (v1 replication): a non-PK-predicate delete-from-shape
  // under REPLICA IDENTITY FULL — the exact leak the L-08619e99 marker+column-presence guard closes
  // (classify.test.ts's assertOldImageComplete + prepareShapeClassifier suites prove the guard
  // itself). See http-handlers.test.ts's "ADR 0042 acceptance matrix" for the full letter-by-letter gate.
  it("delivers a delete-from-shape when a replication update moves a row OUT (the leak-stopper)", async () => {
    await insert(1, "hi", 100); // seed a matching row into the snapshot
    const src = fakeSource();
    const sink = collector();
    const e = createShapeEngine({
      db,
      tables: [messages],
      replication: { source: src.source, replicaIdentity: fullFor("messages") },
    });
    const sub = await e.subscribe(room1Shape(), sink.onChange);
    expect((sub.snapshot as Row[]).map((r) => r.id)).toEqual([1]);

    // Under FULL the old image is complete; room_id 1 → 2 leaves the shape → delete-from-shape.
    src.emit(
      upd(
        { id: "1", room_id: "1", body: "hi", created_at: "100" },
        { id: "1", room_id: "2", body: "hi", created_at: "100" },
      ),
    );

    expect(sink.changes).toEqual([{ op: "delete", key: "1" }]);
    e.stop();
  });

  it("keeps the shape's row set current so a later subscriber's snapshot includes a replicated insert", async () => {
    const src = fakeSource();
    const e = createShapeEngine({
      db,
      tables: [messages],
      replication: { source: src.source, replicaIdentity: fullFor("messages") },
    });
    await e.subscribe(room1Shape(), () => {});

    src.emit(ins({ id: "1", room_id: "1", body: "hi", created_at: "100" }));

    const late = await e.subscribe(room1Shape(), () => {});
    expect((late.snapshot as Row[]).map((r) => r.id)).toEqual([1]);
    e.stop();
  });

  it("refuses a non-key-predicate shape when its table is not REPLICA IDENTITY FULL (registration guard)", async () => {
    const src = fakeSource();
    const e = createShapeEngine({
      db,
      tables: [messages],
      replication: { source: src.source, replicaIdentity: fullFor() /* messages NOT full */ },
    });

    await expect(e.subscribe(room1Shape(), () => {})).rejects.toMatchObject({
      code: "LIVE_SERVER_REPLICA_IDENTITY_INSUFFICIENT",
    });
    e.stop();
  });

  it("allows a key-only-predicate shape without FULL and tails it (no old image needed)", async () => {
    const src = fakeSource();
    const sink = collector();
    const e = createShapeEngine({
      db,
      tables: [messages],
      replication: { source: src.source, replicaIdentity: fullFor() },
    });
    await e.subscribe(room1Shape({ where: [{ column: "id", op: "eq", value: 1 }] }), sink.onChange);

    src.emit(ins({ id: "1", room_id: "9", body: "hi", created_at: "100" }));

    // The predicate is id=1 (met), so the row enters — carrying its real roomId (9), not filtered on.
    expect(sink.changes).toEqual([
      { op: "insert", key: "1", row: { id: 1, roomId: 9, body: "hi", createdAt: 100 } },
    ]);
    e.stop();
  });

  it("routes LIVE_SERVER_OLD_IMAGE_INCOMPLETE to onError when an update's old tuple went key-only", async () => {
    await insert(1, "hi", 100);
    const src = fakeSource();
    const errors: unknown[] = [];
    const sink = collector();
    const e = createShapeEngine({
      db,
      tables: [messages],
      onError: (error) => errors.push(error),
      replication: { source: src.source, replicaIdentity: fullFor("messages") },
    });
    await e.subscribe(room1Shape(), sink.onChange);

    // FULL was ALTERed away after registration: the old tuple is now key-only ('K'), so its
    // non-key columns (room_id) arrive as null — value-indistinguishable from a real null. Only the
    // marker catches it: the update must NOT be applied on the null-filled old image.
    src.emit(
      upd(
        { id: "1", room_id: null, body: null, created_at: null },
        { id: "1", room_id: "2", body: "x", created_at: "100" },
        "key",
      ),
    );

    expect(sink.changes).toEqual([]); // the change is NOT silently applied
    expect(errors).toHaveLength(1);
    expect((errors[0] as LiveServerError).code).toBe("LIVE_SERVER_OLD_IMAGE_INCOMPLETE");
    e.stop();
  });

  it("refuses a FULL→DEFAULT-downgrade DELETE (key-only old tuple) instead of dropping the delete-from-shape (the leak)", async () => {
    await insert(1, "hi", 100); // a room-1 row is in the client's slice
    const src = fakeSource();
    const errors: unknown[] = [];
    const sink = collector();
    const e = createShapeEngine({
      db,
      tables: [messages],
      onError: (error) => errors.push(error),
      replication: { source: src.source, replicaIdentity: fullFor("messages") },
    });
    const sub = await e.subscribe(room1Shape(), sink.onChange);
    expect((sub.snapshot as Row[]).map((r) => r.id)).toEqual([1]);

    // The table was downgraded FULL→DEFAULT after registration; a DELETE now sends a 'K' tuple with
    // room_id nulled. The old value-based guard passed it (null ≠ undefined) → matchesShape(null)
    // false → the delete-from-shape was DROPPED and the row leaked. The marker refuses it loudly.
    src.emit(del({ id: "1", room_id: null, body: null, created_at: null }, "key"));

    expect(sink.changes).toEqual([]); // NOT silently dropped
    expect(errors).toHaveLength(1);
    expect((errors[0] as LiveServerError).code).toBe("LIVE_SERVER_OLD_IMAGE_INCOMPLETE");
    e.stop();
  });

  it("refuses a FULL DELETE whose predicate column is an unchanged external-TOAST 'u' (marker still full)", async () => {
    await insert(1, "hi", 100);
    const src = fakeSource();
    const errors: unknown[] = [];
    const sink = collector();
    const e = createShapeEngine({
      db,
      tables: [messages],
      onError: (error) => errors.push(error),
      replication: { source: src.source, replicaIdentity: fullFor("messages") },
    });
    const sub = await e.subscribe(room1Shape(), sink.onChange);
    expect((sub.snapshot as Row[]).map((r) => r.id)).toEqual([1]);

    // Under FULL the old-tuple marker is 'full', but an unchanged externally-TOASTed room_id is still
    // sent as 'u' → undefined. The marker check passes; only the column-presence check catches it.
    // A silent drop here would leak the row — so it must route OLD_IMAGE_INCOMPLETE, not delete.
    src.emit(del({ id: "1", room_id: undefined, body: "hi", created_at: "100" }, "full"));

    expect(sink.changes).toEqual([]);
    expect(errors).toHaveLength(1);
    expect((errors[0] as LiveServerError).code).toBe("LIVE_SERVER_OLD_IMAGE_INCOMPLETE");
    e.stop();
  });

  it("delivers a plain update for a filterless shape on a DEFAULT table (empty old image, no false PK-change)", async () => {
    await insert(1, "hi", 100);
    const src = fakeSource();
    const errors: unknown[] = [];
    const sink = collector();
    // A filterless shape needs no old image, so a non-FULL table is fine.
    const e = createShapeEngine({
      db,
      tables: [messages],
      onError: (error) => errors.push(error),
      replication: { source: src.source, replicaIdentity: fullFor() },
    });
    await e.subscribe(room1Shape({ where: [] }), sink.onChange);

    // DEFAULT + unchanged key → pgoutput sends NO old tuple → oldImage is `{}`, marker 'none'.
    src.emit({
      op: "update",
      table: "messages",
      oldImage: {},
      oldImageKind: "none",
      newImage: { id: "1", room_id: "1", body: "edited", created_at: "100" },
      ...STAMP,
    });

    expect(errors).toEqual([]); // no spurious LIVE_SERVER_PRIMARY_KEY_CHANGED
    expect(sink.changes).toEqual([
      { op: "update", key: "1", row: { id: 1, roomId: 1, body: "edited", createdAt: 100 } },
    ]);
    e.stop();
  });

  it("ignores a change for a table with no active shape", async () => {
    const src = fakeSource();
    const sink = collector();
    const e = createShapeEngine({
      db,
      tables: [messages],
      replication: { source: src.source, replicaIdentity: fullFor("messages") },
    });
    await e.subscribe(room1Shape(), sink.onChange);

    src.emit({ op: "insert", table: "other_table", newImage: { id: "9" }, ...STAMP });

    expect(sink.changes).toEqual([]);
    e.stop();
  });

  // L-802b3e7b — a classifier throw (or a dropped malformed-LSN change) happens BEFORE
  // applyChange/ring.record, so the engine's OWN rows + replay ring are left missing the change: the
  // shape is diverged server-side, not merely on the client. Confining the error to `onError` leaves
  // it silently stale until the client happens to reconnect. The engine now DROPS the diverged shape
  // (rows + ring + classifier) and fires each subscriber's onResync, so it purges + re-snapshots and
  // any re-subscribe re-seeds from the DB.
  it("DROPS a shape whose classifier throws, routes onError, and fires the subscriber's onResync (L-802b3e7b)", async () => {
    await insert(1, "hi", 100); // a room-1 row is in the shape
    const src = fakeSource();
    const errors: unknown[] = [];
    const sink = collector();
    const onResync = vi.fn();
    const e = createShapeEngine({
      db,
      tables: [messages],
      onError: (error) => errors.push(error),
      replication: { source: src.source, replicaIdentity: fullFor("messages") },
    });
    await e.subscribe(room1Shape(), sink.onChange, undefined, onResync);
    expect(e.activeShapes).toBe(1);

    // A row STAYING in room 1 but changing its key (id 1 → 2) → LIVE_SERVER_PRIMARY_KEY_CHANGED,
    // thrown BEFORE the change is applied. The engine's rows + ring never saw it → diverged.
    src.emit(
      upd(
        { id: "1", room_id: "1", body: "hi", created_at: "100" },
        { id: "2", room_id: "1", body: "hi", created_at: "100" },
      ),
    );

    expect((errors[0] as LiveServerError).code).toBe("LIVE_SERVER_PRIMARY_KEY_CHANGED");
    expect(onResync).toHaveBeenCalledTimes(1); // the subscriber is told to purge + re-snapshot
    expect(sink.changes).toEqual([]); // never a partial/garbled change
    expect(e.activeShapes).toBe(0); // the diverged entry is gone — never left to re-serve the leak

    // A re-subscribe re-seeds from the DB (the row is still there — only a replication event fired)
    // and re-runs the replica-identity guard against a fresh probe.
    const resubscribe = await e.subscribe(room1Shape(), () => {});
    expect((resubscribe.snapshot as Row[]).map((r) => r.id)).toEqual([1]);
    expect(e.activeShapes).toBe(1);
    e.stop();
  });

  it("a malformed-LSN change DROPS every shape on its table and fires each onResync (L-802b3e7b)", async () => {
    const src = fakeSource();
    const errors: unknown[] = [];
    const e = createShapeEngine({
      db,
      tables: [messages],
      onError: (error) => errors.push(error),
      replication: { source: src.source, replicaIdentity: fullFor("messages") },
    });
    // Two DISTINCT shapes on the same table (room-1 filtered + filterless) → two entries.
    const onResyncA = vi.fn();
    const onResyncB = vi.fn();
    await e.subscribe(room1Shape(), () => {}, undefined, onResyncA);
    await e.subscribe(room1Shape({ where: [] }), () => {}, undefined, onResyncB);
    expect(e.activeShapes).toBe(2);

    // A malformed commit LSN: the change is dropped entirely, so BOTH shapes on `messages` are now
    // missing it → both drop and both subscribers are told to resync.
    src.emit({
      ...ins({ id: "1", room_id: "1", body: "hi", created_at: "100" }),
      commitLSN: "nope",
    });

    expect((errors[0] as LiveServerError).code).toBe("LIVE_SERVER_INVALID_LSN");
    expect(onResyncA).toHaveBeenCalledTimes(1);
    expect(onResyncB).toHaveBeenCalledTimes(1);
    expect(e.activeShapes).toBe(0);
    e.stop();
  });

  it("a malformed-LSN change on ANOTHER table leaves this table's shape intact (drop is table-scoped)", async () => {
    const src = fakeSource();
    const errors: unknown[] = [];
    const sink = collector();
    const onResync = vi.fn();
    const e = createShapeEngine({
      db,
      tables: [messages],
      onError: (error) => errors.push(error),
      replication: { source: src.source, replicaIdentity: fullFor("messages") },
    });
    await e.subscribe(room1Shape(), sink.onChange, undefined, onResync);

    // Malformed LSN, but for a DIFFERENT table — this shape lost nothing, so it must NOT be dropped.
    src.emit({
      op: "insert",
      table: "other_table",
      newImage: { id: "9" },
      commitLSN: "nope",
      systemId: "sys",
      timelineId: 1,
    });

    expect((errors[0] as LiveServerError).code).toBe("LIVE_SERVER_INVALID_LSN");
    expect(onResync).not.toHaveBeenCalled();
    expect(e.activeShapes).toBe(1); // untouched
    e.stop();
  });

  it("isolates a throwing onResync — routes it to onError, still notifies the other subscribers, never wedges the feed", async () => {
    const src = fakeSource();
    const errors: unknown[] = [];
    const e = createShapeEngine({
      db,
      tables: [messages],
      onError: (error) => errors.push(error),
      replication: { source: src.source, replicaIdentity: fullFor("messages") },
    });
    const boom = new Error("resync sink blew up");
    const onResyncThrows = vi.fn(() => {
      throw boom;
    });
    const onResyncOk = vi.fn();
    // Two subscribers on ONE shape (same entry); the first's resync sink throws.
    await e.subscribe(room1Shape(), () => {}, undefined, onResyncThrows);
    await e.subscribe(room1Shape(), () => {}, undefined, onResyncOk);
    expect(e.activeShapes).toBe(1);

    // A malformed LSN drops the shape → both resync sinks run. The throwing one must NOT stop the
    // sibling nor escape the change feed (dropShape runs OUTSIDE the per-shape try).
    expect(() =>
      src.emit({
        ...ins({ id: "1", room_id: "1", body: "hi", created_at: "100" }),
        commitLSN: "nope",
      }),
    ).not.toThrow();

    expect(onResyncThrows).toHaveBeenCalledTimes(1);
    expect(onResyncOk).toHaveBeenCalledTimes(1); // the sibling was still notified
    expect(errors).toContain(boom); // the throw was routed to onError, not silently lost
    expect(e.activeShapes).toBe(0);

    // The feed survives — a subsequent change doesn't throw (the read loop wasn't wedged).
    expect(() =>
      src.emit(ins({ id: "2", room_id: "1", body: "yo", created_at: "200" })),
    ).not.toThrow();
    e.stop();
  });

  it("swallows a throwing onResync when no onError sink is configured (still never wedges the feed)", async () => {
    const src = fakeSource();
    const e = createShapeEngine({
      db,
      tables: [messages],
      replication: { source: src.source, replicaIdentity: fullFor("messages") },
    });
    const onResyncThrows = vi.fn(() => {
      throw new Error("resync sink blew up");
    });
    await e.subscribe(room1Shape(), () => {}, undefined, onResyncThrows);

    // No onError sink: the throw is swallowed inside dropShape (`onError?.` no-ops) and never escapes.
    expect(() =>
      src.emit({
        ...ins({ id: "1", room_id: "1", body: "hi", created_at: "100" }),
        commitLSN: "nope",
      }),
    ).not.toThrow();
    expect(onResyncThrows).toHaveBeenCalledTimes(1);
    e.stop();
  });
});

// ---------------------------------------------------------------------------
// ADR 0042 acceptance "sound resume" + matrix (e) — Tier-4 v1 Inc4 (L-6841d65d).
// A reconnect replays EXACTLY the missed changes, or re-snapshots (a failover/restore, or an LSN
// aged past retention) — never silently misses a change. Proven end-to-end through `subscribe`.
// ---------------------------------------------------------------------------

describe("LSN-exact resume (Inc4) — replay-or-re-snapshot on reconnect", () => {
  const STAMP = { systemId: "sysA", timelineId: 1 } as const;
  const ins = (id: number, roomId: number, lsn: string): ReplicationChange => ({
    op: "insert",
    table: "messages",
    newImage: { id: String(id), room_id: String(roomId), body: `b${id}`, created_at: "100" },
    commitLSN: lsn,
    ...STAMP,
  });

  /** A replication engine (with an optional replay-window override) plus its hand-fed source. */
  function replEngine(replay?: { maxEntries?: number; maxAgeMs?: number; now?: () => number }) {
    const src = fakeSource();
    const e = createShapeEngine({
      db,
      tables: [messages],
      replication: {
        source: src.source,
        replicaIdentity: fullFor("messages"),
        ...(replay === undefined ? {} : { replay }),
      },
    });

    return { src, e };
  }

  it("a fresh subscribe (no cursor) resolves to a full snapshot", async () => {
    const { e } = replEngine();

    const sub = await e.subscribe(room1Shape(), () => {});

    expect(sub.resume).toEqual({ kind: "snapshot" });
    e.stop();
  });

  it("replays EXACTLY the missed changes for a reconnect within the retained window", async () => {
    const { src, e } = replEngine();
    const sink = collector();
    await e.subscribe(room1Shape(), sink.onChange); // subscriber #1 keeps the shape (+ ring) alive
    src.emit(ins(1, 1, "0/10"));
    src.emit(ins(2, 1, "0/20"));
    src.emit(ins(3, 1, "0/30"));

    // The client applied through 0/20 (its Last-Event-ID) then reconnected.
    const since = decodeResumeCursor(sink.cursors[1] as string);
    const sub = await e.subscribe(room1Shape(), () => {}, since);

    const replay = asReplay(sub.resume);
    // Inclusive of the client's own 0/20 (a keyed re-apply is idempotent) + everything after.
    expect(replay.changes.map((c) => c.cursor)).toEqual(["v1:sysA:1:0/20", "v1:sysA:1:0/30"]);
    expect(replay.changes.map((c) => c.change.key)).toEqual(["2", "3"]);
    e.stop();
  });

  it("re-snapshots a reconnect from a DIFFERENT cluster (systemId mismatch)", async () => {
    const { src, e } = replEngine();
    await e.subscribe(room1Shape(), () => {});
    src.emit(ins(1, 1, "0/10")); // establishes identity sysA/1

    const sub = await e.subscribe(room1Shape(), () => {}, {
      systemId: "sysB",
      timelineId: 1,
      lsn: "0/10",
    });

    expect(sub.resume).toEqual({ kind: "snapshot" });
    e.stop();
  });

  it("re-snapshots a reconnect across a SAME-cluster failover (timelineId incremented, systemId unchanged)", async () => {
    const { src, e } = replEngine();
    await e.subscribe(room1Shape(), () => {});
    src.emit(ins(1, 1, "0/10"));

    // systemId still matches — a `systemId`-only check would wrongly replay — but the WAL timeline moved.
    const sub = await e.subscribe(room1Shape(), () => {}, {
      systemId: "sysA",
      timelineId: 2,
      lsn: "0/10",
    });

    expect(sub.resume).toEqual({ kind: "snapshot" });
    e.stop();
  });

  it("re-snapshots a reconnect whose LSN aged past the retained window", async () => {
    const { src, e } = replEngine({ maxEntries: 1 }); // the ring holds a single change
    const sink = collector();
    await e.subscribe(room1Shape(), sink.onChange);
    src.emit(ins(1, 1, "0/10"));
    src.emit(ins(2, 1, "0/20")); // evicts 0/10 → it aged out of the window

    const since = decodeResumeCursor(sink.cursors[0] as string); // 0/10, now evicted
    const sub = await e.subscribe(room1Shape(), () => {}, since);

    expect(sub.resume).toEqual({ kind: "snapshot" });
    e.stop();
  });

  it("the v0 poll path always re-snapshots on reconnect (no LSN ring)", async () => {
    // The module `engine` is the poll engine — it has no replay ring, so any cursor re-snapshots.
    const sub = await engine.subscribe(room1Shape(), () => {}, {
      systemId: "x",
      timelineId: 1,
      lsn: "0/1",
    });

    expect(sub.resume).toEqual({ kind: "snapshot" });
    expect(sub.cursor).toBe("v0:0"); // the poll snapshot cursor stays the non-resumable v0 token
  });

  it("anchors the snapshot cursor to the live identity + latest LSN once a change has flowed", async () => {
    const { src, e } = replEngine();
    await e.subscribe(room1Shape(), () => {});

    // Before any change the identity is unknown → the v0 cursor (which forces a reconnect resync).
    const early = await e.subscribe(room1Shape(), () => {});
    expect(early.cursor).toBe("v0:0");

    src.emit(ins(1, 1, "0/10"));

    const late = await e.subscribe(room1Shape(), () => {});
    expect(late.cursor).toBe("v1:sysA:1:0/10");
    e.stop();
  });

  it("uses the `0/0` baseline LSN when a change revealed the identity but not for this shape yet", async () => {
    const { src, e } = replEngine();
    await e.subscribe(room1Shape(), () => {});

    // A change on the same table that does NOT enter room-1 (room_id 2): it reveals the live
    // identity but never touches this shape's ring, so the ring stays empty.
    src.emit(ins(9, 2, "0/10"));

    const sub = await e.subscribe(room1Shape(), () => {});
    // Identity known (sysA/1) but no LSN applied to THIS shape → the `0/0` baseline.
    expect(sub.cursor).toBe("v1:sysA:1:0/0");
    e.stop();
  });

  it("resyncs EVERY shape when a change reveals a NEW live identity (failover), re-seeding rows + ring (L-f61264b0)", async () => {
    const { src, e } = replEngine();
    const onResyncA = vi.fn();
    const onResyncB = vi.fn();
    // Two DISTINCT shapes on the same table, each with a subscriber that observes resync.
    await e.subscribe(room1Shape(), () => {}, undefined, onResyncA);
    await e.subscribe(room1Shape({ where: [] }), () => {}, undefined, onResyncB);

    // Establish the pre-failover identity (sysA/1); THIS change records into both rings.
    src.emit(ins(1, 1, "0/50"));
    expect(onResyncA).not.toHaveBeenCalled();
    expect(onResyncB).not.toHaveBeenCalled();

    // A failover bumps the WAL timeline. The first post-failover change advances the live identity
    // to sysA/2 — even landing on ANOTHER table — so every shape may hold lost-on-promote rows and
    // a stale-timeline ring. Each shape drops and every subscriber is told to resync.
    src.emit({
      op: "insert",
      table: "rooms",
      newImage: { id: "1", name: "general" },
      commitLSN: "0/60",
      systemId: "sysA",
      timelineId: 2,
    });

    expect(onResyncA).toHaveBeenCalledTimes(1);
    expect(onResyncB).toHaveBeenCalledTimes(1);
    expect(e.activeShapes).toBe(0); // both dropped → a re-subscribe re-seeds from the promoted DB

    // A re-subscribe now anchors to the NEW identity with a fresh (empty) ring → the `0/0` baseline,
    // never a `v1:sysA:2:<pre-failover-LSN>` mix.
    const sub = await e.subscribe(room1Shape(), () => {});
    expect(sub.cursor).toBe("v1:sysA:2:0/0");
    // Direct teeth for the stale-snapshot-ROWS window: row id=1 reached the OLD entry.rows via the
    // change feed but was never in the DB (the lost-on-promote analog) — the drop + re-seed from the
    // promoted DB must serve it no more, not just carry an honest cursor.
    expect(sub.snapshot).toEqual([]);
    e.stop();
  });

  it("resyncs every shape when a change reveals a DIFFERENT cluster (systemId change), too (L-f61264b0)", async () => {
    const { src, e } = replEngine();
    const onResync = vi.fn();
    await e.subscribe(room1Shape(), () => {}, undefined, onResync);

    src.emit(ins(1, 1, "0/50")); // identity sysA/1
    expect(onResync).not.toHaveBeenCalled();

    // A restore onto a DIFFERENT cluster: the systemId changes (the timeline happens to coincide) —
    // the `systemId`-only arm of the guard must fire on its own, without a timeline bump.
    src.emit({
      op: "insert",
      table: "messages",
      newImage: { id: "2", room_id: "1", body: "b2", created_at: "100" },
      commitLSN: "0/60",
      systemId: "sysZ",
      timelineId: 1,
    });

    expect(onResync).toHaveBeenCalledTimes(1);
    expect(e.activeShapes).toBe(0);
    e.stop();
  });

  it("rejects a change with a malformed commit LSN at ingest — routes to onError, never poisons the ring", async () => {
    const src = fakeSource();
    const errors: unknown[] = [];
    const e = createShapeEngine({
      db,
      tables: [messages],
      onError: (error) => errors.push(error),
      replication: { source: src.source, replicaIdentity: fullFor("messages") },
    });
    const sink = collector();
    await e.subscribe(room1Shape(), sink.onChange);

    src.emit(ins(1, 1, "not-an-lsn"));

    expect(sink.changes).toEqual([]); // dropped, not delivered
    expect(errors).toHaveLength(1);
    expect((errors[0] as LiveServerError).code).toBe("LIVE_SERVER_INVALID_LSN");

    // The bad change returned BEFORE stamping liveIdentity, so a later subscribe still gets the
    // non-resumable v0 cursor — proof the ring was never touched.
    const late = await e.subscribe(room1Shape(), () => {});
    expect(late.cursor).toBe("v0:0");
    e.stop();
  });

  it("drops a malformed-LSN change without throwing when no onError sink is configured", async () => {
    const src = fakeSource();
    const e = createShapeEngine({
      db,
      tables: [messages],
      replication: { source: src.source, replicaIdentity: fullFor("messages") },
    });
    const sink = collector();
    await e.subscribe(room1Shape(), sink.onChange);

    expect(() => src.emit(ins(1, 1, "bad"))).not.toThrow();
    expect(sink.changes).toEqual([]);
    e.stop();
  });
});

describe("poll safety", () => {
  it("routes a poll error to onError instead of crashing the loop", async () => {
    const errors: unknown[] = [];
    const rows: Row[] = [];
    let throwOnRead = false;

    // A controllable Db: seeds fine, then throws on the next read.
    const controllable = {
      select: () => ({
        from: () => ({
          all: () => (throwOnRead ? Promise.reject(new Error("boom")) : Promise.resolve(rows)),
        }),
      }),
    } as unknown as Db;

    const e = createShapeEngine({
      db: controllable,
      tables: [messages],
      timers: timers.seam,
      onError: (error) => errors.push(error),
    });

    await e.subscribe(room1Shape({ where: [] }), () => {});
    throwOnRead = true;
    timers.fire();
    await flush();

    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("boom");
    e.stop();
  });

  it("does not overlap ticks — a fire while a tick is in flight is a no-op", async () => {
    let release: (() => void) | undefined;
    let mode: "resolve" | "block" = "resolve";
    let rows: Row[] = [];

    const controllable = {
      select: () => ({
        from: () => ({
          all: () =>
            mode === "block"
              ? new Promise<Row[]>((resolve) => {
                  release = () => resolve(rows);
                })
              : Promise.resolve(rows),
        }),
      }),
    } as unknown as Db;

    const sink = collector();
    const e = createShapeEngine({ db: controllable, tables: [messages], timers: timers.seam });
    await e.subscribe(room1Shape({ where: [] }), sink.onChange);

    // The next read will block; stage a new row so a completed tick would emit one insert.
    rows = [{ id: 1, roomId: 1, body: "hi", createdAt: 100 }];
    mode = "block";

    timers.fire(); // tick #1 starts, awaits the blocked read (ticking = true)
    timers.fire(); // tick #2 sees ticking === true and returns immediately

    release?.(); // let tick #1's read resolve
    await flush();

    // Exactly one insert — proof the second fire did no work.
    expect(sink.changes).toEqual([
      { op: "insert", key: "1", row: { id: 1, roomId: 1, body: "hi", createdAt: 100 } },
    ]);
    e.stop();
  });
});

// ---------------------------------------------------------------------------
// L-5c46b49b — a shape keyed on a UNIQUE **non-primary-key** column, end-to-end through the engine.
// resolveTable accepts a `primaryKey || unique` key, but the old-image guard formerly only forced
// REPLICA IDENTITY FULL for a non-key FILTER — so a unique-non-PK-keyed, filterless shape registered
// on a DEFAULT table and then leaked: an update changing the unique key stranded the old row (no old
// key under DEFAULT), and a plain DELETE carried only the PK (missing the client's key → the row
// survived). The fix threads `keyIsPrimaryKey` into the guard so such a shape is refused unless FULL.
// ---------------------------------------------------------------------------
// `id` is the PK; `slug` is a UNIQUE non-PK column — a legitimate `resolveTable` key that the old
// guard mis-classified as needing no old image.
const articles = defineTable("articles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  slug: text("slug").notNull().unique(),
  body: text("body").notNull(),
});

// Filterless AND keyed on the unique non-PK column — the exact config that formerly leaked.
const slugShape = (): ShapeDefinition => ({
  table: "articles",
  key: "slug",
  columns: ["id", "slug", "body"],
  where: [],
  orderBy: { column: "slug", direction: "asc" },
});

describe("replication — a UNIQUE non-PK shape key is fail-closed (L-5c46b49b)", () => {
  const STAMP = { commitLSN: "0/1", systemId: "sys", timelineId: 1 } as const;

  let aRaw: Database.Database;
  let aDb: Db;
  let src: ReturnType<typeof fakeSource>;

  beforeEach(async () => {
    aRaw = new Database(":memory:");
    aDb = createDb(adapt(aRaw));
    await aDb.exec(createTableSql(articles));
    src = fakeSource();
  });

  afterEach(() => aRaw.close());

  it("REFUSES registration when the table is not REPLICA IDENTITY FULL (the DELETE-leak / update-strand fix)", async () => {
    const e = createShapeEngine({
      db: aDb,
      tables: [articles],
      replication: { source: src.source, replicaIdentity: fullFor() /* articles NOT full */ },
    });

    await expect(e.subscribe(slugShape(), () => {})).rejects.toMatchObject({
      code: "LIVE_SERVER_REPLICA_IDENTITY_INSUFFICIENT",
    });
    e.stop();
  });

  it("registers under FULL, and an update CHANGING the unique key fires PRIMARY_KEY_CHANGED (never a stale duplicate)", async () => {
    await aDb.insert(articles).values({ slug: "old", body: "b" }).run(); // seed a matching row
    const errors: unknown[] = [];
    const e = createShapeEngine({
      db: aDb,
      tables: [articles],
      replication: { source: src.source, replicaIdentity: fullFor("articles") },
      onError: (error) => errors.push(error),
    });
    const sub = await e.subscribe(slugShape(), () => {});
    expect((sub.snapshot as Row[]).map((r) => r.slug)).toEqual(["old"]);

    // Under FULL the old image carries the unique key, so a change to it is caught loudly rather than
    // stranding the "old"-keyed row. (Under DEFAULT no old key is emitted → the pre-fix silent strand.)
    src.emit({
      op: "update",
      table: "articles",
      oldImage: { id: "1", slug: "old", body: "b" },
      newImage: { id: "1", slug: "new", body: "b" },
      oldImageKind: "full",
      ...STAMP,
    });

    expect(errors).toHaveLength(1);
    expect((errors[0] as LiveServerError).code).toBe("LIVE_SERVER_PRIMARY_KEY_CHANGED");
    e.stop();
  });
});

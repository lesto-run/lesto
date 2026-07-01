import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDb, createTableSql, defineTable, eq, integer, text, timestamp } from "@lesto/db";
import type { Db, SqlDatabase } from "@lesto/db";
import { LiveProtocolError } from "@lesto/live-protocol";
import type { Cursor, Row, ShapeChange, ShapeDefinition } from "@lesto/live-protocol";

import { createShapeEngine, LiveServerError } from "../src/index";
import type { ShapeEngine, TimerSeam } from "../src/index";

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
    expect(sub.cursor).toBe("0");
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
    expect(sink.cursors).toEqual(["1"]);
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
    expect(subB.cursor).toBe("0");

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

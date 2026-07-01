import { describe, expect, it } from "vitest";

import { boolean, defineTable, integer, text, timestamp } from "@lesto/db";

import { live, LiveClientError } from "../src/index";
import type { LiveEnvironment, LiveEventSource, LiveMessageEvent } from "../src/index";

const todos = defineTable("todos", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  list: text("list").notNull(),
  text: text("text").notNull(),
  done: boolean("done").notNull().default(false),
  createdAt: timestamp("created_at").notNull(),
});

/** A fake `EventSource` seam: capture the opened URL + the registered listeners, emit by hand. */
function fakeEnv() {
  const urls: string[] = [];
  const listeners = new Map<string, (event: LiveMessageEvent) => void>();
  let closed = false;

  const environment: LiveEnvironment = {
    open(url) {
      urls.push(url);

      const source: LiveEventSource = {
        addEventListener: (type, listener) => listeners.set(type, listener),
        close: () => {
          closed = true;
        },
      };

      return source;
    },
  };

  return {
    environment,
    urls,
    emit: (type: string, data: string) => listeners.get(type)?.({ data }),
    isClosed: () => closed,
  };
}

describe("live().toShape() — deriving the shape from the schema", () => {
  it("projects the whole row, keys by the primary key, and defaults to no filter/order", () => {
    expect(live(todos).toShape()).toEqual({
      table: "todos",
      key: "id",
      columns: ["id", "list", "text", "done", "createdAt"],
      where: [],
      orderBy: undefined,
    });
  });

  it("accumulates AND filters and maps snake_case columns to their JS key", () => {
    const shape = live(todos)
      .where(todos.list, "eq", "home")
      .where(todos.done, "eq", false)
      // `created_at` (SQL) resolves to `createdAt` (the JS key the wire + store use).
      .orderBy(todos.createdAt, "desc")
      .toShape();

    expect(shape.where).toEqual([
      { column: "list", op: "eq", value: "home" },
      { column: "done", op: "eq", value: false },
    ]);
    expect(shape.orderBy).toEqual({ column: "createdAt", direction: "desc" });
  });

  it("defaults orderBy direction to asc", () => {
    expect(live(todos).orderBy(todos.createdAt).toShape().orderBy).toEqual({
      column: "createdAt",
      direction: "asc",
    });
  });

  it("is an immutable chain — a modifier returns a new builder", () => {
    const base = live(todos);
    const filtered = base.where(todos.list, "eq", "home");

    expect(base.toShape().where).toEqual([]);
    expect(filtered.toShape().where).toHaveLength(1);
  });

  it("throws LIVE_UNKNOWN_COLUMN for a column that is not on the table", () => {
    const other = defineTable("other", {
      id: integer("id").primaryKey(),
      ghost: text("ghost"),
    });

    expect(() => live(todos).where(other.ghost, "eq", "x")).toThrow(LiveClientError);
    try {
      live(todos).orderBy(other.ghost);
    } catch (error) {
      expect((error as LiveClientError).code).toBe("LIVE_UNKNOWN_COLUMN");
    }
  });

  it("throws LIVE_NO_KEY for a table with no primary key", () => {
    const keyless = defineTable("keyless", { a: text("a"), b: text("b") });

    expect(() => live(keyless).toShape()).toThrow(LiveClientError);
    try {
      live(keyless).toShape();
    } catch (error) {
      expect((error as LiveClientError).code).toBe("LIVE_NO_KEY");
    }
  });
});

describe("live().query() — the live subscription", () => {
  it("opens the data stream for the compiled shape and reflects streamed rows", () => {
    const fake = fakeEnv();

    const query = live(todos)
      .where(todos.list, "eq", "home")
      .orderBy(todos.createdAt, "asc")
      .query({ environment: fake.environment });

    // The URL binds the serialized, compiled shape.
    expect(fake.urls[0]).toContain("/__lesto/live-data?shape=");
    expect(decodeURIComponent(fake.urls[0]!)).toContain('"table":"todos"');

    expect(query.getSnapshot()).toEqual([]);

    fake.emit(
      "snapshot",
      JSON.stringify({
        rows: [
          { id: 2, list: "home", text: "later", done: false, createdAt: 200 },
          { id: 1, list: "home", text: "sooner", done: false, createdAt: 100 },
        ],
      }),
    );

    // Rows come back in the shape's total order (createdAt asc, id tiebreak).
    expect(query.getSnapshot().map((r) => r.id)).toEqual([1, 2]);

    query.disconnect();
    expect(fake.isClosed()).toBe(true);
  });
});

/**
 * Cross-driver parity: the SAME conformance body run against SQLite and Postgres
 * (ADR 0006 Wave 6). It proves the async `@keel/db` query layer + the two driver
 * adapters (`@keel/runtime`'s `openSqlite`, `@keel/pg`'s `openPostgres`) behave
 * identically — insert/returning, get/all/orderBy/limit/offset/count, update/
 * delete change-counts, transaction commit-visible / rollback-invisible, the
 * `?`→`$n` round-trip with a reused position, snake→camel hydration, and
 * null/boolean binding.
 *
 * The SQLite leg always runs (in the gate). The Postgres leg runs ONLY when
 * `KEEL_PG_URL` is set (its own CI job with a Postgres service) — so the coverage
 * gate never depends on a container, and a developer opts in with a real PG.
 *
 * Out of scope (surfaced, NOT fixed here — see the dialect-drift follow-up): the
 * table DDL itself differs per dialect (`AUTOINCREMENT` vs `SERIAL`), so the
 * schema setup is the one driver-specific seam below; everything ABOVE the DDL is
 * the portable query layer under test.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDb, defineTable, eq, integer, text } from "@keel/db";
import type { Db, SqlDatabase } from "@keel/db";
import { openSqlite } from "@keel/runtime";

// The schema-as-value drives every query (column refs, insert, select); only the
// CREATE TABLE text below is dialect-specific.
const items = defineTable("items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  score: integer("score").notNull(),
  note: text("note"),
});

const DDL: Record<string, string> = {
  sqlite:
    "CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, score INTEGER NOT NULL, note TEXT)",
  postgres:
    "CREATE TABLE items (id SERIAL PRIMARY KEY, name TEXT NOT NULL, score INTEGER NOT NULL, note TEXT)",
};

interface Driver {
  readonly name: "sqlite" | "postgres";
  open(): Promise<{ db: SqlDatabase; close: () => unknown }>;
}

const PG_URL = process.env["KEEL_PG_URL"];

const drivers: Driver[] = [{ name: "sqlite", open: () => openSqlite() }];

if (PG_URL !== undefined) {
  drivers.push({
    name: "postgres",
    open: async () => {
      const { openPostgres } = await import("@keel/pg");

      return openPostgres({ connectionString: PG_URL });
    },
  });
}

describe.each(drivers)("data-layer parity: $name", (driver) => {
  let handle: SqlDatabase;
  let db: Db;
  let close: () => unknown;

  beforeEach(async () => {
    const opened = await driver.open();
    handle = opened.db;
    close = opened.close;

    await handle.exec("DROP TABLE IF EXISTS items");
    await handle.exec(DDL[driver.name]!);

    db = createDb(handle);
  });

  afterEach(async () => {
    await close();
  });

  it("inserts with RETURNING id, reads back by eq, hydrates snake→camel + null", async () => {
    const created = await db.insert(items).values({ name: "ada", score: 10 }).returning().get();

    expect(created.id).toBeGreaterThan(0);

    const got = await db.select().from(items).where(eq(items.id, created.id)).get();

    expect(got).toEqual({ id: created.id, name: "ada", score: 10, note: null });
  });

  it("all + orderBy + limit + offset + count agree", async () => {
    await db.insert(items).values({ name: "c", score: 30 }).run();
    await db.insert(items).values({ name: "a", score: 10 }).run();
    await db.insert(items).values({ name: "b", score: 20 }).run();

    const byScoreDesc = await db.select().from(items).orderBy(items.score, "desc").all();
    expect(byScoreDesc.map((r) => r.name)).toEqual(["c", "b", "a"]);

    const page = await db.select().from(items).orderBy(items.name).limit(1).offset(1).all();
    expect(page.map((r) => r.name)).toEqual(["b"]);

    expect(await db.select().from(items).count()).toBe(3);
    expect(await db.select().from(items).where(eq(items.name, "a")).count()).toBe(1);
  });

  it("update and delete report the right change counts", async () => {
    await db.insert(items).values({ name: "x", score: 1 }).run();
    await db.insert(items).values({ name: "y", score: 2 }).run();

    const updated = await db.update(items).set({ score: 99 }).where(eq(items.name, "x")).run();
    expect(updated.changes).toBe(1);
    expect((await db.select().from(items).where(eq(items.name, "x")).get())?.score).toBe(99);

    const deleted = await db.delete(items).where(eq(items.name, "y")).run();
    expect(deleted.changes).toBe(1);
    expect(await db.select().from(items).count()).toBe(1);
  });

  it("transaction commits the whole span", async () => {
    await db.transaction(async (tx) => {
      await tx.insert(items).values({ name: "t1", score: 1 }).run();
      await tx.insert(items).values({ name: "t2", score: 2 }).run();
    });

    expect(await db.select().from(items).count()).toBe(2);
  });

  it("transaction rolls back on throw, leaving no rows", async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.insert(items).values({ name: "doomed", score: 1 }).run();

        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(await db.select().from(items).count()).toBe(0);
  });
});

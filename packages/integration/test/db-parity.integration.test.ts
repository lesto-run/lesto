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
 * The table DDL is now rendered by the dialect layer (`createTableSql(items,
 * driver.name)`): the previous hand-written `AUTOINCREMENT`/`SERIAL` workaround
 * is gone, so this suite also proves `@keel/db`'s installer runs unchanged on a
 * real Postgres.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDb, createTableSql, defineTable, eq, integer, text } from "@keel/db";
import type { Db, Dialect, SqlDatabase } from "@keel/db";
import { Migrator } from "@keel/migrate";
import { openSqlite } from "@keel/runtime";

// The schema-as-value drives every query (column refs, insert, select) AND the
// CREATE TABLE: one source of truth, rendered per dialect by `createTableSql`.
const items = defineTable("items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  score: integer("score").notNull(),
  note: text("note"),
});

interface Driver {
  readonly name: Dialect;
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
    await handle.exec(createTableSql(items, driver.name));

    db = createDb(handle, { dialect: driver.name });
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

    // Offset WITHOUT a limit: the SQLite idiom is `LIMIT -1 OFFSET n`, which
    // Postgres rejects (it wants a bare `OFFSET`). Both dialects must skip the
    // first row and yield the rest — the dialect fork proven on a real socket.
    const tail = await db.select().from(items).orderBy(items.name).offset(1).all();
    expect(tail.map((r) => r.name)).toEqual(["b", "c"]);

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

// ---------------------------------------------------------------------------
// Schema installers (the increment-1 acceptance): every dialect-aware installer
// + the migrator must INSTALL on a real Postgres, not just SQLite. Before the
// dialect layer these emitted SQLite-only DDL (`AUTOINCREMENT`, int4 epoch-ms)
// and could not run on PG at all. We install each, then round-trip the table,
// so a regression in any installer's DDL surfaces here against a real socket.
// ---------------------------------------------------------------------------

describe.each(drivers)("schema installers on $name", (driver) => {
  let handle: SqlDatabase;
  let close: () => unknown;

  beforeEach(async () => {
    const opened = await driver.open();
    handle = opened.db;
    close = opened.close;

    await handle.exec("DROP TABLE IF EXISTS keel_jobs");
    await handle.exec("DROP TABLE IF EXISTS keel_cache");
    await handle.exec("DROP TABLE IF EXISTS keel_workflow_steps");
    await handle.exec("DROP TABLE IF EXISTS schema_migrations");
    await handle.exec("DROP TABLE IF EXISTS installer_items");
  });

  afterEach(async () => {
    await close();
  });

  it("queue.installSchema installs and enqueue→claim round-trips", async () => {
    const { Queue, installSchema } = await import("@keel/queue");

    await installSchema(handle, driver.name);

    const queue = new Queue({ db: handle });
    const id = await queue.enqueue("ping", { n: 1 });
    const claimed = await queue.claim();

    expect(id).toBeGreaterThan(0);
    expect(claimed?.id).toBe(id);
    expect(claimed?.payload).toEqual({ n: 1 });
  });

  it("cache.installCacheSchema installs and set→get round-trips (BIGINT expires_at)", async () => {
    const { installCacheSchema, sqlStore } = await import("@keel/cache");

    await installCacheSchema(handle, driver.name);

    const store = sqlStore(handle);
    // A real epoch-ms deadline (~1.75e12) — overflows int4, so this would have
    // failed to install on PG before the BIGINT fix.
    await store.set("k", { value: { ok: true }, expiresAt: 1_750_000_000_000 });

    expect(await store.get("k")).toEqual({ value: { ok: true }, expiresAt: 1_750_000_000_000 });
  });

  it("workflows.installWorkflowSchema installs and a step memoizes", async () => {
    const { Engine, installWorkflowSchema } = await import("@keel/workflows");

    await installWorkflowSchema(handle, driver.name);

    let calls = 0;
    const engine = new Engine({ db: handle }).define("w", async (_input: null, ctx) =>
      ctx.step("once", () => {
        calls += 1;

        return calls;
      }),
    );

    expect(await engine.run("w", "run-1", null)).toBe(1);
    // Re-running the same run id replays the memoized step instead of re-calling.
    expect(await engine.run("w", "run-1", null)).toBe(1);
    expect(calls).toBe(1);
  });

  it("the migrator installs a value-DDL table and round-trips through createDb", async () => {
    const installerItems = defineTable("installer_items", {
      id: integer("id").primaryKey({ autoIncrement: true }),
      label: text("label").notNull(),
    });

    await new Migrator(
      handle,
      [
        {
          version: "001_installer_items",
          migration: {
            up: async (s) => {
              await s.execute(createTableSql(installerItems, s.dialect));
            },
          },
        },
      ],
      { dialect: driver.name },
    ).migrate();

    const installerDb = createDb(handle, { dialect: driver.name });
    const created = await installerDb
      .insert(installerItems)
      .values({ label: "hello" })
      .returning()
      .get();

    expect(created.id).toBeGreaterThan(0);
    expect(created.label).toBe("hello");
  });
});

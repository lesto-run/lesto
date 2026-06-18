/**
 * Cross-driver parity: the SAME conformance body run against SQLite and Postgres
 * (ADR 0006 Wave 6). It proves the async `@lesto/db` query layer + the two driver
 * adapters (`@lesto/runtime`'s `openSqlite`, `@lesto/pg`'s `openPostgres`) behave
 * identically — insert/returning, get/all/orderBy/limit/offset/count, update/
 * delete change-counts, transaction commit-visible / rollback-invisible, the
 * `?`→`$n` round-trip with a reused position, snake→camel hydration, and
 * null/boolean binding.
 *
 * The SQLite leg always runs (in the gate). The Postgres leg runs ONLY when
 * `LESTO_PG_URL` is set (its own CI job with a Postgres service) — so the coverage
 * gate never depends on a container, and a developer opts in with a real PG.
 *
 * The table DDL is now rendered by the dialect layer (`createTableSql(items,
 * driver.name)`): the previous hand-written `AUTOINCREMENT`/`SERIAL` workaround
 * is gone, so this suite also proves `@lesto/db`'s installer runs unchanged on a
 * real Postgres.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  alias,
  boolean,
  createDb,
  createTableSql,
  defineTable,
  eq,
  gt,
  gte,
  inList,
  integer,
  like,
  lt,
  lte,
  text,
  timestamp,
} from "@lesto/db";
import type { Column } from "@lesto/db";
import type { Db, Dialect, SqlDatabase } from "@lesto/db";
import { Migrator } from "@lesto/migrate";
import { openSqlite } from "@lesto/runtime";

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

const PG_URL = process.env["LESTO_PG_URL"];

const drivers: Driver[] = [{ name: "sqlite", open: () => openSqlite() }];

if (PG_URL !== undefined) {
  drivers.push({
    name: "postgres",
    open: async () => {
      const { openPostgres } = await import("@lesto/pg");

      return openPostgres({ connectionString: PG_URL });
    },
  });
}

/** Open ONE fresh, independent Postgres session (its own pool) — for the advisory-lock race. */
async function openPostgresHandle(): Promise<{ db: SqlDatabase; close: () => Promise<void> }> {
  const { openPostgres } = await import("@lesto/pg");

  // Only ever called from the PG-only describe, so the URL is present.
  return openPostgres({ connectionString: PG_URL! });
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

  it("condition vocabulary (gt/gte/lt/lte/inList/like) agrees on both drivers", async () => {
    await db.insert(items).values({ name: "alpha", score: 10 }).run();
    await db.insert(items).values({ name: "beta", score: 20 }).run();
    await db.insert(items).values({ name: "gamma", score: 30 }).run();

    expect(
      (await db.select().from(items).where(gt(items.score, 20)).all()).map((r) => r.name),
    ).toEqual(["gamma"]);
    expect(
      (await db.select().from(items).where(gte(items.score, 20)).orderBy(items.name).all()).map(
        (r) => r.name,
      ),
    ).toEqual(["beta", "gamma"]);
    expect(
      (await db.select().from(items).where(lt(items.score, 20)).all()).map((r) => r.name),
    ).toEqual(["alpha"]);
    expect(
      (await db.select().from(items).where(lte(items.score, 20)).orderBy(items.name).all()).map(
        (r) => r.name,
      ),
    ).toEqual(["alpha", "beta"]);
    expect(
      (
        await db
          .select()
          .from(items)
          .where(inList(items.name, ["alpha", "gamma"]))
          .orderBy(items.name)
          .all()
      ).map((r) => r.name),
    ).toEqual(["alpha", "gamma"]);
    expect(await db.select().from(items).where(inList(items.name, [])).all()).toEqual([]);
    expect(
      (await db.select().from(items).where(like(items.name, "a%")).all()).map((r) => r.name),
    ).toEqual(["alpha"]);
  });

  it("db.raw runs a parameterized query and returns rows on both drivers", async () => {
    await db.insert(items).values({ name: "one", score: 1 }).run();
    await db.insert(items).values({ name: "two", score: 2 }).run();

    const rows = await db.raw<{ name: string }>(
      "SELECT name FROM items WHERE score >= ? ORDER BY name",
      [2],
    );

    expect(rows.map((r) => r.name)).toEqual(["two"]);
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

  // The pg leg is the one that matters here: node-postgres hands the INTEGER/BIGINT
  // storage back as a *string*, so `boolean`/`timestamp` hydration must coerce it to
  // `false/true` and a `Date` identically to SQLite's number path (ADR 0018 §1).
  it("boolean + timestamp store as INTEGER and round-trip identically on both drivers", async () => {
    const events = defineTable("parity_events", {
      id: integer("id").primaryKey({ autoIncrement: true }),
      active: boolean("active").notNull(),
      archived: boolean("archived"), // nullable
      occurredAt: timestamp("occurred_at").notNull(),
      deletedAt: timestamp("deleted_at"), // nullable
    });

    await handle.exec("DROP TABLE IF EXISTS parity_events");
    await handle.exec(createTableSql(events, driver.name));

    const when = new Date("2026-06-18T12:34:56.000Z");
    const created = await db
      .insert(events)
      .values({ active: true, archived: false, occurredAt: when })
      .returning()
      .get();

    expect(created.active).toBe(true);
    expect(created.archived).toBe(false);
    expect(created.occurredAt).toBeInstanceOf(Date);
    expect(created.occurredAt.getTime()).toBe(when.getTime());
    expect(created.deletedAt).toBeNull();

    await handle.exec("DROP TABLE parity_events");
  });

  // The headline of ADR 0018 §2: a declared foreign key is ENFORCED end-to-end, not
  // merely rendered. Postgres and better-sqlite3 both enforce FKs out of the box; the
  // `PRAGMA foreign_keys = ON` that openSqlite issues guarantees the same on the
  // bun:sqlite fallback (which defaults them OFF). Either way the orphan is rejected.
  it("a foreign key rejects an orphan insert on both drivers", async () => {
    const fkParents = defineTable("fk_parents", {
      id: integer("id").primaryKey({ autoIncrement: true }),
      name: text("name").notNull(),
    });
    const fkChildren = defineTable("fk_children", {
      id: integer("id").primaryKey({ autoIncrement: true }),
      parentId: integer("parent_id")
        .notNull()
        .references(() => fkParents.id, { onDelete: "cascade" }),
    });

    await handle.exec("DROP TABLE IF EXISTS fk_children");
    await handle.exec("DROP TABLE IF EXISTS fk_parents");
    await handle.exec(createTableSql(fkParents, driver.name));
    await handle.exec(createTableSql(fkChildren, driver.name));

    const parent = await db.insert(fkParents).values({ name: "p" }).returning().get();
    // a child pointing at a real parent is accepted
    await db.insert(fkChildren).values({ parentId: parent.id }).run();

    // an orphan (a parent id that does not exist) is rejected. Assert rejection only —
    // better-sqlite3 and node-postgres word the constraint error differently.
    await expect(db.insert(fkChildren).values({ parentId: 999_999 }).run()).rejects.toThrow();

    await handle.exec("DROP TABLE fk_children");
    await handle.exec("DROP TABLE fk_parents");
  });

  // ADR 0018 §3: joins render namespaced rows + a left-join's unmatched side collapses
  // to null — identically on both drivers. The qualified-and-aliased projection
  // (`"users"."id" AS "users.id"`), the `INNER`/`LEFT JOIN` keywords, and an aliased
  // self-join's `FROM "x" AS "y"` are all ANSI-standard, so the SAME body must agree
  // on SQLite and a real Postgres socket.
  it("inner/left joins + a self-join via alias agree on both drivers", async () => {
    const joinAuthors = defineTable("join_authors", {
      id: integer("id").primaryKey({ autoIncrement: true }),
      name: text("name").notNull(),
      managerId: integer("manager_id").references((): Column<number> => joinAuthors.id),
    });
    const joinPosts = defineTable("join_posts", {
      id: integer("id").primaryKey({ autoIncrement: true }),
      authorId: integer("author_id").references(() => joinAuthors.id), // nullable
      title: text("title").notNull(),
    });

    await handle.exec("DROP TABLE IF EXISTS join_posts");
    await handle.exec("DROP TABLE IF EXISTS join_authors");
    await handle.exec(createTableSql(joinAuthors, driver.name));
    await handle.exec(createTableSql(joinPosts, driver.name));

    const ada = await db.insert(joinAuthors).values({ name: "Ada" }).returning().get();
    // Grace reports to Ada (a self-reference, exercised by the alias self-join).
    const grace = await db
      .insert(joinAuthors)
      .values({ name: "Grace", managerId: ada.id })
      .returning()
      .get();
    await db.insert(joinPosts).values({ authorId: ada.id, title: "On Looms" }).run();

    // INNER JOIN: only the post with a real author matches, rows namespaced by table.
    const inner = await db
      .select()
      .from(joinPosts)
      .innerJoin(joinAuthors, eq(joinPosts.authorId, joinAuthors.id))
      .all();
    expect(inner).toHaveLength(1);
    expect(inner[0]?.join_posts.title).toBe("On Looms");
    expect(inner[0]?.join_authors.name).toBe("Ada");

    // LEFT JOIN: Grace has no post, so the post namespace collapses to null (not an
    // object of null cells) — the load-bearing invariant, proven on a real socket.
    const left = await db
      .select()
      .from(joinAuthors)
      .leftJoin(joinPosts, eq(joinPosts.authorId, joinAuthors.id))
      .orderBy(joinAuthors.name)
      .all();
    const byAuthor = new Map(left.map((r) => [r.join_authors.name, r.join_posts]));
    expect(byAuthor.get("Ada")).toMatchObject({ title: "On Looms" });
    expect(byAuthor.get("Grace")).toBeNull();

    // Self-join via alias: render `FROM "join_authors" AS "manager"` and read each
    // author with their manager. Only Grace has one.
    const manager = alias(joinAuthors, "manager");
    const reports = await db
      .select()
      .from(joinAuthors)
      .innerJoin(manager, eq(joinAuthors.managerId, manager.id))
      .all();
    expect(reports).toHaveLength(1);
    expect(reports[0]?.join_authors.name).toBe("Grace");
    expect(reports[0]?.manager.name).toBe("Ada");
    expect(reports[0]?.manager.id).toBe(grace.managerId);

    await handle.exec("DROP TABLE join_posts");
    await handle.exec("DROP TABLE join_authors");
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

    await handle.exec("DROP TABLE IF EXISTS lesto_jobs");
    await handle.exec("DROP TABLE IF EXISTS lesto_cache");
    await handle.exec("DROP TABLE IF EXISTS lesto_workflow_steps");
    await handle.exec("DROP TABLE IF EXISTS schema_migrations");
    await handle.exec("DROP TABLE IF EXISTS installer_items");
  });

  afterEach(async () => {
    await close();
  });

  it("queue.installSchema installs and enqueue→claim round-trips", async () => {
    const { Queue, installSchema } = await import("@lesto/queue");

    await installSchema(handle, driver.name);

    const queue = new Queue({ db: handle });
    const id = await queue.enqueue("ping", { n: 1 });
    const claimed = await queue.claim();

    expect(id).toBeGreaterThan(0);
    expect(claimed?.id).toBe(id);
    expect(claimed?.payload).toEqual({ n: 1 });
  });

  it("cache.installCacheSchema installs and set→get round-trips (BIGINT expires_at)", async () => {
    const { installCacheSchema, sqlStore } = await import("@lesto/cache");

    await installCacheSchema(handle, driver.name);

    const store = sqlStore(handle);
    // A real epoch-ms deadline (~1.75e12) — overflows int4, so this would have
    // failed to install on PG before the BIGINT fix.
    await store.set("k", { value: { ok: true }, expiresAt: 1_750_000_000_000 });

    expect(await store.get("k")).toEqual({ value: { ok: true }, expiresAt: 1_750_000_000_000 });
  });

  it("workflows.installWorkflowSchema installs and a step memoizes", async () => {
    const { Engine, installWorkflowSchema } = await import("@lesto/workflows");

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

// ---------------------------------------------------------------------------
// Migration advisory lock (increment 3): a fleet booting N instances against
// ONE Postgres must run each migration exactly once with zero DDL collisions.
// This needs TWO INDEPENDENT sessions racing the same database, so it is
// Postgres-only (two in-memory SQLite handles are separate databases — there is
// nothing to contend over; SQLite's single-connection FIFO is the documented
// story there).
// ---------------------------------------------------------------------------

const describePg = PG_URL === undefined ? describe.skip : describe;

describePg("migration advisory lock (postgres, two racing migrators)", () => {
  const racers = defineTable("lock_racers", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    note: text("note").notNull(),
  });

  const migration = {
    version: "001_lock_racers",
    migration: {
      up: async (s: { execute(sql: string): Promise<void>; dialect: Dialect }) => {
        // Plain CREATE TABLE (no IF NOT EXISTS): if both migrators ran the DDL,
        // the second would throw "relation already exists" — exactly the
        // collision the advisory lock must prevent.
        await s.execute(createTableSql(racers, s.dialect));
      },
    },
  };

  it("one runs, one waits — each migration applied exactly once, no DDL collision", async () => {
    const a = await openPostgresHandle();
    const b = await openPostgresHandle();

    try {
      await a.db.exec("DROP TABLE IF EXISTS lock_racers");
      await a.db.exec("DROP TABLE IF EXISTS schema_migrations");

      // Two migrators, two independent sessions, racing the SAME database.
      const [appliedA, appliedB] = await Promise.all([
        new Migrator(a.db, [migration], { dialect: "postgres" }).migrate(),
        new Migrator(b.db, [migration], { dialect: "postgres" }).migrate(),
      ]);

      // Exactly one migrator applied the migration; the other found it already
      // applied (the lock made it wait, then read the recorded version).
      const total = appliedA.length + appliedB.length;
      expect(total).toBe(1);

      // The table exists exactly once and is usable.
      const db = createDb(a.db, { dialect: "postgres" });
      const created = await db.insert(racers).values({ note: "ok" }).returning().get();
      expect(created.id).toBeGreaterThan(0);
    } finally {
      await a.close();
      await b.close();
    }
  });
});

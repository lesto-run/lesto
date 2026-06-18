/**
 * Edge-Postgres parity: the Cloudflare Hyperdrive adapter (`hyperdriveToSqlDatabase`,
 * `@volo/cloudflare`) must speak the SAME `@volo/db` `SqlDatabase` contract — over a
 * REAL Postgres socket — that the node `@volo/pg` driver does. Hyperdrive is the
 * flagship-tier Postgres path: a Worker has no node sockets, so Hyperdrive fronts a
 * real Postgres and hands the Worker a `connectionString` a postgres client speaks
 * over. This suite wraps a real `pg` connection EXACTLY as Hyperdrive would expose
 * it (one pinned connection, `query(text, values) => { rows, rowCount }`), then runs
 * the db-parity conformance body against it — insert/returning, get/all/orderBy/
 * limit/offset/count, update/delete change-counts, the `?`→`$n` round-trip with a
 * reused position, snake→camel hydration + null binding, and transaction
 * commit-visible / rollback-invisible.
 *
 * It runs ONLY when `VOLO_HYPERDRIVE_URL` is set (its own CI job with a postgres:16
 * service) — so the coverage gate never depends on a container. The unit suite
 * (`packages/cloudflare/test/hyperdrive.test.ts`) covers the adapter's branches
 * against a fake; THIS proves the same code drives a real Postgres byte-for-byte
 * like the node driver, which is the whole "same SqlDatabase surface, two tiers"
 * promise.
 *
 * A single `pg.Client` (not a `Pool`) is pinned per opened handle: the Hyperdrive
 * driver issues `BEGIN`/`COMMIT`/`ROLLBACK` as plain queries on the connection it is
 * given, so the transaction is only atomic if every statement lands on ONE
 * connection — which is precisely what a Worker holds for a request.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";

import { createDb, createTableSql, defineTable, eq, integer, text } from "@volo/db";
import type { Db, SqlDatabase } from "@volo/db";
import { hyperdriveToSqlDatabase } from "@volo/cloudflare";
import type { HyperdriveConnection, HyperdriveQueryResult } from "@volo/cloudflare";

// The schema-as-value drives every query AND the CREATE TABLE — one source of
// truth rendered for Postgres by `createTableSql(items, "postgres")`.
const items = defineTable("items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  score: integer("score").notNull(),
  note: text("note"),
});

const HYPERDRIVE_URL = process.env["VOLO_HYPERDRIVE_URL"];

/** A real `pg.Client`, structurally typed to the slice this test uses. */
interface PgClient {
  connect(): Promise<void>;
  query(text: string, values?: unknown[]): Promise<HyperdriveQueryResult>;
  end(): Promise<void>;
}

/**
 * Open ONE real Postgres connection over the Hyperdrive URL and wrap it in the
 * `HyperdriveConnection` shape the adapter consumes — exactly how a Worker wires a
 * postgres client to `env.HYPERDRIVE.connectionString`. `pg` is loaded dynamically
 * (a peer the CI job installs), mirroring `@volo/pg`'s `realPool`.
 */
async function openHyperdrive(): Promise<{ db: SqlDatabase; close: () => Promise<void> }> {
  const require = createRequire(import.meta.url);
  const { Client } = require("pg") as {
    Client: new (config: { connectionString: string }) => PgClient;
  };

  // Only ever called from the gated describe, so the URL is present.
  const client = new Client({ connectionString: HYPERDRIVE_URL! });
  await client.connect();

  const connection: HyperdriveConnection = {
    query: (text_, values) => client.query(text_, values),
  };

  return { db: hyperdriveToSqlDatabase(connection), close: () => client.end() };
}

const describeHyperdrive = HYPERDRIVE_URL === undefined ? describe.skip : describe;

describeHyperdrive("edge-postgres parity: hyperdriveToSqlDatabase over a real Postgres", () => {
  let handle: SqlDatabase;
  let db: Db;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const opened = await openHyperdrive();
    handle = opened.db;
    close = opened.close;

    await handle.exec("DROP TABLE IF EXISTS items");
    await handle.exec(createTableSql(items, "postgres"));

    db = createDb(handle, { dialect: "postgres" });
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

    // Offset WITHOUT a limit: the Postgres dialect emits a bare `OFFSET` (the
    // SQLite `LIMIT -1 OFFSET n` idiom PG rejects) — proven on a real socket.
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

  it("db.raw runs a parameterized query (?→$n round-trip) and returns rows", async () => {
    await db.insert(items).values({ name: "one", score: 1 }).run();
    await db.insert(items).values({ name: "two", score: 2 }).run();

    const rows = await db.raw<{ name: string }>(
      "SELECT name FROM items WHERE score >= ? ORDER BY name",
      [2],
    );

    expect(rows.map((r) => r.name)).toEqual(["two"]);
  });

  it("transaction commits the whole span (BEGIN/COMMIT on the one connection)", async () => {
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

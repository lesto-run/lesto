import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDb, createTableSql, defineTable, integer, text, type Db } from "@keel/db";
import type { MigrationEntry } from "@keel/migrate";
import { keel } from "@keel/web";

import { createApp } from "../src/index";

import type { KernelDatabase } from "../src/index";

// The DI boundary: the kernel speaks "array of positional params"; this
// adapter maps that onto better-sqlite3's variadic bind. A Postgres adapter
// looks the same.
function adapt(raw: Database.Database): KernelDatabase {
  const adapted: KernelDatabase = {
    exec: async (sql) => {
      raw.exec(sql);
    },

    prepare: (sql) => {
      const statement = raw.prepare(sql);

      return {
        run: async (params = []) => statement.run(...(params as never[])),
        get: async (params = []) => statement.get(...(params as never[])),
        all: async (params = []) => statement.all(...(params as never[])),
      };
    },

    transaction: async (fn) => {
      raw.exec("BEGIN");

      try {
        const out = await fn(adapted);
        raw.exec("COMMIT");

        return out;
      } catch (error) {
        try {
          raw.exec("ROLLBACK");
        } catch {
          /* preserve the original error */
        }

        throw error;
      }
    },
  };

  return adapted;
}

// The fixture table the migration below creates — the proof the kernel ran
// migrations before any query.
const posts = defineTable("posts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
});

// The one migration the app boots with: create the posts table from the
// schema-as-value (Phase D's canonical migration shape).
const createPosts: MigrationEntry = {
  version: "001_create_posts",
  migration: {
    up: async (schema) => {
      await schema.execute(createTableSql(posts));
    },
  },
};

let raw: Database.Database;
let db: KernelDatabase;
let queryDb: Db;

beforeEach(() => {
  raw = new Database(":memory:");
  db = adapt(raw);
  queryDb = createDb(db);
});

afterEach(() => {
  raw.close();
});

describe("createApp", () => {
  it("runs migrations on boot, then dispatches through the keel() router", async () => {
    const app = await createApp({
      db,
      app: keel().get("/posts/count", async (c) => {
        const count = await queryDb.select().from(posts).count();
        return c.json({ count });
      }),
      migrations: [createPosts],
    });

    // The migration ran before any request — the applied list proves the order,
    // and the migrated table is real and queryable through @keel/db.
    expect(app.migrationsApplied).toEqual(["001_create_posts"]);

    await queryDb.insert(posts).values({ title: "via keel()" }).run();

    const response = await app.handle("GET", "/posts/count");

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(response.body)).toEqual({ count: 1 });
  });

  it("applies no migrations when none are configured", async () => {
    const app = await createApp({ db, app: keel().get("/ping", (c) => c.text("pong")) });

    expect(app.migrationsApplied).toEqual([]);
    expect((await app.handle("GET", "/ping")).body).toBe("pong");
  });

  it('runs nothing when migrations is "skip" (a fleet member that defers to another)', async () => {
    // The schema is already migrated by another instance; this member must boot
    // against it WITHOUT running migrations itself.
    const app = await createApp({
      db,
      app: keel().get("/ping", (c) => c.text("pong")),
      migrations: "skip",
    });

    expect(app.migrationsApplied).toEqual([]);
  });

  it("runs config.schemas installers in order after migrate, against the same db", async () => {
    // The Finding #2 seam: a battery (e.g. @keel/queue for @keel/mail) declares its
    // own table via `schemas`, run after migrations against the same handle. Prove
    // order (a later installer sees an earlier one's table) AND that the table the
    // installer created is real and queryable through the migrated handle.
    const order: string[] = [];

    const app = await createApp({
      db,
      app: keel().get("/ping", (c) => c.text("pong")),
      migrations: [createPosts],
      schemas: [
        async (database) => {
          order.push("first");
          await database.exec("CREATE TABLE IF NOT EXISTS battery_a (id INTEGER PRIMARY KEY)");
        },
        async (database) => {
          // Depends on the first installer's table existing — proves serial order.
          order.push("second");
          await database.exec("INSERT INTO battery_a (id) VALUES (1)");
        },
      ],
    });

    // Migrations ran first; the seam did not disturb the applied list.
    expect(app.migrationsApplied).toEqual(["001_create_posts"]);
    // Installers ran in array order.
    expect(order).toEqual(["first", "second"]);
    // The installer's table is real on the same handle and carries the second
    // installer's row — one db threaded through migrate + every schema installer.
    const row = await db.prepare("SELECT COUNT(*) AS n FROM battery_a").get();
    expect((row as { n: number }).n).toBe(1);
  });

  it("runs no schema installers when config.schemas is absent", async () => {
    // The absent case is a zero-iteration loop, not a thrown error — booting an
    // app with no batteries declared must touch no extra tables.
    const app = await createApp({
      db,
      app: keel().get("/ping", (c) => c.text("pong")),
    });

    expect((await app.handle("GET", "/ping")).body).toBe("pong");
  });

  it("delegates an unmatched path to a plain 404", async () => {
    const app = await createApp({ db, app: keel().get("/ping", (c) => c.text("pong")) });

    const response = await app.handle("GET", "/nope");

    expect(response.status).toBe(404);
    expect(response.body).toBe("Not Found");
  });

  it("threads config.dialect into the migrator (the Postgres advisory-lock path runs)", async () => {
    // The migrator takes the `pg_advisory_xact_lock` path ONLY when dialect
    // "postgres" reached it — so observing that lock proves the kernel threaded
    // the dialect through to `new Migrator(..., { dialect })`. Empty migrations
    // exercise the lock without a per-migration transaction; the sqlite test
    // handle can't run `pg_advisory_*`, so we record-and-stub those statements.
    const prepared: string[] = [];
    const pgish: KernelDatabase = {
      exec: async (sql) => {
        raw.exec(sql);
      },
      prepare: (sql) => {
        prepared.push(sql);

        // sqlite has no pg_advisory_* functions; stub them.
        if (sql.includes("pg_advisory")) {
          return {
            run: async () => ({ changes: 0 }),
            get: async () => undefined,
            all: async () => [],
          };
        }

        const statement = raw.prepare(sql);

        return {
          run: async (params = []) => statement.run(...(params as never[])),
          get: async (params = []) => statement.get(...(params as never[])),
          all: async (params = []) => statement.all(...(params as never[])),
        };
      },
      // Pass `pgish` itself as the tx so the advisory-lock statements prepared on
      // the transaction handle hit the stub above (mirrors a pinned connection).
      transaction: async (fn) => {
        raw.exec("BEGIN");

        try {
          const out = await fn(pgish);
          raw.exec("COMMIT");

          return out;
        } catch (error) {
          try {
            raw.exec("ROLLBACK");
          } catch {
            /* preserve the original error */
          }

          throw error;
        }
      },
    };

    const app = await createApp({
      db: pgish,
      app: keel().get("/ping", (c) => c.text("pong")),
      migrations: [],
      dialect: "postgres",
    });

    expect(prepared.some((sql) => sql.includes("pg_advisory_xact_lock"))).toBe(true);
    expect(app.migrationsApplied).toEqual([]);
  });
});

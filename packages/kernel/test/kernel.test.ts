import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDb, createTableSql, defineTable, integer, text, type Db } from "@keel/db";
import type { MigrationEntry } from "@keel/migrate";
import { Router } from "@keel/router";
import { Controller } from "@keel/web";
import type { ControllerClass } from "@keel/web";

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

// The controllers close over the typed `Db` the test wires up — the kernel
// no longer touches the data layer beyond handing `config.db` to the
// migrator.
function buildControllers(db: Db): { posts: ControllerClass } {
  class PostsController extends Controller {
    async index() {
      return this.json({ posts: await db.select().from(posts).all() });
    }
  }

  return { posts: PostsController as ControllerClass };
}

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

function buildRouter(): Router {
  const router = new Router();

  router.resources("posts");

  return router;
}

describe("createApp", () => {
  it("runs migrations on boot and exposes the applied versions", async () => {
    const app = await createApp({
      db,
      router: buildRouter(),
      controllers: buildControllers(queryDb),
      migrations: [createPosts],
    });

    expect(app.migrationsApplied).toEqual(["001_create_posts"]);

    // The migrated table is real and queryable through @keel/db.
    await queryDb.insert(posts).values({ title: "Seeded directly" }).run();

    expect(await queryDb.select().from(posts).count()).toBe(1);
  });

  it("applies no migrations when none are configured", async () => {
    // Stand the schema up out of band so the query still has a table to read.
    await db.exec(createTableSql(posts));

    const app = await createApp({
      db,
      router: buildRouter(),
      controllers: buildControllers(queryDb),
    });

    expect(app.migrationsApplied).toEqual([]);
  });
});

describe("App#handle", () => {
  it("dispatches a request end-to-end: seed a row, GET it back through a controller", async () => {
    const app = await createApp({
      db,
      router: buildRouter(),
      controllers: buildControllers(queryDb),
      migrations: [createPosts],
    });

    await queryDb.insert(posts).values({ title: "Hello, kernel" }).run();

    const response = await app.handle("GET", "/posts");

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("application/json");

    const payload = JSON.parse(response.body) as { posts: { title: string }[] };

    expect(payload.posts).toHaveLength(1);
    expect(payload.posts[0]?.title).toBe("Hello, kernel");
  });

  it("delegates an unmatched path to a plain 404", async () => {
    const app = await createApp({
      db,
      router: buildRouter(),
      controllers: buildControllers(queryDb),
      migrations: [createPosts],
    });

    const response = await app.handle("GET", "/nope");

    expect(response.status).toBe(404);
    expect(response.body).toBe("Not Found");
  });
});

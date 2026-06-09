import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Model, resetConnection } from "@keel/orm";
import type { MigrationEntry } from "@keel/migrate";
import { Router } from "@keel/router";
import { Controller } from "@keel/web";

import { createApp } from "../src/index";

import type { KernelDatabase } from "../src/index";

// The DI boundary: the kernel speaks "array of positional params"; this adapter
// maps that onto better-sqlite3's variadic bind. A Postgres adapter looks the same.
function adapt(raw: Database.Database): KernelDatabase {
  return {
    exec: (sql) => raw.exec(sql),

    prepare: (sql) => {
      const statement = raw.prepare(sql);

      return {
        run: (params = []) => statement.run(...(params as never[])),
        get: (params = []) => statement.get(...(params as never[])),
        all: (params = []) => statement.all(...(params as never[])),
      };
    },
  };
}

// A model whose table the migration below creates — the proof the kernel ran
// migrations before the ORM queried anything.
class Post extends Model {
  static override timestamps = true;
}

// The one migration the app boots with: create the posts table.
const createPosts: MigrationEntry = {
  version: "001_create_posts",
  migration: {
    up: (schema) => {
      schema.createTable("posts", (t) => {
        t.string("title", { null: false });
        t.timestamps();
      });
    },
  },
};

// A controller whose index action queries the model and renders it as JSON —
// the far end of the end-to-end round-trip.
class PostsController extends Controller {
  index() {
    const posts = Post.order("id", "asc")
      .all()
      .map((post) => post.toJSON());

    return this.json({ posts });
  }
}

function buildRouter(): Router {
  const router = new Router();

  router.resources("posts");

  return router;
}

let raw: Database.Database;
let db: KernelDatabase;

beforeEach(() => {
  raw = new Database(":memory:");
  db = adapt(raw);
});

afterEach(() => {
  resetConnection();
  raw.close();
});

describe("createApp", () => {
  it("runs migrations on boot and exposes the applied versions", () => {
    const app = createApp({
      db,
      router: buildRouter(),
      controllers: { posts: PostsController },
      migrations: [createPosts],
    });

    expect(app.migrationsApplied).toEqual(["001_create_posts"]);

    // The migrated table is real and queryable through the ORM model.
    Post.create({ title: "Seeded directly" });

    expect(Post.count()).toBe(1);
  });

  it("applies no migrations when none are configured", () => {
    // Stand the schema up out of band so the ORM still has a table to read.
    raw.exec(
      "CREATE TABLE posts (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, created_at TEXT, updated_at TEXT)",
    );

    const app = createApp({
      db,
      router: buildRouter(),
      controllers: { posts: PostsController },
    });

    expect(app.migrationsApplied).toEqual([]);
  });
});

describe("App#handle", () => {
  it("dispatches a request end-to-end: seed a row, GET it back through a controller", async () => {
    const app = createApp({
      db,
      router: buildRouter(),
      controllers: { posts: PostsController },
      migrations: [createPosts],
    });

    // Seed through the same ORM the kernel connected.
    Post.create({ title: "Hello, kernel" });

    const response = await app.handle("GET", "/posts");

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("application/json");

    const payload = JSON.parse(response.body) as { posts: { title: string }[] };

    expect(payload.posts).toHaveLength(1);
    expect(payload.posts[0]?.title).toBe("Hello, kernel");
  });

  it("delegates an unmatched path to a plain 404", async () => {
    const app = createApp({
      db,
      router: buildRouter(),
      controllers: { posts: PostsController },
      migrations: [createPosts],
    });

    const response = await app.handle("GET", "/nope");

    expect(response.status).toBe(404);
    expect(response.body).toBe("Not Found");
  });
});

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Controller } from "@keel/web";
import { createDb, createTableSql, defineTable, integer, text, type Db } from "@keel/db";
import { Router } from "@keel/router";
import { createApp } from "@keel/kernel";
import { Migrator } from "@keel/migrate";
import type { MigrationEntry } from "@keel/migrate";
import type { App, KernelDatabase } from "@keel/kernel";

import { setData } from "@keel/content-core";
import type { RuntimeEntry } from "@keel/content-core";
import { contentEntriesMigration } from "@keel/content-store";

import { buildTools, dispatch } from "../src/tools";
import { McpError } from "../src/errors";

import type { KeelMcpContext } from "../src/tools";

// The DI boundary: the kernel speaks "array of positional params"; this adapter
// maps that onto better-sqlite3's variadic bind.
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

// A table the migration below creates, queried by the controller via @keel/db.
const posts = defineTable("posts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
});

const createPosts: MigrationEntry = {
  version: "001_create_posts",
  migration: {
    up: (schema) => {
      schema.execute(createTableSql(posts));
    },
  },
};

let queryDb: Db;

class PostsController extends Controller {
  index() {
    return this.json({ posts: queryDb.select().from(posts).orderBy(posts.id, "asc").all() });
  }
}

function buildRouter(): Router {
  const router = new Router();

  router.resources("posts");

  return router;
}

let raw: Database.Database;
let router: Router;
let app: App;

beforeEach(() => {
  raw = new Database(":memory:");
  const db = adapt(raw);
  queryDb = createDb(db);

  router = buildRouter();

  app = createApp({
    db,
    router,
    controllers: { posts: PostsController },
    migrations: [createPosts],
  });
});

afterEach(() => {
  raw.close();
});

describe("buildTools", () => {
  it("returns the Keel tools with stable names, descriptions, and input schemas", () => {
    const tools = buildTools({ app, router });

    expect(tools.map((tool) => tool.name)).toEqual([
      "list_routes",
      "handle_request",
      "generate_ui",
      "list_content_collections",
      "get_content_entry",
      "query_content",
      "create_content_entry",
      "update_content_entry",
      "delete_content_entry",
    ]);

    for (const tool of tools) {
      expect(typeof tool.description).toBe("string");
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema).toMatchObject({ type: "object" });
    }

    const handleRequest = tools.find((tool) => tool.name === "handle_request");

    expect(handleRequest?.inputSchema).toMatchObject({ required: ["method", "path"] });

    const generateUi = tools.find((tool) => tool.name === "generate_ui");

    expect(generateUi?.inputSchema).toMatchObject({ required: ["prompt"] });
  });
});

describe("list_routes handler", () => {
  it("returns the router's routes", async () => {
    const tools = buildTools({ app, router });

    const routes = (await dispatch(tools, "list_routes", {})) as { target: string }[];

    expect(routes).toEqual(router.list());
    expect(routes.some((route) => route.target === "posts#index")).toBe(true);
  });
});

// A minimal runtime entry with the metadata content-core attaches.
function entry(collection: string, slug: string, data: Record<string, unknown>): RuntimeEntry {
  return {
    id: slug,
    collection,
    file: {
      path: `${collection}/${slug}.md`,
      fileName: `${slug}.md`,
      extension: ".md",
      directory: collection,
      pathSegments: [slug],
      isIndex: false,
    },
    slug,
    ...data,
  };
}

describe("content tools", () => {
  beforeEach(() => {
    // Hydrate content-core's runtime store as `@keel/content-store` would at boot.
    setData({
      posts: [
        entry("posts", "hello", { title: "Hello" }),
        entry("posts", "world", { title: "World" }),
      ],
      pages: [entry("pages", "about", { title: "About" })],
    });
  });

  it("list_content_collections returns each collection with its entry count", async () => {
    const tools = buildTools({ app, router });

    const collections = await dispatch(tools, "list_content_collections", {});

    expect(collections).toEqual([
      { name: "posts", count: 2 },
      { name: "pages", count: 1 },
    ]);
  });

  it("get_content_entry returns the entry when it exists", async () => {
    const tools = buildTools({ app, router });

    const result = await dispatch(tools, "get_content_entry", {
      collection: "posts",
      slug: "hello",
    });

    expect(result).toMatchObject({ title: "Hello", slug: "hello" });
  });

  it("get_content_entry returns null when the entry is absent", async () => {
    const tools = buildTools({ app, router });

    const result = await dispatch(tools, "get_content_entry", {
      collection: "posts",
      slug: "missing",
    });

    expect(result).toBeNull();
  });

  it("query_content lists all of a collection's entries", async () => {
    const tools = buildTools({ app, router });

    const entries = (await dispatch(tools, "query_content", {
      collection: "posts",
    })) as RuntimeEntry[];

    expect(entries.map((e) => e.slug)).toEqual(["hello", "world"]);
  });

  it("query_content caps the result at the given limit", async () => {
    const tools = buildTools({ app, router });

    const entries = (await dispatch(tools, "query_content", {
      collection: "posts",
      limit: 1,
    })) as RuntimeEntry[];

    expect(entries).toHaveLength(1);
    expect(entries[0]?.slug).toBe("hello");
  });
});

describe("content write tools", () => {
  // The write tools mutate a content-store database; give the context one,
  // migrated to hold the content_entries table.
  function withContentDb(): KeelMcpContext {
    const contentDb = adapt(raw);

    new Migrator(contentDb, [contentEntriesMigration]).migrate();

    return { app, router, contentDb };
  }

  it("create_content_entry writes an entry the read tools can then see", async () => {
    const tools = buildTools(withContentDb());

    const created = (await dispatch(tools, "create_content_entry", {
      collection: "posts",
      slug: "fresh",
      data: { title: "Fresh" },
      content: "# Fresh",
    })) as RuntimeEntry;

    expect(created).toMatchObject({ collection: "posts", slug: "fresh", title: "Fresh" });

    // The write re-hydrated the runtime, so a read tool now finds it.
    const read = await dispatch(tools, "get_content_entry", { collection: "posts", slug: "fresh" });
    expect(read).toMatchObject({ title: "Fresh" });
  });

  it("create_content_entry accepts a bare entry with no data or body", async () => {
    const tools = buildTools(withContentDb());

    const created = (await dispatch(tools, "create_content_entry", {
      collection: "pages",
      slug: "blank",
    })) as RuntimeEntry;

    expect(created).toMatchObject({ collection: "pages", slug: "blank" });
  });

  it("update_content_entry changes an existing entry", async () => {
    const tools = buildTools(withContentDb());

    await dispatch(tools, "create_content_entry", {
      collection: "posts",
      slug: "edit",
      data: { title: "Old" },
    });

    const updated = (await dispatch(tools, "update_content_entry", {
      collection: "posts",
      slug: "edit",
      data: { title: "New" },
    })) as RuntimeEntry;

    expect(updated).toMatchObject({ title: "New" });
  });

  it("delete_content_entry removes an entry and reports the count", async () => {
    const tools = buildTools(withContentDb());

    await dispatch(tools, "create_content_entry", { collection: "posts", slug: "gone" });

    const result = await dispatch(tools, "delete_content_entry", {
      collection: "posts",
      slug: "gone",
    });

    expect(result).toEqual({ deleted: 1 });
  });

  it("refuses to write when no content store is configured", async () => {
    const tools = buildTools({ app, router });

    await expect(
      dispatch(tools, "create_content_entry", { collection: "posts", slug: "x" }),
    ).rejects.toMatchObject({ code: "MCP_CONTENT_STORE_UNAVAILABLE" });
  });
});

describe("handle_request handler", () => {
  it("dispatches to app.handle and returns the response", async () => {
    queryDb.insert(posts).values({ title: "Hello, MCP" }).run();

    const tools = buildTools({ app, router });

    const response = (await dispatch(tools, "handle_request", {
      method: "GET",
      path: "/posts",
    })) as { status: number; body: string };

    expect(response.status).toBe(200);

    const payload = JSON.parse(response.body) as { posts: { title: string }[] };

    expect(payload.posts[0]?.title).toBe("Hello, MCP");
  });

  it("forwards query and body through to the app", async () => {
    // A stub App proves the handler threads method/path/query/body verbatim.
    const calls: { method: string; path: string; options: unknown }[] = [];

    const stubApp: App = {
      migrationsApplied: [],
      handle: async (method, path, options) => {
        calls.push({ method, path, options });

        return { status: 201, headers: {}, body: "ok" };
      },
    };

    const tools = buildTools({ app: stubApp, router });

    const response = (await dispatch(tools, "handle_request", {
      method: "POST",
      path: "/posts",
      query: { draft: "true" },
      body: { title: "x" },
    })) as { status: number };

    expect(response.status).toBe(201);

    expect(calls[0]).toEqual({
      method: "POST",
      path: "/posts",
      options: { query: { draft: "true" }, body: { title: "x" } },
    });
  });
});

describe("generate_ui handler", () => {
  it("returns the injected generateUi output", async () => {
    const context: KeelMcpContext = {
      app,
      router,
      generateUi: (prompt) => Promise.resolve({ rendered: prompt }),
    };

    const tools = buildTools(context);

    const result = await dispatch(tools, "generate_ui", { prompt: "a login form" });

    expect(result).toEqual({ rendered: "a login form" });
  });

  it("throws MCP_GENERATE_UNAVAILABLE when generateUi is not configured", async () => {
    const tools = buildTools({ app, router });

    await expect(dispatch(tools, "generate_ui", { prompt: "x" })).rejects.toMatchObject({
      code: "MCP_GENERATE_UNAVAILABLE",
    });

    const error = await dispatch(tools, "generate_ui", { prompt: "x" }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(McpError);
  });
});

describe("dispatch", () => {
  it("runs a found tool's handler", async () => {
    const tools = buildTools({ app, router });

    const routes = await dispatch(tools, "list_routes", {});

    expect(routes).toEqual(router.list());
  });

  it("throws MCP_UNKNOWN_TOOL for an unknown name", async () => {
    const tools = buildTools({ app, router });

    await expect(dispatch(tools, "nope", {})).rejects.toMatchObject({
      code: "MCP_UNKNOWN_TOOL",
      details: { name: "nope" },
    });

    const error = await dispatch(tools, "nope", {}).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(McpError);
  });
});

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { lesto } from "@lesto/web";
import { createDb, createTableSql, defineTable, integer, text, type Db } from "@lesto/db";
import { createApp } from "@lesto/kernel";
import { Migrator } from "@lesto/migrate";
import type { MigrationEntry } from "@lesto/migrate";
import type { App, KernelDatabase } from "@lesto/kernel";

import { getCollections, getEntry, query, setData } from "@lesto/content-core";
import type { RuntimeEntry } from "@lesto/content-core";
import {
  contentEntriesMigration,
  createEntry,
  deleteEntry,
  loadEntries,
  updateEntry,
} from "@lesto/content-store";

import { buildTools, dispatch, mcpPrincipalResolver } from "../src/tools";
import { McpError } from "../src/errors";

import type {
  ContentModules,
  LestoMcpContext,
  McpAuditRecord,
  McpDevStateReader,
} from "../src/tools";

// The DI boundary: the kernel speaks "array of positional params"; this adapter
// maps that onto better-sqlite3's variadic bind. The terminals are async (ADR
// 0006) — a resolved Promise over the synchronous engine — while `prepare`
// stays sync; `transaction()` brackets BEGIN/COMMIT (ROLLBACK on reject).
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

// A table the migration below creates, queried by the controller via @lesto/db.
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

let raw: Database.Database;
let routes: ReadonlyArray<{ method: string; pattern: string }>;
let app: App;

// Every dispatch lands here; tests assert the audit trail is never empty.
let audited: McpAuditRecord[];

// The real content modules behind the optional-peer seam. In the monorepo the
// content packages ARE installed, so the content tools run against them exactly as
// the published server would once a user adds the packages — `context()` injects
// this by default. The "content peer optionality" test builds a context WITHOUT it.
const loadRealContent = (): Promise<ContentModules> =>
  Promise.resolve({
    core: { getCollections, getEntry, query, setData },
    store: { createEntry, deleteEntry, loadEntries, updateEntry },
  });

// A context with the mandatory audit sink wired to the capturing array. Each
// test starts a fresh sink; `mode` defaults to read-only unless overridden, and the
// content peers default to the real modules (overridable / droppable per test).
function context(overrides: Partial<LestoMcpContext> = {}): LestoMcpContext {
  return {
    app,
    routes,
    audit: (record) => void audited.push(record),
    loadContent: loadRealContent,
    ...overrides,
  };
}

beforeEach(async () => {
  raw = new Database(":memory:");
  const db = adapt(raw);
  queryDb = createDb(db);
  audited = [];

  const lestoApp = lesto().get("/posts", async (c) =>
    c.json({ posts: await queryDb.select().from(posts).orderBy(posts.id, "asc").all() }),
  );

  routes = lestoApp.routes();

  app = await createApp({ db, app: lestoApp, migrations: [createPosts] });
});

afterEach(() => {
  raw.close();
});

describe("buildTools", () => {
  it("returns the Lesto tools with stable names, descriptions, and input schemas", () => {
    const tools = buildTools(context());

    expect(tools.map((tool) => tool.name)).toEqual([
      "list_routes",
      "handle_request",
      "generate_ui",
      "list_content_collections",
      "get_content_entry",
      "query_content",
      "describe_app",
      "create_content_entry",
      "update_content_entry",
      "delete_content_entry",
      "get_dev_diagnostics",
      "get_recent_requests",
      "tail_logs",
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

  it("marks exactly the state-mutating tools destructive", () => {
    const tools = buildTools(context());

    const destructive = tools.filter((tool) => tool.destructive).map((tool) => tool.name);

    // The content writes plus `handle_request` (which can POST/DELETE) are the
    // destructive set; the read tools are not.
    expect(destructive.toSorted()).toEqual([
      "create_content_entry",
      "delete_content_entry",
      "handle_request",
      "update_content_entry",
    ]);
  });
});

describe("describe_app tool", () => {
  it("dispatches in read-only mode without refusal, returning the four-part contract", async () => {
    // Hydrate content-core's runtime as a booted server would (the content view of
    // the contract needs it, exactly as `list_content_collections` does).
    setData({ posts: [entry("posts", "hello", { title: "Hello" })] });

    const ctx = context({ mode: "read-only" });
    const tools = buildTools(ctx);

    const payload = (await dispatch(ctx, tools, "describe_app", {})) as {
      routes: unknown;
      openapi: unknown;
      collections: unknown;
      schema: unknown;
    };

    expect(payload.routes).toEqual(routes);
    expect(payload).toHaveProperty("openapi");
    expect(payload.collections).toEqual([{ name: "posts", count: 1 }]);
    expect(payload).toHaveProperty("schema");
  });

  it("dispatches without refusal on a content-less app (collections empty, not thrown)", async () => {
    // No `loadContent`: the content tools would throw MCP_CONTENT_PACKAGES_MISSING,
    // but `describe_app` degrades gracefully to an empty collections list.
    const ctx: LestoMcpContext = { app, routes, audit: (record) => void audited.push(record) };
    const tools = buildTools(ctx);

    const payload = (await dispatch(ctx, tools, "describe_app", {})) as { collections: unknown };

    expect(payload.collections).toEqual([]);
  });
});

describe("dev introspection tools (ADR 0032 Phase 1)", () => {
  const devError = { source: "client-rebuild", message: "boom" };

  function devContext(): {
    ctx: LestoMcpContext;
    calls: { requests: number[]; logs: number[] };
  } {
    const calls = { requests: [] as number[], logs: [] as number[] };

    const reader: McpDevStateReader = {
      getDiagnostics: () => devError,
      recentRequests: (n) => {
        calls.requests.push(n);

        return [{ requestId: "r1", method: "GET", path: "/x", status: 200, ms: 1 }];
      },
      recentLogs: (n) => {
        calls.logs.push(n);

        return ["log-a"];
      },
    };

    return { ctx: context({ devState: reader }), calls };
  }

  it("get_dev_diagnostics returns the current DevError", async () => {
    const { ctx } = devContext();
    const tools = buildTools(ctx);

    expect(await dispatch(ctx, tools, "get_dev_diagnostics", {})).toEqual(devError);
  });

  it("get_dev_diagnostics returns null when the last change succeeded", async () => {
    const ctx = context({
      devState: { getDiagnostics: () => undefined, recentRequests: () => [], recentLogs: () => [] },
    });
    const tools = buildTools(ctx);

    expect(await dispatch(ctx, tools, "get_dev_diagnostics", {})).toBeNull();
  });

  it("get_recent_requests passes the limit through, defaulting to 50 when absent", async () => {
    const { ctx, calls } = devContext();
    const tools = buildTools(ctx);

    const out = await dispatch(ctx, tools, "get_recent_requests", { limit: 5 });
    await dispatch(ctx, tools, "get_recent_requests", {});

    expect(out).toEqual([{ requestId: "r1", method: "GET", path: "/x", status: 200, ms: 1 }]);
    expect(calls.requests).toEqual([5, 50]);
  });

  it("tail_logs passes the limit through, defaulting to 50 when absent", async () => {
    const { ctx, calls } = devContext();
    const tools = buildTools(ctx);

    const out = await dispatch(ctx, tools, "tail_logs", {});

    expect(out).toEqual(["log-a"]);
    expect(calls.logs).toEqual([50]);
  });

  it("each dev tool refuses with MCP_DEV_STATE_UNAVAILABLE when no reader is wired", async () => {
    const ctx = context(); // no devState — not `lesto dev`
    const tools = buildTools(ctx);

    for (const name of ["get_dev_diagnostics", "get_recent_requests", "tail_logs"]) {
      await expect(dispatch(ctx, tools, name, {})).rejects.toMatchObject({
        code: "MCP_DEV_STATE_UNAVAILABLE",
      });
    }
  });

  it("audits both a successful dev dispatch and the unavailable refusal", async () => {
    const { ctx } = devContext();
    await dispatch(ctx, buildTools(ctx), "tail_logs", {});

    expect(audited.at(-1)).toMatchObject({ tool: "tail_logs", outcome: "ok" });

    const bare = context();
    await dispatch(bare, buildTools(bare), "get_dev_diagnostics", {}).catch(() => {});

    expect(audited.at(-1)).toMatchObject({ tool: "get_dev_diagnostics", outcome: "error" });
  });
});

describe("list_routes handler", () => {
  it("returns the app's routes", async () => {
    const ctx = context();
    const tools = buildTools(ctx);

    const result = (await dispatch(ctx, tools, "list_routes", {})) as {
      method: string;
      pattern: string;
    }[];

    expect(result).toEqual(routes);
    expect(result.some((route) => route.method === "GET" && route.pattern === "/posts")).toBe(true);
  });

  it("is readable in read-only mode without operator escalation", async () => {
    const ctx = context({ mode: "read-only" });
    const tools = buildTools(ctx);

    await expect(dispatch(ctx, tools, "list_routes", {})).resolves.toEqual(routes);
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
    // Hydrate content-core's runtime store as `@lesto/content-store` would at boot.
    setData({
      posts: [
        entry("posts", "hello", { title: "Hello" }),
        entry("posts", "world", { title: "World" }),
      ],
      pages: [entry("pages", "about", { title: "About" })],
    });
  });

  it("list_content_collections returns each collection with its entry count", async () => {
    const ctx = context();
    const tools = buildTools(ctx);

    const collections = await dispatch(ctx, tools, "list_content_collections", {});

    expect(collections).toEqual([
      { name: "posts", count: 2 },
      { name: "pages", count: 1 },
    ]);
  });

  it("get_content_entry returns the entry when it exists", async () => {
    const ctx = context();
    const tools = buildTools(ctx);

    const result = await dispatch(ctx, tools, "get_content_entry", {
      collection: "posts",
      slug: "hello",
    });

    expect(result).toMatchObject({ title: "Hello", slug: "hello" });
  });

  it("get_content_entry returns null when the entry is absent", async () => {
    const ctx = context();
    const tools = buildTools(ctx);

    const result = await dispatch(ctx, tools, "get_content_entry", {
      collection: "posts",
      slug: "missing",
    });

    expect(result).toBeNull();
  });

  it("query_content lists all of a collection's entries", async () => {
    const ctx = context();
    const tools = buildTools(ctx);

    const entries = (await dispatch(ctx, tools, "query_content", {
      collection: "posts",
    })) as RuntimeEntry[];

    expect(entries.map((e) => e.slug)).toEqual(["hello", "world"]);
  });

  it("query_content caps the result at the given limit", async () => {
    const ctx = context();
    const tools = buildTools(ctx);

    const entries = (await dispatch(ctx, tools, "query_content", {
      collection: "posts",
      limit: 1,
    })) as RuntimeEntry[];

    expect(entries).toHaveLength(1);
    expect(entries[0]?.slug).toBe("hello");
  });
});

describe("content peer optionality", () => {
  it("a content tool refuses with MCP_CONTENT_PACKAGES_MISSING when the peers aren't loaded", async () => {
    // No `loadContent` on the context — the optional content peers aren't installed,
    // so the content tools fail closed with one coded message (the generic tools work).
    const ctx: LestoMcpContext = { app, routes, audit: (record) => void audited.push(record) };
    const tools = buildTools(ctx);

    await expect(dispatch(ctx, tools, "list_content_collections", {})).rejects.toMatchObject({
      code: "MCP_CONTENT_PACKAGES_MISSING",
    });

    const error = await dispatch(ctx, tools, "list_content_collections", {}).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(McpError);

    // The generic, non-content tools are unaffected by the absent content peers.
    await expect(dispatch(ctx, tools, "list_routes", {})).resolves.toEqual(routes);
  });
});

describe("content write tools", () => {
  // The write tools mutate a content-store database; give the context one,
  // migrated to hold the content_entries table, AND operator mode so the gate
  // lets them through.
  async function withContentDb(): Promise<LestoMcpContext> {
    const contentDb = adapt(raw);

    await new Migrator(contentDb, [contentEntriesMigration]).migrate();

    return context({ contentDb, mode: "operator" });
  }

  it("create_content_entry writes an entry the read tools can then see", async () => {
    const ctx = await withContentDb();
    const tools = buildTools(ctx);

    const created = (await dispatch(ctx, tools, "create_content_entry", {
      collection: "posts",
      slug: "fresh",
      data: { title: "Fresh" },
      content: "# Fresh",
    })) as RuntimeEntry;

    expect(created).toMatchObject({ collection: "posts", slug: "fresh", title: "Fresh" });

    // The write re-hydrated the runtime, so a read tool now finds it.
    const read = await dispatch(ctx, tools, "get_content_entry", {
      collection: "posts",
      slug: "fresh",
    });
    expect(read).toMatchObject({ title: "Fresh" });
  });

  it("create_content_entry accepts a bare entry with no data or body", async () => {
    const ctx = await withContentDb();
    const tools = buildTools(ctx);

    const created = (await dispatch(ctx, tools, "create_content_entry", {
      collection: "pages",
      slug: "blank",
    })) as RuntimeEntry;

    expect(created).toMatchObject({ collection: "pages", slug: "blank" });
  });

  it("a write to one collection leaves the other DB-backed collections intact", async () => {
    // The incremental refresh patches only the collection it wrote — it must not
    // drop entries the runtime already holds for OTHER collections. Author a
    // `pages` entry, then write to `posts`, and assert the `pages` entry is still
    // readable: proof the refresh is collection-scoped, not a full clobber.
    const ctx = await withContentDb();
    const tools = buildTools(ctx);

    await dispatch(ctx, tools, "create_content_entry", {
      collection: "pages",
      slug: "about",
      data: { title: "About" },
    });

    await dispatch(ctx, tools, "create_content_entry", {
      collection: "posts",
      slug: "first",
      data: { title: "First" },
    });

    // The just-written post is readable...
    const post = await dispatch(ctx, tools, "get_content_entry", {
      collection: "posts",
      slug: "first",
    });
    expect(post).toMatchObject({ title: "First" });

    // ...and the `pages` collection written earlier survived the `posts` refresh.
    const page = await dispatch(ctx, tools, "get_content_entry", {
      collection: "pages",
      slug: "about",
    });
    expect(page).toMatchObject({ title: "About" });
  });

  it("update_content_entry changes an existing entry", async () => {
    const ctx = await withContentDb();
    const tools = buildTools(ctx);

    await dispatch(ctx, tools, "create_content_entry", {
      collection: "posts",
      slug: "edit",
      data: { title: "Old" },
    });

    const updated = (await dispatch(ctx, tools, "update_content_entry", {
      collection: "posts",
      slug: "edit",
      data: { title: "New" },
    })) as RuntimeEntry;

    expect(updated).toMatchObject({ title: "New" });
  });

  it("delete_content_entry removes an entry and reports the count", async () => {
    const ctx = await withContentDb();
    const tools = buildTools(ctx);

    await dispatch(ctx, tools, "create_content_entry", { collection: "posts", slug: "gone" });

    const result = await dispatch(ctx, tools, "delete_content_entry", {
      collection: "posts",
      slug: "gone",
    });

    expect(result).toEqual({ deleted: 1 });
  });

  it("refuses to write when no content store is configured (operator mode)", async () => {
    // Operator mode clears the mode gate, so the refusal here is purely the
    // missing content store — not the governance.
    const ctx = context({ mode: "operator" });
    const tools = buildTools(ctx);

    await expect(
      dispatch(ctx, tools, "create_content_entry", { collection: "posts", slug: "x" }),
    ).rejects.toMatchObject({ code: "MCP_CONTENT_STORE_UNAVAILABLE" });
  });
});

describe("mode gating", () => {
  // A migrated content store, so the only thing standing between a write and
  // success is the mode gate.
  async function contentDb(): Promise<KernelDatabase> {
    const db = adapt(raw);

    await new Migrator(db, [contentEntriesMigration]).migrate();

    return db;
  }

  it("read-only is the default — write tools refuse without an explicit mode", async () => {
    const ctx = context({ contentDb: await contentDb() });
    const tools = buildTools(ctx);

    const error = await dispatch(ctx, tools, "create_content_entry", {
      collection: "posts",
      slug: "x",
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(McpError);
    expect(error).toMatchObject({
      code: "MCP_OPERATOR_REQUIRED",
      details: { tool: "create_content_entry", mode: "read-only" },
    });
  });

  it("every destructive content tool refuses in read-only mode", async () => {
    const ctx = context({ contentDb: await contentDb(), mode: "read-only" });
    const tools = buildTools(ctx);

    for (const name of ["create_content_entry", "update_content_entry", "delete_content_entry"]) {
      await expect(
        dispatch(ctx, tools, name, { collection: "posts", slug: "x" }),
      ).rejects.toMatchObject({ code: "MCP_OPERATOR_REQUIRED" });
    }
  });

  it("handle_request refuses in read-only mode", async () => {
    const ctx = context({ mode: "read-only" });
    const tools = buildTools(ctx);

    await expect(
      dispatch(ctx, tools, "handle_request", { method: "GET", path: "/posts" }),
    ).rejects.toMatchObject({ code: "MCP_OPERATOR_REQUIRED", details: { tool: "handle_request" } });
  });
});

describe("audit sink", () => {
  it("records a successful dispatch with a hash, ok outcome, and duration", async () => {
    let clock = 1_000;
    const ctx = context();
    const tools = buildTools(ctx);

    // A fake clock advances 5ms between start and record, so the duration is
    // deterministic rather than a flaky wall-clock read.
    await dispatch(ctx, tools, "list_routes", {}, { now: () => (clock += 5) });

    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({ tool: "list_routes", outcome: "ok", durationMs: 5 });
    expect(audited[0]?.inputHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashes the input — equal inputs hash equal, different inputs differ", async () => {
    const ctx = context();
    const tools = buildTools(ctx);

    await dispatch(ctx, tools, "get_content_entry", { collection: "posts", slug: "a" });
    await dispatch(ctx, tools, "get_content_entry", { collection: "posts", slug: "a" });
    await dispatch(ctx, tools, "get_content_entry", { collection: "posts", slug: "b" });

    expect(audited[0]?.inputHash).toBe(audited[1]?.inputHash);
    expect(audited[0]?.inputHash).not.toBe(audited[2]?.inputHash);
  });

  it("audits an unserializable input rather than throwing on the hash", async () => {
    const ctx = context();
    const tools = buildTools(ctx);

    // A BigInt cannot be JSON-serialized; the hash falls back to a literal so the
    // dispatch is still audited.
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await dispatch(ctx, tools, "list_routes", circular);

    expect(audited).toHaveLength(1);
    expect(audited[0]?.inputHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("records an error outcome when a tool throws", async () => {
    const ctx = context({ mode: "read-only" });
    const tools = buildTools(ctx);

    await dispatch(ctx, tools, "handle_request", { method: "GET", path: "/x" }).catch(() => {});

    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({ tool: "handle_request", outcome: "error" });
  });

  it("audits even an unknown-tool refusal", async () => {
    const ctx = context();
    const tools = buildTools(ctx);

    await dispatch(ctx, tools, "nope", {}).catch(() => {});

    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({ tool: "nope", outcome: "error" });
  });

  it("awaits an async sink before resolving", async () => {
    const writes: string[] = [];

    const ctx = context({
      audit: async (record) => {
        await Promise.resolve();
        writes.push(record.tool);
      },
    });
    const tools = buildTools(ctx);

    await dispatch(ctx, tools, "list_routes", {});

    expect(writes).toEqual(["list_routes"]);
  });
});

describe("onSpan seam (ADR 0031 Phase 1)", () => {
  it("fires exactly once on a successful dispatch, with the SAME record the audit got", async () => {
    const spanned: McpAuditRecord[] = [];
    const ctx = context();
    const tools = buildTools(ctx);

    await dispatch(
      ctx,
      tools,
      "list_routes",
      {},
      { onSpan: (record) => void spanned.push(record) },
    );

    expect(spanned).toHaveLength(1);
    // The exact object the audit sink received — governance and observability read
    // one record, never two diverging copies.
    expect(spanned[0]).toBe(audited[0]);
    expect(spanned[0]).toMatchObject({ tool: "list_routes", outcome: "ok" });
  });

  it("fires with the error record when a tool throws", async () => {
    const spanned: McpAuditRecord[] = [];
    const ctx = context({ mode: "read-only" });
    const tools = buildTools(ctx);

    await dispatch(
      ctx,
      tools,
      "handle_request",
      { method: "GET", path: "/x" },
      { onSpan: (record) => void spanned.push(record) },
    ).catch(() => {});

    expect(spanned).toHaveLength(1);
    expect(spanned[0]).toBe(audited[0]);
    expect(spanned[0]).toMatchObject({ tool: "handle_request", outcome: "error" });
  });

  it("fires on an unknown-tool refusal too", async () => {
    const spanned: McpAuditRecord[] = [];
    const ctx = context();
    const tools = buildTools(ctx);

    await dispatch(ctx, tools, "nope", {}, { onSpan: (record) => void spanned.push(record) }).catch(
      () => {},
    );

    expect(spanned).toHaveLength(1);
    expect(spanned[0]).toBe(audited[0]);
    expect(spanned[0]).toMatchObject({ tool: "nope", outcome: "error" });
  });

  it("swallows a throw from onSpan on success — the result is unaffected", async () => {
    const ctx = context();
    const tools = buildTools(ctx);

    const result = await dispatch(
      ctx,
      tools,
      "list_routes",
      {},
      {
        onSpan: () => {
          throw new Error("span sink is broken");
        },
      },
    );

    // The dispatch resolved normally and the awaited audit still landed.
    expect(result).toEqual(routes);
    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({ tool: "list_routes", outcome: "ok" });
  });

  it("swallows a throw from onSpan on the error path — the original error still surfaces", async () => {
    const ctx = context();
    const tools = buildTools(ctx);

    // The unknown-tool refusal surfaces MCP_UNKNOWN_TOOL, never the span fault.
    await expect(
      dispatch(
        ctx,
        tools,
        "nope",
        {},
        {
          onSpan: () => {
            throw new Error("span sink is broken");
          },
        },
      ),
    ).rejects.toMatchObject({ code: "MCP_UNKNOWN_TOOL" });

    expect(audited).toHaveLength(1);
  });
});

describe("principal + actor in audit (ADR 0028 Phase 3a)", () => {
  describe("mcpPrincipalResolver", () => {
    it("resolves a session into a principal carrying actor + roles", async () => {
      const resolve = mcpPrincipalResolver({
        verifySession: () => ({ userId: "u-1" }),
        rolesOf: (actor) => (actor === "u-1" ? ["operator", "viewer"] : []),
      });

      expect(await resolve()).toEqual({ actor: "u-1", actorRoles: ["operator", "viewer"] });
    });

    it("resolves to undefined when there is no session, never consulting rolesOf", async () => {
      const resolve = mcpPrincipalResolver({
        verifySession: () => undefined,
        rolesOf: () => {
          throw new Error("rolesOf called for an unauthenticated caller");
        },
      });

      expect(await resolve()).toBeUndefined();
    });

    it("attributes an authenticated user with no roles (still denied downstream)", async () => {
      const resolve = mcpPrincipalResolver({
        verifySession: () => ({ userId: "u-2" }),
        rolesOf: () => [],
      });

      expect(await resolve()).toEqual({ actor: "u-2", actorRoles: [] });
    });
  });

  it("records the resolved actor on every dispatch", async () => {
    const ctx = context({
      resolvePrincipal: mcpPrincipalResolver({
        verifySession: () => ({ userId: "ada" }),
        rolesOf: () => ["operator"],
      }),
    });
    const tools = buildTools(ctx);

    await dispatch(ctx, tools, "list_routes", {});

    expect(audited[0]?.actor).toBe("ada");
  });

  it("records an undefined actor when the server has no resolver (unattributed)", async () => {
    const ctx = context(); // no resolvePrincipal wired
    const tools = buildTools(ctx);

    await dispatch(ctx, tools, "list_routes", {});

    expect(audited[0]).toMatchObject({ tool: "list_routes", actor: undefined });
  });

  it("records an undefined actor when the resolver finds no session", async () => {
    const ctx = context({ resolvePrincipal: () => undefined });
    const tools = buildTools(ctx);

    await dispatch(ctx, tools, "list_routes", {});

    expect(audited[0]?.actor).toBeUndefined();
  });

  it("attributes even an audited refusal (unknown tool) to the actor", async () => {
    const ctx = context({ resolvePrincipal: () => ({ actor: "ada", actorRoles: [] }) });
    const tools = buildTools(ctx);

    await dispatch(ctx, tools, "nope", {}).catch(() => {});

    expect(audited[0]).toMatchObject({ tool: "nope", outcome: "error", actor: "ada" });
  });

  it("takes NO @lesto/auth runtime dependency — the session seam is injected, not imported", () => {
    // ADR 0028 Phase 3a: @lesto/mcp resolves a principal from injected seams, never by
    // reaching into @lesto/auth itself. Assert no source file references it — in ANY
    // import form: static `from "@lesto/auth"`, a subpath `"@lesto/auth/x"`, a dynamic
    // `import("@lesto/auth")`, or `require(...)`. The type-only @lesto/authz (for the
    // `Principal` type) is distinct and allowed — a `z` (not `/` or a quote) follows
    // `auth`, so the pattern never matches it.
    const srcDir = fileURLToPath(new URL("../src", import.meta.url));

    for (const file of readdirSync(srcDir).filter((name) => name.endsWith(".ts"))) {
      const source = readFileSync(`${srcDir}/${file}`, "utf8");

      expect(source, `${file} must not reference @lesto/auth`).not.toMatch(
        /["']@lesto\/auth(\/[^"']*)?["']/,
      );
    }
  });
});

describe("handle_request handler", () => {
  it("dispatches to app.handle and returns the response", async () => {
    await queryDb.insert(posts).values({ title: "Hello, MCP" }).run();

    const ctx = context({ mode: "operator" });
    const tools = buildTools(ctx);

    const response = (await dispatch(ctx, tools, "handle_request", {
      method: "GET",
      path: "/posts",
    })) as { status: number; body: string };

    expect(response.status).toBe(200);

    const payload = JSON.parse(response.body) as { posts: { title: string }[] };

    expect(payload.posts[0]?.title).toBe("Hello, MCP");
  });

  it("forwards query, allowlisted headers, and body through to the app", async () => {
    // A stub App proves the handler threads method/path/query/headers/body.
    const calls: { method: string; path: string; options: unknown }[] = [];

    const stubApp: App = {
      migrationsApplied: [],
      handle: async (method, path, options) => {
        calls.push({ method, path, options });

        return { status: 201, headers: {}, body: "ok" };
      },
    };

    const ctx = context({ app: stubApp, mode: "operator" });
    const tools = buildTools(ctx);

    const response = (await dispatch(ctx, tools, "handle_request", {
      method: "POST",
      path: "/posts",
      query: { draft: "true" },
      headers: {
        // An allowlisted header (case-insensitive) survives...
        Cookie: "session=abc",
        Authorization: "Bearer t",
        // ...while a spoofable infra header is dropped.
        "X-Forwarded-For": "10.0.0.1",
      },
      body: { title: "x" },
    })) as { status: number };

    expect(response.status).toBe(201);

    expect(calls[0]).toEqual({
      method: "POST",
      path: "/posts",
      options: {
        query: { draft: "true" },
        headers: { cookie: "session=abc", authorization: "Bearer t" },
        body: { title: "x" },
      },
    });
  });

  it("carries an empty header map when none are given", async () => {
    const calls: { options: unknown }[] = [];

    const stubApp: App = {
      migrationsApplied: [],
      handle: async (_method, _path, options) => {
        calls.push({ options });

        return { status: 200, headers: {}, body: "" };
      },
    };

    const ctx = context({ app: stubApp, mode: "operator" });
    const tools = buildTools(ctx);

    await dispatch(ctx, tools, "handle_request", { method: "GET", path: "/posts" });

    expect(calls[0]?.options).toEqual({ headers: {}, body: undefined });
  });

  it("ignores a non-object headers input", async () => {
    const calls: { options: unknown }[] = [];

    const stubApp: App = {
      migrationsApplied: [],
      handle: async (_method, _path, options) => {
        calls.push({ options });

        return { status: 200, headers: {}, body: "" };
      },
    };

    const ctx = context({ app: stubApp, mode: "operator" });
    const tools = buildTools(ctx);

    // A string (or null) where an object is expected yields no headers, never a crash.
    await dispatch(ctx, tools, "handle_request", {
      method: "GET",
      path: "/posts",
      headers: "not-an-object",
    });
    await dispatch(ctx, tools, "handle_request", {
      method: "GET",
      path: "/posts",
      headers: null,
    });

    expect(calls[0]?.options).toEqual({ headers: {}, body: undefined });
    expect(calls[1]?.options).toEqual({ headers: {}, body: undefined });
  });

  it("drops a header whose value is not a string", async () => {
    const calls: { options: unknown }[] = [];

    const stubApp: App = {
      migrationsApplied: [],
      handle: async (_method, _path, options) => {
        calls.push({ options });

        return { status: 200, headers: {}, body: "" };
      },
    };

    const ctx = context({ app: stubApp, mode: "operator" });
    const tools = buildTools(ctx);

    await dispatch(ctx, tools, "handle_request", {
      method: "GET",
      path: "/posts",
      headers: { cookie: 42 },
    });

    expect(calls[0]?.options).toEqual({ headers: {}, body: undefined });
  });
});

describe("generate_ui handler", () => {
  it("returns the injected generateUi output", async () => {
    const ctx = context({ generateUi: (prompt) => Promise.resolve({ rendered: prompt }) });

    const tools = buildTools(ctx);

    const result = await dispatch(ctx, tools, "generate_ui", { prompt: "a login form" });

    expect(result).toEqual({ rendered: "a login form" });
  });

  it("throws MCP_GENERATE_UNAVAILABLE when generateUi is not configured", async () => {
    const ctx = context();
    const tools = buildTools(ctx);

    await expect(dispatch(ctx, tools, "generate_ui", { prompt: "x" })).rejects.toMatchObject({
      code: "MCP_GENERATE_UNAVAILABLE",
    });

    const error = await dispatch(ctx, tools, "generate_ui", { prompt: "x" }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(McpError);
  });
});

describe("dispatch", () => {
  it("runs a found tool's handler", async () => {
    const ctx = context();
    const tools = buildTools(ctx);

    const result = await dispatch(ctx, tools, "list_routes", {});

    expect(result).toEqual(routes);
  });

  it("throws MCP_UNKNOWN_TOOL for an unknown name", async () => {
    const ctx = context();
    const tools = buildTools(ctx);

    await expect(dispatch(ctx, tools, "nope", {})).rejects.toMatchObject({
      code: "MCP_UNKNOWN_TOOL",
      details: { name: "nope" },
    });

    const error = await dispatch(ctx, tools, "nope", {}).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(McpError);
  });
});

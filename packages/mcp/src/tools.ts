/**
 * The Keel MCP tool set — the operations the control plane exposes to agents.
 *
 * Each tool is a plain, pure description: a name, a human-readable purpose, a
 * JSON Schema for its input, and an async `handler`. The handlers are the whole
 * of the business logic and are tested directly; the stdio transport that wires
 * them to a real MCP client is a thin, separate adapter (see `server.ts`).
 */

import type { App } from "@keel/kernel";
import type { Router } from "@keel/router";
import type { SqlDatabase } from "@keel/migrate";

import { getCollections, getEntry, query } from "@keel/content-core";
import { createEntry, deleteEntry, hydrateRuntime, updateEntry } from "@keel/content-store";
import type { WriteEntryInput } from "@keel/content-store";

import { McpError } from "./errors";

/** Everything a tool handler needs: the running app, its routes, and optional UI generation. */
export interface KeelMcpContext {
  app: App;

  router: Router;

  /** Injected by the caller (wired to `@keel/ui-generate`); absent disables `generate_ui`. */
  generateUi?: (prompt: string) => Promise<unknown>;

  /**
   * The content-store database. Read tools work off the hydrated runtime and
   * need nothing here; the write tools mutate this database, so absent it they
   * are present but inert (they raise `MCP_CONTENT_STORE_UNAVAILABLE`).
   */
  contentDb?: SqlDatabase;
}

/** One MCP tool: its identity, its input contract, and the handler that runs it. */
export interface KeelTool {
  name: string;

  description: string;

  inputSchema: object;

  handler: (input: Record<string, unknown>) => Promise<unknown>;
}

/** The content-store database, or a clear refusal when none was wired in. */
function requireContentDb(context: KeelMcpContext): SqlDatabase {
  if (context.contentDb === undefined) {
    throw new McpError(
      "MCP_CONTENT_STORE_UNAVAILABLE",
      "The content store is not configured for this server.",
    );
  }

  return context.contentDb;
}

/** Narrow a tool's loose input into the store's authoring shape. */
function toWriteInput(input: Record<string, unknown>): WriteEntryInput {
  return {
    collection: String(input.collection),
    slug: String(input.slug),
    // `exactOptionalPropertyTypes`: carry each field only when it was given.
    ...(input.data === undefined ? {} : { data: input.data as Record<string, unknown> }),
    ...(input.content === undefined ? {} : { content: String(input.content) }),
  };
}

/** The JSON Schema shared by the create and update tools. */
const WRITE_ENTRY_SCHEMA = {
  type: "object",
  properties: {
    collection: { type: "string" },
    slug: { type: "string" },
    data: { type: "object" },
    content: { type: "string" },
  },
  required: ["collection", "slug"],
};

/**
 * Build the Keel tool set bound to a context.
 *
 * The handlers close over `context`, so the same tool definitions drive any app
 * the caller assembles. Order is stable: routes and request, then the content
 * read tools, then the content write tools.
 */
export function buildTools(context: KeelMcpContext): KeelTool[] {
  const listRoutes: KeelTool = {
    name: "list_routes",
    description: "List every route the running Keel app answers, in resolution order.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    handler: async () => context.router.list(),
  };

  const handleRequest: KeelTool = {
    name: "handle_request",
    description: "Drive the running Keel app: dispatch a request and return its response.",
    inputSchema: {
      type: "object",
      properties: {
        method: { type: "string" },
        path: { type: "string" },
        query: { type: "object" },
        body: {},
      },
      required: ["method", "path"],
    },
    handler: async (input) => {
      const method = String(input.method);
      const path = String(input.path);

      const queryParams = input.query as Record<string, string> | undefined;

      // `exactOptionalPropertyTypes`: only carry `query` when it was actually given.
      const options =
        queryParams === undefined ? { body: input.body } : { query: queryParams, body: input.body };

      return context.app.handle(method, path, options);
    },
  };

  const generateUi: KeelTool = {
    name: "generate_ui",
    description: "Generate a Keel UI from a natural-language prompt.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
      },
      required: ["prompt"],
    },
    handler: async (input) => {
      // UI generation is injected; without it the tool is present but inert.
      if (context.generateUi === undefined) {
        throw new McpError("MCP_GENERATE_UNAVAILABLE", "UI generation is not configured.");
      }

      return context.generateUi(String(input.prompt));
    },
  };

  const listContentCollections: KeelTool = {
    name: "list_content_collections",
    description: "List the content collections in the runtime, each with its entry count.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    handler: async () =>
      getCollections().map((collection) => ({
        name: collection.name,
        count: collection.entries.length,
      })),
  };

  const getContentEntry: KeelTool = {
    name: "get_content_entry",
    description: "Read a single content entry by collection and slug; null when absent.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string" },
        slug: { type: "string" },
      },
      required: ["collection", "slug"],
    },
    handler: async (input) => getEntry(String(input.collection), String(input.slug)) ?? null,
  };

  const queryContent: KeelTool = {
    name: "query_content",
    description: "List a collection's entries, optionally capped by a limit.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string" },
        limit: { type: "number" },
      },
      required: ["collection"],
    },
    handler: async (input) => {
      const entries = query(String(input.collection));

      // Only narrow when a numeric limit was actually given.
      return typeof input.limit === "number" ? entries.limit(input.limit).get() : entries.get();
    },
  };

  const createContentEntry: KeelTool = {
    name: "create_content_entry",
    description: "Create a new content entry in the store; errors if one already exists.",
    inputSchema: WRITE_ENTRY_SCHEMA,
    handler: async (input) => {
      const db = requireContentDb(context);

      const { entry } = await createEntry(db, toWriteInput(input));

      // The write changed the database; refresh the runtime so reads see it.
      await hydrateRuntime(db);

      return entry;
    },
  };

  const updateContentEntry: KeelTool = {
    name: "update_content_entry",
    description: "Update an existing content entry, merging data and replacing the body.",
    inputSchema: WRITE_ENTRY_SCHEMA,
    handler: async (input) => {
      const db = requireContentDb(context);

      const { entry } = await updateEntry(db, toWriteInput(input));

      await hydrateRuntime(db);

      return entry;
    },
  };

  const deleteContentEntry: KeelTool = {
    name: "delete_content_entry",
    description: "Delete a content entry by collection and slug; reports how many rows went.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string" },
        slug: { type: "string" },
      },
      required: ["collection", "slug"],
    },
    handler: async (input) => {
      const db = requireContentDb(context);

      const result = await deleteEntry(db, String(input.collection), String(input.slug));

      await hydrateRuntime(db);

      return result;
    },
  };

  return [
    listRoutes,
    handleRequest,
    generateUi,
    listContentCollections,
    getContentEntry,
    queryContent,
    createContentEntry,
    updateContentEntry,
    deleteContentEntry,
  ];
}

/**
 * Find a tool by name and run it.
 *
 * Throws `MCP_UNKNOWN_TOOL` when no tool carries the name, so a caller's typo or
 * a stale client never silently no-ops.
 */
export async function dispatch(
  tools: KeelTool[],
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const tool = tools.find((candidate) => candidate.name === name);

  if (tool === undefined) {
    throw new McpError("MCP_UNKNOWN_TOOL", `No MCP tool is named "${name}".`, { name });
  }

  return tool.handler(input);
}

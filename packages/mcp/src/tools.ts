/**
 * The Keel MCP tool set — the operations the control plane exposes to agents.
 *
 * Each tool is a plain, pure description: a name, a human-readable purpose, a
 * JSON Schema for its input, and an async `handler`. The handlers are the whole
 * of the business logic and are tested directly; the stdio transport that wires
 * them to a real MCP client is a thin, separate adapter (see `server.ts`).
 */

import { createHash } from "node:crypto";

import type { App } from "@keel/kernel";
import type { SqlDatabase } from "@keel/migrate";

import { getCollections, getEntry, query, setData } from "@keel/content-core";
import type { RuntimeEntry } from "@keel/content-core";
import { createEntry, deleteEntry, loadEntries, updateEntry } from "@keel/content-store";
import type { WriteEntryInput } from "@keel/content-store";

import { McpError } from "./errors";

/**
 * How much the control plane lets an agent *do*.
 *
 * `read-only` is the default and the floor: routes and content can be inspected,
 * but nothing mutates and no request is driven through the live app. `operator`
 * is the deliberate, named escalation that unlocks the destructive tools (the
 * content writes and `handle_request`). Gating on a value the caller must opt
 * into — rather than on the absence of a flag — means a misconfiguration fails
 * closed: forget to set the mode and the agent gets the safe surface.
 */
export type McpMode = "read-only" | "operator";

/** A single line in the audit log: what an agent invoked, and how it went. */
export interface McpAuditRecord {
  /** The tool name as dispatched. */
  tool: string;

  /**
   * A SHA-256 hex digest of the canonicalized input — enough to prove two
   * invocations carried the same arguments without writing the (possibly
   * sensitive) arguments themselves into the audit trail.
   */
  inputHash: string;

  /** Whether the handler returned (`ok`) or threw (`error`). */
  outcome: "ok" | "error";

  /** Wall-clock duration of the dispatch, in milliseconds. */
  durationMs: number;
}

/** Where every dispatch is recorded. Sync or async; a rejection is left to the caller. */
export type McpAuditSink = (record: McpAuditRecord) => void | Promise<void>;

/** Everything a tool handler needs: the running app, its routes, and optional UI generation. */
export interface KeelMcpContext {
  app: App;

  /** The app's routes (verb + pattern), as `keel().routes()` yields — surfaced by `list_routes`. */
  routes: readonly { method: string; pattern: string }[];

  /**
   * How much this server lets an agent do (see {@link McpMode}). Absent defaults
   * to `read-only` — the safe floor, so an unconfigured server can never mutate.
   * The destructive tools refuse with `MCP_OPERATOR_REQUIRED` unless this is
   * explicitly `operator`.
   */
  mode?: McpMode;

  /**
   * The mandatory audit sink: every `dispatch` records one {@link McpAuditRecord}
   * here, for both successes and failures, before the result or error surfaces.
   * This is the governance the control plane was built around — there is no
   * un-audited path to a tool, so an operator can always see what an agent ran.
   */
  audit: McpAuditSink;

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

  /**
   * True iff this tool mutates state or drives the live app — the content writes
   * and `handle_request`. A destructive tool refuses outside `operator` mode, and
   * the flag is surfaced so a client can warn before invoking. Read tools are
   * non-destructive and run in either mode.
   */
  destructive: boolean;

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

/** The server's mode, defaulting to the safe `read-only` floor when unset. */
function modeOf(context: KeelMcpContext): McpMode {
  return context.mode ?? "read-only";
}

/**
 * An incremental view over content-core's runtime store, scoped to one tool set.
 *
 * Every content write must refresh the runtime so the read tools see it. The
 * naive refresh is `hydrateRuntime(db)`, which reloads EVERY collection from the
 * database on each write — so an agent that authors N entries pays
 * O(N · total-entries): a full re-read per write, the cost climbing with the
 * whole store. Over a session that authors a collection that is O(N²).
 *
 * This collapses it to O(N · changed-collection): the first write seeds an
 * authoritative collections map with one full load; thereafter each write reloads
 * ONLY the collection it touched (`loadEntries(db, collection)`) and patches that
 * key, leaving every other collection's already-loaded entries untouched. The
 * full map is handed to `setData` each time, so content-core's reads stay
 * consistent — but the database read is bounded by the changed collection, not
 * the store.
 *
 * The seed is lazy and memoized (the first write loads everything once; later
 * writes never reload an untouched collection), and the map is owned by this
 * closure — one per `buildTools`, so two servers never share a stale view.
 */
interface ContentRuntime {
  /**
   * Refresh the runtime after a write to `collection`: reload just that
   * collection from the database, patch it into the map, and republish.
   */
  refresh(db: SqlDatabase, collection: string): Promise<void>;
}

function createContentRuntime(): ContentRuntime {
  // The authoritative collections map, seeded once on the first write. `undefined`
  // until then — so a tool set that never writes pays nothing.
  let collections: Record<string, RuntimeEntry[]> | undefined;

  return {
    refresh: async (db, collection) => {
      // Seed once with a single full load; every later write reuses this map and
      // only re-reads the collection it changed.
      collections ??= await loadEntries(db);

      // Reload ONLY the written collection. `loadEntries(db, name)` keys by
      // collection; a now-empty collection (its last entry deleted) yields no key,
      // so we clear it rather than leave a stale array behind.
      const reloaded = await loadEntries(db, collection);

      collections[collection] = reloaded[collection] ?? [];

      // Republish the patched full map; content-core's `setData` is a full
      // replace, but the database read above touched only one collection.
      setData(collections);
    },
  };
}

/**
 * Refuse a destructive tool outside operator mode.
 *
 * The named tool is the one the caller is about to run; surfacing it (and the
 * effective mode) in the coded error's details lets an agent report *exactly*
 * which capability it lacks. Read-only is the default, so a server that never
 * sets `mode` can never reach a write.
 */
function requireOperator(context: KeelMcpContext, tool: string): void {
  if (modeOf(context) === "operator") return;

  throw new McpError(
    "MCP_OPERATOR_REQUIRED",
    `The "${tool}" tool needs operator mode; this server is read-only.`,
    { tool, mode: modeOf(context) },
  );
}

/**
 * The request headers an agent may set on `handle_request`, lower-cased.
 *
 * `handle_request` is how an agent drives the live app, and an agent needs to
 * carry identity (a session cookie, a bearer token) for the request to act *as*
 * someone — otherwise the MCP surface is middleware-hostile, every request
 * anonymous. But a tool that forwarded arbitrary headers would let an agent
 * spoof infrastructure headers the runtime trusts (`x-forwarded-for`,
 * `x-request-id`). So the input is an explicit allowlist: only these pass
 * through; anything else is dropped silently rather than smuggled to the app.
 */
const ALLOWED_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "cookie",
  "content-type",
  "accept",
  "accept-language",
]);

/**
 * Narrow a loose `headers` input down to the allowlist.
 *
 * Header names are matched case-insensitively (HTTP headers are), and only
 * string values survive — a non-string value is not a header. The result is keyed
 * by the lower-cased canonical name, so the app sees a predictable shape.
 */
function allowedHeaders(input: unknown): Record<string, string> {
  if (typeof input !== "object" || input === null) return {};

  const headers: Record<string, string> = {};

  for (const [name, value] of Object.entries(input as Record<string, unknown>)) {
    const canonical = name.toLowerCase();

    if (ALLOWED_REQUEST_HEADERS.has(canonical) && typeof value === "string") {
      headers[canonical] = value;
    }
  }

  return headers;
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
  // One incremental runtime view per tool set: the content writes refresh through
  // it so each write re-reads only the collection it changed, never the whole
  // store (see {@link createContentRuntime}).
  const runtime = createContentRuntime();

  const listRoutes: KeelTool = {
    name: "list_routes",
    description: "List every route the running Keel app answers, in resolution order.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    destructive: false,
    handler: async () => context.routes,
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
        // The allowlisted identity headers an agent may carry (cookie, bearer
        // token); only the names in ALLOWED_REQUEST_HEADERS pass through.
        headers: { type: "object" },
        body: {},
      },
      required: ["method", "path"],
    },
    // Driving the live app can mutate state (a POST, a DELETE), so the tool is
    // destructive and gated to operator mode.
    destructive: true,
    handler: async (input) => {
      // Driving the live app is an operator-only capability: a read-only server
      // exposes routes for inspection but never dispatches a request through them.
      requireOperator(context, "handle_request");

      const method = String(input.method);
      const path = String(input.path);

      const queryParams = input.query as Record<string, string> | undefined;

      // Identity travels on the allowlisted headers, so an agent's request can
      // act *as* a user instead of always anonymous; anything off the allowlist
      // is dropped rather than forwarded.
      const headers = allowedHeaders(input.headers);

      // `exactOptionalPropertyTypes`: only carry `query` when it was actually given.
      const options =
        queryParams === undefined
          ? { headers, body: input.body }
          : { query: queryParams, headers, body: input.body };

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
    destructive: false,
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
    destructive: false,
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
    destructive: false,
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
    destructive: false,
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
    destructive: true,
    handler: async (input) => {
      requireOperator(context, "create_content_entry");

      const db = requireContentDb(context);

      const write = toWriteInput(input);

      const { entry } = await createEntry(db, write);

      // The write changed one collection; refresh just that collection so reads
      // see it, without re-reading the rest of the store.
      await runtime.refresh(db, write.collection);

      return entry;
    },
  };

  const updateContentEntry: KeelTool = {
    name: "update_content_entry",
    description: "Update an existing content entry, merging data and replacing the body.",
    inputSchema: WRITE_ENTRY_SCHEMA,
    destructive: true,
    handler: async (input) => {
      requireOperator(context, "update_content_entry");

      const db = requireContentDb(context);

      const write = toWriteInput(input);

      const { entry } = await updateEntry(db, write);

      await runtime.refresh(db, write.collection);

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
    destructive: true,
    handler: async (input) => {
      requireOperator(context, "delete_content_entry");

      const db = requireContentDb(context);

      const collection = String(input.collection);

      const result = await deleteEntry(db, collection, String(input.slug));

      await runtime.refresh(db, collection);

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
 * A SHA-256 hex digest of a tool's input.
 *
 * The audit trail records *that* an invocation happened and with which
 * arguments, without writing the arguments themselves — which may carry a
 * session cookie or a content body. `JSON.stringify` is the canonical form; an
 * input that does not serialize (a circular structure, a `BigInt`) hashes the
 * literal string `"[unserializable]"` rather than throwing, so a malformed call
 * is still audited before it is refused.
 */
function hashInput(input: Record<string, unknown>): string {
  let canonical: string;

  try {
    canonical = JSON.stringify(input);
  } catch {
    canonical = "[unserializable]";
  }

  return createHash("sha256").update(canonical).digest("hex");
}

/** Injectable seams for `dispatch` — defaulted so the common call stays terse. */
export interface DispatchOptions {
  /**
   * The clock the audited `durationMs` is measured against. Defaults to
   * `Date.now`; a test injects a fake so the recorded duration is deterministic.
   */
  now?: () => number;
}

/**
 * Find a tool by name, audit the call, and run it.
 *
 * Every dispatch — success or failure, known tool or not — lands one
 * {@link McpAuditRecord} in `context.audit` before the result or error
 * surfaces. There is no un-audited path to a tool: that is the governance the
 * control plane exists to provide. The record carries the tool name, a hash of
 * the input (never the input itself), the outcome, and the wall-clock duration.
 *
 * Throws `MCP_UNKNOWN_TOOL` when no tool carries the name, so a caller's typo or
 * a stale client never silently no-ops — and that refusal is audited too.
 */
export async function dispatch(
  context: KeelMcpContext,
  tools: KeelTool[],
  name: string,
  input: Record<string, unknown>,
  options: DispatchOptions = {},
): Promise<unknown> {
  const now = options.now ?? Date.now;

  const startedAt = now();
  const inputHash = hashInput(input);

  // Record one line for this invocation, with the duration measured to the
  // moment of recording. Awaited so an async sink (a DB write, a log flush)
  // completes before the dispatch resolves — the audit is part of the contract,
  // not fire-and-forget.
  const audit = (outcome: "ok" | "error"): Promise<void> =>
    Promise.resolve(
      context.audit({ tool: name, inputHash, outcome, durationMs: now() - startedAt }),
    );

  const tool = tools.find((candidate) => candidate.name === name);

  if (tool === undefined) {
    await audit("error");

    throw new McpError("MCP_UNKNOWN_TOOL", `No MCP tool is named "${name}".`, { name });
  }

  try {
    const result = await tool.handler(input);

    await audit("ok");

    return result;
  } catch (error) {
    await audit("error");

    throw error;
  }
}

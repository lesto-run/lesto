/**
 * The Lesto MCP tool set — the operations the control plane exposes to agents.
 *
 * Each tool is a plain, pure description: a name, a human-readable purpose, a
 * JSON Schema for its input, and an async `handler`. The handlers are the whole
 * of the business logic and are tested directly; the stdio transport that wires
 * them to a real MCP client is a thin, separate adapter (see `server.ts`).
 */

import { createHash } from "node:crypto";

import { z } from "zod";

import type { App } from "@lesto/kernel";
import type { SqlDatabase } from "@lesto/migrate";
import type { Policy, Principal } from "@lesto/authz";
import type { OpenApiInfo } from "@lesto/openapi";

import { missingContentError } from "./content-peer";
import { McpError } from "./errors";
import { describeApp } from "./resources";

/** A value delivered now or awaited — the established local convention. */
type MaybePromise<T> = T | Promise<T>;

/**
 * The app's DECLARED schema shape (ADR 0034 Part A) — what the contract surfaces
 * as the `lesto://schema` resource and `describe_app`'s `schema` key. This is the
 * cheaply-available declared shape, NOT live database reflection.
 *
 * Today the only producer (`lesto mcp`) populates `migrations` (the known migration
 * versions) and leaves `tables` empty: `LestoAppConfig` exposes no `defineTable`
 * registry, so per-table column names/types are not yet cheaply available. The
 * `tables` shape is the forward contract — it fills in once a declared-table source
 * exists. Absent → an empty-but-valid shape.
 */
export interface AppSchemaShape {
  /** The known migration versions, in declared order. */
  migrations: readonly string[];

  /**
   * Each declared table's name and the declared name/type of its columns. The
   * forward shape — empty today (no table registry on the app config yet).
   */
  tables: readonly {
    name: string;
    columns: readonly { name: string; type: string }[];
  }[];
}

/**
 * The live-dev-state reader the dev introspection tools read (ADR 0032 Phase 1).
 *
 * Declared STRUCTURALLY here, so `@lesto/mcp` imports neither `@lesto/cli` (which
 * owns the ring, `dev-state.ts`) nor `@lesto/runtime` (which owns the access entry)
 * — the bin injects the ring on the dev `LestoMcpContext` and `@lesto/cli`'s
 * `DevState` satisfies this shape structurally. The return values are opaque
 * (`unknown`): the tools serialize them straight to the agent, never inspect them.
 */
export interface McpDevStateReader {
  /** The current build/reload error, or `undefined`/`null` when the last change succeeded. */
  getDiagnostics(): unknown;

  /** The most recent served requests, capped at `n`. */
  recentRequests(n: number): readonly unknown[];

  /** The most recent dev log lines, capped at `n`. */
  recentLogs(n: number): readonly string[];
}

/** The runtime's collections map (collection name → its entries) — entries are opaque here. */
type ContentCollections = Record<string, unknown[]>;

/** The authoring shape the content writes take — built from a write tool's loose input. */
interface ContentWriteInput {
  collection: string;

  slug: string;

  data?: Record<string, unknown>;

  content?: string;
}

/**
 * The optional-peer content surface the content tools run against, INJECTED via the
 * context. `@lesto/mcp` depends on `@lesto/content-core` / `@lesto/content-store` only
 * as OPTIONAL PEERS — so it installs (and its generic tools run) without them — and
 * references them at NEITHER runtime nor the type level: this structural shape is all
 * the content tools need, and the real dynamic import lives in the coverage-excluded
 * `server.ts` (tests inject a fake). Content entries are opaque pass-through values the
 * tools only JSON-serialize, so `unknown`. Method syntax (not property arrows) keeps the
 * members bivariant, so the concrete content modules assign to this looser shape.
 */
export interface ContentModules {
  core: {
    getCollections(): { name: string; entries: readonly unknown[] }[];

    getEntry(collection: string, slug: string): unknown;

    query(collection: string): { limit(n: number): { get(): unknown }; get(): unknown };

    setData(collections: ContentCollections): void;
  };

  store: {
    loadEntries(db: SqlDatabase, collection?: string): Promise<ContentCollections>;

    createEntry(db: SqlDatabase, input: ContentWriteInput): Promise<{ entry: unknown }>;

    updateEntry(db: SqlDatabase, input: ContentWriteInput): Promise<{ entry: unknown }>;

    deleteEntry(db: SqlDatabase, collection: string, slug: string): Promise<unknown>;
  };
}

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

  /**
   * The resolved principal's `actor` (ADR 0028 Phase 3a) — WHO drove this dispatch,
   * as {@link LestoMcpContext.resolvePrincipal} named them. `undefined` on an
   * unauthenticated server (no resolver, or no session): the dispatch is still
   * audited, just unattributed — and a governed write would be refused.
   */
  actor: string | undefined;
}

/** Where every dispatch is recorded. Sync or async; a rejection is left to the caller. */
export type McpAuditSink = (record: McpAuditRecord) => void | Promise<void>;

/** Everything a tool handler needs: the running app, its routes, and optional UI generation. */
export interface LestoMcpContext {
  app: App;

  /** The app's routes (verb + pattern), as `lesto().routes()` yields — surfaced by `list_routes`. */
  routes: readonly { method: string; pattern: string }[];

  /**
   * The OpenAPI `info` block for the contract resources + `describe_app` (ADR 0034
   * Part A). Absent → a default `{ title: "Lesto API", version: "0.0.0" }`. The app
   * supplies its real title/version through `lesto mcp` (`cli/src/mcp.ts`).
   */
  openApiInfo?: OpenApiInfo;

  /**
   * The app's DECLARED schema shape (ADR 0034 Part A) — see {@link AppSchemaShape}.
   * Surfaced by the `lesto://schema` resource and `describe_app`. Absent → an
   * empty-but-valid shape (never invented reflection).
   */
  schema?: AppSchemaShape;

  /**
   * The live-dev-state reader (ADR 0032 Phase 1) the dev introspection tools read.
   * Injected ONLY by `lesto dev` (the bin wires the ring). Its PRESENCE is what builds
   * the three dev tools (`get_dev_diagnostics`, `get_recent_requests`, `tail_logs`):
   * absent — on every non-dev server, including the remote OAuth transport — the tools
   * are never built, so they cannot be advertised, listed, or reached. The dev surface
   * is gated at BUILD time, not refused at call time, so a DevError stack (absolute fs
   * paths), an access-log path, or a dev log line can never leak off `lesto dev`. See
   * {@link McpDevStateReader}.
   */
  devState?: McpDevStateReader;

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

  /**
   * Resolve who is driving this connection — the principal (ADR 0028 Phase 3a).
   * Injected, so `@lesto/mcp` takes no `@lesto/auth` dependency. Absent (or resolving
   * `undefined`) → unauthenticated: no `actor` is recorded, the principal's roles are
   * empty, and a governed write is denied by default. Called once per `dispatch`, so
   * the stdio server's connection-constant identity and the remote transport's
   * per-request bearer-token principal (Phase 3b) both fit the same seam (a
   * connection-constant resolver may memoize). Build one from a session + roles seam
   * with {@link mcpPrincipalResolver}.
   */
  resolvePrincipal?: () => MaybePromise<Principal | undefined>;

  /** Injected by the caller (wired to `@lesto/ui-generate`); absent disables `generate_ui`. */
  generateUi?: (prompt: string) => Promise<unknown>;

  /**
   * Load the optional-peer content implementation the content tools run against.
   * The real {@link startMcpServer} injects a dynamic import of `@lesto/content-core`
   * + `@lesto/content-store` (`server.ts`); a test injects a fake. ABSENT → the six
   * content tools refuse with `MCP_CONTENT_PACKAGES_MISSING`; the generic tools
   * (`list_routes`, `handle_request`, `generate_ui`) are unaffected.
   */
  loadContent?: () => Promise<ContentModules>;

  /**
   * The content-store database. Read tools work off the hydrated runtime and
   * need nothing here; the write tools mutate this database, so absent it they
   * are present but inert (they raise `MCP_CONTENT_STORE_UNAVAILABLE`).
   */
  contentDb?: SqlDatabase;

  /**
   * The app's DECLARED domain tools (ADR 0043) — the real actions the app exposes as
   * first-class, named, typed MCP tools, each carrying its OWN per-tool policy floor. Appended
   * to the framework set (after it, before the conditional dev tools) by {@link buildTools},
   * so `handle_request` becomes one governed option among many rather than the sole conduit
   * through which every app write squeezes and loses its identity. Each declaration is validated
   * at registration ({@link LestoDomainTool}): a destructive tool with no floor refuses, a name
   * collision refuses, a governed tool with no {@link policy} refuses, and a destructive tool
   * with no principal resolver is ABSENT (fail-closed, never present-and-open).
   */
  domainTools?: readonly LestoDomainTool[];

  /**
   * The compiled authorization {@link Policy} the dispatch-level domain-tool floor adjudicates
   * against (ADR 0043 D1). The floor checks `policy.allows(principal.actorRoles, requires.permission)`
   * inside {@link dispatch}, so a governed domain tool needs a policy here to be enforceable — a
   * governed tool declared on a context with NO policy refuses to register (D2.4). The
   * framework tools' back-compatible "no policy → floor off" rule does NOT extend to domain tools.
   * On the HTTP path this is the same compiled policy the deployment hands `createMcpHttpHandlers`.
   */
  policy?: Policy<string, string>;

  /**
   * Framework tools to DROP from {@link buildTools}'s output (ADR 0043 D4) — e.g.
   * `["handle_request"]`. Once an app's MCP surface is fully covered by {@link domainTools},
   * keeping the generic `handle_request` driver around is gratuitous privilege (it can reach any
   * route under the one `handle_request` permission, re-collapsing the per-action floor the domain
   * tools just bought). A production Resource Server whose surface is enumerated as domain tools
   * omits it — the least-privilege posture. An omitted framework tool's name is still RESERVED, so
   * a domain tool may not re-claim it (D2.3) and a later un-omit can never silently re-point a name.
   */
  omitTools?: readonly string[];
}

/** The session + roles seams an {@link mcpPrincipalResolver} composes into a principal. */
export interface McpPrincipalResolverOptions {
  /**
   * Verify the calling session, returning its `userId` or `undefined` when there is
   * none. Injected so `@lesto/mcp` takes NO `@lesto/auth` dependency: the stdio server
   * resolves its launch identity, the remote transport (Phase 3b) wraps a validated
   * bearer token's subject.
   */
  verifySession: () => MaybePromise<{ userId: string } | undefined>;

  /**
   * Resolve an authenticated user's roles — the `userId -> roles` seam (e.g.
   * `@lesto/identity`'s `rolesOf`). An authenticated user with no roles is still
   * attributed, but denied: empty roles satisfy no permission.
   */
  rolesOf: (actor: string) => MaybePromise<Iterable<string>>;
}

/**
 * Build the MCP principal resolver (ADR 0028 Phase 3a): caller → `actor` (via
 * `verifySession`) → roles (via `rolesOf`) → {@link Principal} — what
 * {@link LestoMcpContext.resolvePrincipal} expects. MCP has no web `Context`, so this
 * composes the two injected seams directly rather than reusing the web middleware.
 * An unauthenticated caller (no session) resolves to `undefined`: no actor to record,
 * and downstream gating denies by default.
 */
export function mcpPrincipalResolver(
  options: McpPrincipalResolverOptions,
): () => Promise<Principal | undefined> {
  const { verifySession, rolesOf } = options;

  return async () => {
    const session = await verifySession();

    if (session === undefined) return undefined;

    const actor = session.userId;
    const actorRoles = [...(await rolesOf(actor))];

    return { actor, actorRoles };
  };
}

/** One MCP tool: its identity, its input contract, and the handler that runs it. */
export interface LestoTool {
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

  /**
   * The policy permission this tool's DISPATCH-level floor requires (ADR 0043 D3), set only for a
   * governed {@link LestoDomainTool}. Present → {@link dispatch} checks
   * `context.policy.allows(principal.actorRoles, requiresPermission)` before running the handler
   * and refuses `MCP_FORBIDDEN` on denial — the belt-and-suspenders floor that also covers stdio
   * (which has no HTTP pre-dispatch floor). Absent → no dispatch floor (framework tools; ungoverned
   * domain tools), governed by the scope ceiling / operator gate alone.
   */
  requiresPermission?: string;

  /**
   * Run the tool. The resolved {@link Principal} (ADR 0028 Phase 3a) is passed as the second
   * argument — the SINGLE principal {@link dispatch} resolved (ADR 0043 amendment (b)), so a
   * governed domain tool's floor check and its handler reason about the SAME subject (never a
   * second `resolvePrincipal()` that a non-memoized stdio resolver could answer differently).
   * Framework tools ignore it; the domain-tool adapter threads it to the declared handler.
   */
  handler: (input: Record<string, unknown>, principal?: Principal) => Promise<unknown>;
}

/**
 * An app-declared domain tool (ADR 0043): a real app action as a first-class, named, typed MCP
 * tool that OWNS its per-tool policy floor. The abstraction is minimal — a {@link LestoTool} plus a
 * `requires` clause — and {@link buildTools} adapts it: it derives the `tools/list` JSON Schema from
 * the Zod `input`, parses the input at dispatch (ADR 0005 — a coded `MCP_INVALID_TOOL_INPUT`
 * refusal, never a crash), gates a destructive tool on operator mode, and threads the resolved
 * principal to the handler.
 */
export interface LestoDomainTool<I = unknown> {
  /** The agent-legible action name (ADR 0035) — the consent/capability unit a client displays. */
  name: string;

  /** Shown in `tools/list`. */
  description: string;

  /**
   * The input contract as a Zod schema (ADR 0005): the JSON Schema advertised in `tools/list` is
   * DERIVED from it, and the input is PARSED against it at dispatch — the same validated boundary
   * an HTTP body crosses. A parse failure is a coded `MCP_INVALID_TOOL_INPUT`, not a raw throw.
   */
  input: z.ZodType<I>;

  /**
   * True iff the tool mutates state. Surfaced on the built {@link LestoTool}; gates operator mode
   * (a destructive tool refuses in `read-only`, like `handle_request`) and drives the
   * default-scope + must-be-governed rules below.
   */
  destructive: boolean;

  /**
   * The per-tool policy floor this tool OWNS. A governed tool needs a {@link LestoMcpContext.policy}
   * to adjudicate it (D2.4). Absent on a NON-destructive tool → no floor (scope ceiling governs it,
   * like an unmapped framework tool); absent on a DESTRUCTIVE tool → refuses to register unless
   * {@link ungoverned} is set (D2.1).
   */
  requires?: {
    /**
     * The OAuth scope this tool needs — the per-tool ceiling. For a DESTRUCTIVE tool it defaults to
     * the deployment write scope (mirroring the OCP-7 rule that a mapped tool's scope IS the write
     * scope). A NON-destructive governed tool MUST set it explicitly (`MCP_DOMAIN_TOOL_SCOPE_REQUIRED`
     * otherwise) — defaulting a read to the write scope would wrongly demand write.
     */
    scope?: string;

    /** The policy permission the floor checks via `Policy.allows` — the role gate the app owns. */
    permission: string;
  };

  /**
   * The loud, greppable opt-out (ADR 0043 D2.1 — the `createAdmin` convention verbatim) that lets a
   * DESTRUCTIVE tool ship with NO floor. There is no silent "no floor → open" default: a
   * destructive tool with no `requires` and no `ungoverned: true` refuses to register.
   */
  ungoverned?: boolean;

  /**
   * The tool's work. Receives the PARSED input and the resolved principal (the single one
   * {@link dispatch} resolved), so a governed write can attribute to and reason about the subject.
   * `principal` is `undefined` on an unauthenticated dispatch — a governed tool's floor has already
   * denied that case before the handler runs, but the type stays honest for an ungoverned tool.
   */
  handler(input: I, ctx: { principal: Principal | undefined }): Promise<unknown>;
}

/**
 * Give a {@link LestoDomainTool} declaration its types (ADR 0043) — the `defineTable`/`definePolicy`
 * ergonomic for domain tools. This identity helper INFERS the input shape `I` from the Zod `input`
 * schema, so the `handler`'s `input` and `ctx` are typed without a hand-written generic (which would
 * otherwise clash with Zod's inferred output under `exactOptionalPropertyTypes`).
 */
export function defineDomainTool<I>(tool: LestoDomainTool<I>): LestoDomainTool<I> {
  return tool;
}

/** The content-store database, or a clear refusal when none was wired in. */
function requireContentDb(context: LestoMcpContext): SqlDatabase {
  if (context.contentDb === undefined) {
    throw new McpError(
      "MCP_CONTENT_STORE_UNAVAILABLE",
      "The content store is not configured for this server.",
    );
  }

  return context.contentDb;
}

/** How many entries the bounded dev introspection tools return when no `limit` is given. */
const DEFAULT_DEV_TAIL = 50;

/** The `limit` from a dev tool's input, defaulting when absent or non-numeric. */
function devTailLimit(input: Record<string, unknown>): number {
  return typeof input.limit === "number" ? input.limit : DEFAULT_DEV_TAIL;
}

/**
 * The dev-loop introspection tools (ADR 0032 Phase 1), bound to a live `reader`.
 *
 * Built ONLY when `buildTools` is handed a `devState` reader — i.e. under `lesto dev`.
 * The handlers close over the non-null `reader`, so the tools simply do not EXIST on a
 * server with no reader (every non-dev / remote server): they can never be advertised
 * or reached, rather than existing-and-refusing. That build-time gate — not a runtime
 * check, and not the absence of a flag — is what keeps DevError stacks, access-log
 * paths, and dev log lines from ever leaking off the dev process. Read-only and audited
 * like every other dispatch.
 */
function buildDevTools(reader: McpDevStateReader): LestoTool[] {
  const getDevDiagnostics: LestoTool = {
    name: "get_dev_diagnostics",
    description:
      "Report the current dev build/reload error, or null when the last change succeeded.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    destructive: false,
    handler: () => Promise.resolve(reader.getDiagnostics() ?? null),
  };

  const getRecentRequests: LestoTool = {
    name: "get_recent_requests",
    description:
      "List the most recently served requests from the live dev access log (optionally capped by limit).",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number" },
      },
    },
    destructive: false,
    handler: (input) => Promise.resolve(reader.recentRequests(devTailLimit(input))),
  };

  const tailLogs: LestoTool = {
    name: "tail_logs",
    description: "Return the most recent dev log lines (optionally capped by limit).",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number" },
      },
    },
    destructive: false,
    handler: (input) => Promise.resolve(reader.recentLogs(devTailLimit(input))),
  };

  return [getDevDiagnostics, getRecentRequests, tailLogs];
}

/**
 * The injected content surface, or a coded refusal when the optional content peers
 * aren't wired (`context.loadContent` absent). Read AND write content tools go through
 * here, so a server without the content packages fails closed with one clear message
 * rather than a raw module-resolution error.
 */
async function requireContent(context: LestoMcpContext): Promise<ContentModules> {
  if (context.loadContent === undefined) {
    throw missingContentError();
  }

  return context.loadContent();
}

/** The server's mode, defaulting to the safe `read-only` floor when unset. */
function modeOf(context: LestoMcpContext): McpMode {
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
   * collection from the database, patch it into the map, and republish. Takes the
   * injected {@link ContentModules} (the caller already loaded them for the write).
   */
  refresh(content: ContentModules, db: SqlDatabase, collection: string): Promise<void>;
}

function createContentRuntime(): ContentRuntime {
  // The authoritative collections map, seeded once on the first write. `undefined`
  // until then — so a tool set that never writes pays nothing.
  let collections: ContentCollections | undefined;

  return {
    refresh: async (content, db, collection) => {
      // Seed once with a single full load; every later write reuses this map and
      // only re-reads the collection it changed.
      collections ??= await content.store.loadEntries(db);

      // Reload ONLY the written collection. `loadEntries(db, name)` keys by
      // collection; a now-empty collection (its last entry deleted) yields no key,
      // so we clear it rather than leave a stale array behind.
      const reloaded = await content.store.loadEntries(db, collection);

      collections[collection] = reloaded[collection] ?? [];

      // Republish the patched full map; content-core's `setData` is a full
      // replace, but the database read above touched only one collection.
      content.core.setData(collections);
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
function requireOperator(context: LestoMcpContext, tool: string): void {
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
function toWriteInput(input: Record<string, unknown>): ContentWriteInput {
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
 * The names of the three dev-loop tools ({@link buildDevTools}), RESERVED for the domain-tool
 * collision check (ADR 0043 D2.3) even on a non-dev server where they are not built — so a domain
 * tool can never shadow a name a `lesto dev` server would later add.
 */
const DEV_TOOL_NAMES: readonly string[] = [
  "get_dev_diagnostics",
  "get_recent_requests",
  "tail_logs",
];

/**
 * Derive the MCP `tools/list` JSON Schema from a domain tool's Zod schema (ADR 0043 D1).
 *
 * Zod v4's native `z.toJSONSchema` produces a faithful schema (properties + `required`); the
 * `$schema` key it stamps is dropped — MCP tool `inputSchema` does not carry it, matching the shape
 * the framework tools hand-write.
 */
function domainInputSchema(schema: z.ZodType): object {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;

  const { $schema: _drop, ...rest } = json;

  return rest;
}

/**
 * Adapt a {@link LestoDomainTool} into the framework {@link LestoTool} shape (ADR 0043 D1).
 *
 * The built handler gates a destructive tool on operator mode (the scope ceiling at dispatch, like
 * `handle_request`), PARSES the input against the Zod schema at the boundary (ADR 0005 — a coded
 * `MCP_INVALID_TOOL_INPUT` on failure, never a crash), then runs the declared handler with the
 * parsed input and the resolved principal. `requiresPermission` (the dispatch floor, D3) is carried
 * when the tool declares a `requires` — {@link dispatch} enforces it before the handler runs.
 */
function adaptDomainTool(context: LestoMcpContext, domain: LestoDomainTool): LestoTool {
  return {
    name: domain.name,
    description: domain.description,
    inputSchema: domainInputSchema(domain.input),
    destructive: domain.destructive,
    ...(domain.requires === undefined ? {} : { requiresPermission: domain.requires.permission }),
    handler: async (input, principal) => {
      // A destructive domain tool is operator-only, exactly like handle_request: a read-only server
      // advertises it in tools/list but never runs the mutation.
      if (domain.destructive) requireOperator(context, domain.name);

      // Parse at the boundary (ADR 0005): a bad input is a coded refusal naming the tool, not a raw
      // ZodError bubbling out of a governed dispatch.
      const parsed = domain.input.safeParse(input);

      if (!parsed.success) {
        throw new McpError(
          "MCP_INVALID_TOOL_INPUT",
          `Input for the "${domain.name}" tool failed validation.`,
          { tool: domain.name, issues: parsed.error.issues },
        );
      }

      return domain.handler(parsed.data, { principal });
    },
  };
}

/**
 * Validate + adapt the app's declared domain tools (ADR 0043 D2), or `[]` when none are declared.
 *
 * Every declaration is checked against the fail-closed invariants — each lifted verbatim from a
 * shipped precedent — BEFORE the resolver-absence gate:
 *   - **D2.3 name collision** — a domain name equal to a framework name (`reserved`, the FULL set
 *     regardless of `omitTools`) or to another domain name refuses.
 *   - **D2.1 ungoverned destructive** — a destructive tool with no `requires.permission` and no
 *     `ungoverned: true` refuses.
 *   - **D2.4 governed-without-policy** — a tool declaring `requires` on a context with no `policy`
 *     refuses (the floor would never be adjudicated).
 *   - **L-0c458a04 non-destructive-without-scope** — a non-destructive `requires` with no explicit
 *     `scope` refuses (defaulting a read to the write scope would wrongly demand write).
 * Then **D2.2**: destructive tools are ABSENT (a build-time gate, like the dev tools) when no
 * principal resolver is wired — fail-closed, never present-and-open.
 */
function resolveDomainTools(context: LestoMcpContext, reserved: ReadonlySet<string>): LestoTool[] {
  const declared = context.domainTools ?? [];

  if (declared.length === 0) return [];

  const seen = new Set<string>();

  for (const domain of declared) {
    if (reserved.has(domain.name)) {
      throw new McpError(
        "MCP_DOMAIN_TOOL_NAME_CONFLICT",
        `Domain tool "${domain.name}" collides with a framework tool of the same name.`,
        { name: domain.name },
      );
    }

    if (seen.has(domain.name)) {
      throw new McpError(
        "MCP_DOMAIN_TOOL_NAME_CONFLICT",
        `Two domain tools are named "${domain.name}".`,
        { name: domain.name },
      );
    }

    seen.add(domain.name);

    if (domain.destructive && domain.requires === undefined && domain.ungoverned !== true) {
      throw new McpError(
        "MCP_DOMAIN_TOOL_UNGOVERNED",
        `Destructive domain tool "${domain.name}" needs a requires.permission floor (or an explicit ungoverned: true).`,
        { name: domain.name },
      );
    }

    if (domain.requires !== undefined && context.policy === undefined) {
      throw new McpError(
        "MCP_DOMAIN_TOOL_POLICY_REQUIRED",
        `Governed domain tool "${domain.name}" needs a policy on the MCP context to adjudicate its floor.`,
        { name: domain.name },
      );
    }

    if (
      domain.requires !== undefined &&
      !domain.destructive &&
      domain.requires.scope === undefined
    ) {
      throw new McpError(
        "MCP_DOMAIN_TOOL_SCOPE_REQUIRED",
        `Non-destructive governed domain tool "${domain.name}" needs an explicit requires.scope.`,
        { name: domain.name },
      );
    }
  }

  // D2.2: a destructive domain tool with no principal resolver is ABSENT — it never runs
  // unattributed. Non-destructive tools stay (they attribute nothing); a governed one with no
  // resolver still fails closed at the floor (empty roles satisfy nothing).
  const canAttribute = context.resolvePrincipal !== undefined;

  return declared
    .filter((domain) => canAttribute || !domain.destructive)
    .map((domain) => adaptDomainTool(context, domain));
}

/**
 * Build the Lesto tool set bound to a context.
 *
 * The handlers close over `context`, so the same tool definitions drive any app the caller
 * assembles. Order is stable: the framework tools (routes/request, content reads, content writes),
 * then the app's declared domain tools (ADR 0043), then — only under `lesto dev` — the dev tools.
 * `context.omitTools` drops named framework tools last (D4), e.g. a production RS covered by domain
 * tools drops `handle_request` for least privilege.
 */
export function buildTools(context: LestoMcpContext): LestoTool[] {
  // One incremental runtime view per tool set: the content writes refresh through
  // it so each write re-reads only the collection it changed, never the whole
  // store (see {@link createContentRuntime}).
  const runtime = createContentRuntime();

  const listRoutes: LestoTool = {
    name: "list_routes",
    description: "List every route the running Lesto app answers, in resolution order.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    destructive: false,
    handler: async () => context.routes,
  };

  const handleRequest: LestoTool = {
    name: "handle_request",
    description: "Drive the running Lesto app: dispatch a request and return its response.",
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

  const generateUi: LestoTool = {
    name: "generate_ui",
    description: "Generate a Lesto UI from a natural-language prompt.",
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

  const listContentCollections: LestoTool = {
    name: "list_content_collections",
    description: "List the content collections in the runtime, each with its entry count.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    destructive: false,
    handler: async () => {
      const content = await requireContent(context);

      return content.core.getCollections().map((collection) => ({
        name: collection.name,
        count: collection.entries.length,
      }));
    },
  };

  const getContentEntry: LestoTool = {
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
    handler: async (input) => {
      const content = await requireContent(context);

      return content.core.getEntry(String(input.collection), String(input.slug)) ?? null;
    },
  };

  const queryContent: LestoTool = {
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
      const content = await requireContent(context);

      const entries = content.core.query(String(input.collection));

      // Only narrow when a numeric limit was actually given.
      return typeof input.limit === "number" ? entries.limit(input.limit).get() : entries.get();
    },
  };

  const describeAppTool: LestoTool = {
    name: "describe_app",
    description:
      "Describe the app's read-only contract in one payload: its route map, OpenAPI document, content collections, and declared schema shape — the same data as the resources, for clients without resource support.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    destructive: false,
    // Reuses the resource readers, so the payload can never drift from the resources;
    // graceful-degrades (no content peers → empty collections) so it never refuses.
    handler: () => describeApp(context),
  };

  const createContentEntry: LestoTool = {
    name: "create_content_entry",
    description: "Create a new content entry in the store; errors if one already exists.",
    inputSchema: WRITE_ENTRY_SCHEMA,
    destructive: true,
    handler: async (input) => {
      requireOperator(context, "create_content_entry");

      const db = requireContentDb(context);

      const content = await requireContent(context);

      const write = toWriteInput(input);

      const { entry } = await content.store.createEntry(db, write);

      // The write changed one collection; refresh just that collection so reads
      // see it, without re-reading the rest of the store.
      await runtime.refresh(content, db, write.collection);

      return entry;
    },
  };

  const updateContentEntry: LestoTool = {
    name: "update_content_entry",
    description: "Update an existing content entry, merging data and replacing the body.",
    inputSchema: WRITE_ENTRY_SCHEMA,
    destructive: true,
    handler: async (input) => {
      requireOperator(context, "update_content_entry");

      const db = requireContentDb(context);

      const content = await requireContent(context);

      const write = toWriteInput(input);

      const { entry } = await content.store.updateEntry(db, write);

      await runtime.refresh(content, db, write.collection);

      return entry;
    },
  };

  const deleteContentEntry: LestoTool = {
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

      const content = await requireContent(context);

      const collection = String(input.collection);

      const result = await content.store.deleteEntry(db, collection, String(input.slug));

      await runtime.refresh(content, db, collection);

      return result;
    },
  };

  const frameworkTools: LestoTool[] = [
    listRoutes,
    handleRequest,
    generateUi,
    listContentCollections,
    getContentEntry,
    queryContent,
    describeAppTool,
    createContentEntry,
    updateContentEntry,
    deleteContentEntry,
  ];

  // The dev-loop introspection tools (ADR 0032 Phase 1) exist ONLY when a live-dev-state reader is
  // wired — i.e. under `lesto dev`. Absent it they are never built, so a non-dev / remote server can
  // neither advertise nor reach them: the dev surface is gated at build time (see buildDevTools).
  const devTools = context.devState === undefined ? [] : buildDevTools(context.devState);

  // Domain tools (ADR 0043) append AFTER the framework set and BEFORE the conditional dev tools,
  // preserving the stable-order contract. The collision reservation is the FULL framework name set —
  // the always-on tools plus the dev names — so a domain tool can never shadow a framework name,
  // even an omitted or a dev one (D2.3).
  const reserved = new Set<string>([...frameworkTools.map((tool) => tool.name), ...DEV_TOOL_NAMES]);

  const domainTools = resolveDomainTools(context, reserved);

  const all = [...frameworkTools, ...domainTools, ...devTools];

  // omitTools (D4): drop the named framework tools last — e.g. a production RS covered by domain
  // tools drops handle_request for least privilege. Names stay reserved above, so an omit can never
  // silently re-point a domain-tool name.
  const omit = new Set(context.omitTools ?? []);

  if (omit.size === 0) return all;

  // L-0c458a04: an omit that names NO known tool is a typo that would silently leave the intended
  // tool EXPOSED (the fail-open inverse of the reserved-name rule) — refuse it. The known set is the
  // reserved framework names (incl. the dev names, so omitting a dev tool off `lesto dev` is fine)
  // plus the declared domain names.
  const omittable = new Set<string>([
    ...reserved,
    ...(context.domainTools ?? []).map((t) => t.name),
  ]);

  for (const name of omit) {
    if (!omittable.has(name)) {
      throw new McpError(
        "MCP_UNKNOWN_OMIT_TOOL",
        `omitTools names "${name}", which is not a known framework or domain tool.`,
        { name },
      );
    }
  }

  return all.filter((tool) => !omit.has(tool.name));
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

  /**
   * An optional observability seam (ADR 0031 Phase 1): fired once per dispatch —
   * on success, on handler error, AND on `MCP_UNKNOWN_TOOL` — with the SAME
   * {@link McpAuditRecord} the mandatory audit received, AFTER that audit has been
   * written. `onSpan` is observability, not governance: it is optional (absent → a
   * zero-cost no-op, mirroring `LESTO_OTLP_URL` absent), and a throw from it is
   * swallowed so a faulty span sink can never break a governed dispatch — the
   * awaited audit stays the record of what ran. The app supplies it (e.g. opening
   * a standalone `mcp.tool` span via `@lesto/observability`'s vocabulary);
   * `@lesto/mcp` takes no `@lesto/observability` dependency — the seam is injected.
   *
   * Honest scope: `dispatch` runs from the stdio server outside any HTTP request,
   * so the `mcp.tool` span the app opens here is STANDALONE (unparented) — the
   * MCP↔request-trace join is Deferred (ADR 0031), not shipped by this seam.
   */
  onSpan?: (record: McpAuditRecord) => void;
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
  context: LestoMcpContext,
  tools: LestoTool[],
  name: string,
  input: Record<string, unknown>,
  options: DispatchOptions = {},
): Promise<unknown> {
  const now = options.now ?? Date.now;
  const { onSpan } = options;

  const startedAt = now();
  const inputHash = hashInput(input);

  // Resolve who is driving this dispatch (ADR 0028 Phase 3a). An absent resolver or
  // no session → no principal: the call is still audited, just unattributed.
  const principal = await context.resolvePrincipal?.();

  // Record one line for this invocation, with the duration measured to the
  // moment of recording. Awaited so an async sink (a DB write, a log flush)
  // completes before the dispatch resolves — the audit is part of the contract,
  // not fire-and-forget. Then offer the SAME record to the optional `onSpan` seam
  // (ADR 0031): observability, never governance, so a throw from it is swallowed —
  // a faulty span sink cannot break a governed dispatch, and the awaited audit
  // above stays the record of what ran.
  const audit = async (outcome: "ok" | "error"): Promise<void> => {
    const record: McpAuditRecord = {
      tool: name,
      inputHash,
      outcome,
      durationMs: now() - startedAt,
      actor: principal?.actor,
    };

    await context.audit(record);

    if (onSpan === undefined) return;

    try {
      onSpan(record);
    } catch {
      // Swallowed by design: observability never breaks governance.
    }
  };

  const tool = tools.find((candidate) => candidate.name === name);

  if (tool === undefined) {
    await audit("error");

    throw new McpError("MCP_UNKNOWN_TOOL", `No MCP tool is named "${name}".`, { name });
  }

  // The dispatch-level policy floor (ADR 0043 D3): a governed domain tool is reachable only by a
  // subject whose roles the policy grants the tool's permission — enforced on EVERY transport, so
  // stdio (which has no HTTP pre-dispatch floor) is finally gated (0028 Phase 3a item 2), and an
  // HTTP request that already cleared `policyFloorChallenge` gets the identical verdict here. It
  // checks the SAME single `principal` the handler receives (amendment (b)). Deny by default: an
  // unauthenticated dispatch has no principal → empty roles → denied; and a missing policy denies
  // too (a fail-closed backstop — a governed tool refuses to register without one, D2.4).
  if (tool.requiresPermission !== undefined) {
    const permitted =
      context.policy?.allows(principal?.actorRoles, tool.requiresPermission) ?? false;

    if (!permitted) {
      await audit("error");

      throw new McpError(
        "MCP_FORBIDDEN",
        `The "${name}" tool requires the "${tool.requiresPermission}" permission.`,
        { tool: name, permission: tool.requiresPermission },
      );
    }
  }

  try {
    const result = await tool.handler(input, principal);

    await audit("ok");

    return result;
  } catch (error) {
    await audit("error");

    throw error;
  }
}

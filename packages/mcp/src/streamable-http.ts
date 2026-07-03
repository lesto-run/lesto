/**
 * The remote MCP transport: Streamable-HTTP, mounted by the app (ADR 0028 Phase 3b).
 *
 * Like `server.ts` (the stdio transport), this is pure wiring behind a coverage
 * exclusion — it owns NO governance. Every security decision is made by the tested
 * logic in `http.ts` (the `Origin` guard, the `401`/`403` `WWW-Authenticate` challenges,
 * the scope→mode ceiling, and the per-tool policy floor) and `tools.ts` (`buildTools`/
 * `dispatch` and their audit + operator gate); this file only carries those decisions
 * onto HTTP and drives the `@modelcontextprotocol/sdk` Streamable-HTTP transport.
 *
 * **Mounted by the app, never the kernel.** `@lesto/mcp` already depends on
 * `@lesto/kernel`; if the kernel mounted this, that edge would close a cycle. So the
 * factory returns plain `@lesto/web` handlers the *application* registers on its own
 * chain (a grep-asserted invariant — no `kernel → mcp` import).
 *
 * **Per-request identity (seam decision `L-15fd2238`, option a).** A bearer subject is
 * per-request, but `LestoMcpContext.resolvePrincipal` is a zero-arg thunk. So each
 * request gets a FRESH `runContext` + `buildTools` whose `resolvePrincipal` closes over
 * *that* request's authenticated session — request-scoped DI, concurrency-safe, no shared
 * state and no signature change. `buildTools` is cheap.
 *
 * **Confused-deputy defaults.** The mode is derived from the token's scopes and floors to
 * `read-only` (a read-scoped token reaches no write); the tool set is exactly
 * `buildTools` — there is no impersonation tool to register; and a request audienced
 * elsewhere never authenticates (the RS rejects it in `http.ts`).
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import type { AnyLestoResponse, Handler, LestoRequest } from "@lesto/web";

import type { Policy } from "@lesto/authz";

import { buildTools, dispatch } from "./tools";
import type { LestoMcpContext } from "./tools";
import {
  compileToolFloor,
  gateMcpHttpRequest,
  policyFloorChallenge,
  protectedResourceMetadata,
  scopeCeilingChallenge,
} from "./http";
import type { BearerSession } from "./http";

/** What {@link createMcpHttpHandlers} needs to serve a Resource Server over HTTP. */
export interface McpHttpServerOptions {
  /**
   * The tool context, MINUS the per-request `mode`/`resolvePrincipal` this transport sets
   * from each request's token — and MINUS `devState`. Carries the app, routes, audit sink,
   * and optional content seams — everything connection-constant. Unlike the stdio
   * `startMcpServer`, this path injects NO default `loadContent`: a server that wants the
   * content tools must supply `context.loadContent` itself (absent it, the content tools
   * refuse, coded).
   *
   * `devState` is excluded STRUCTURALLY (ADR 0032): the dev introspection tools are built
   * only when a `devState` reader is present (`buildTools`), so dropping it from the type
   * makes "the remote OAuth transport can never advertise/reach `get_dev_diagnostics` /
   * `get_recent_requests` / `tail_logs`" a compile-time guarantee — a remote caller cannot
   * even pass a reader that would leak DevError stacks (absolute fs paths) or access-log
   * paths to a read-scoped bearer.
   */
  context: Omit<LestoMcpContext, "mode" | "resolvePrincipal" | "devState">;

  /** Validate a bearer token and bind it to a session — a configured `createBearerAuthenticator`. */
  authenticate: (token: string) => Promise<BearerSession | undefined>;

  /** This RS's canonical resource identifier (the audience tokens must carry). */
  resource: string;

  /** The issuer(s) whose tokens this RS accepts — advertised in the PRM document. */
  authorizationServers: readonly string[];

  /** The scopes this RS understands, advertised to clients in the PRM. */
  scopesSupported?: readonly string[];

  /** The OAuth scope that unlocks writes — the ceiling (`mcp:write`, say). */
  writeScope: string;

  /**
   * The compiled authorization {@link Policy} for the per-tool ROLE floor (OCP-7). OPTIONAL,
   * and the default is to omit it: absent (or with no {@link toolPermissions} mapping a tool
   * a request calls), governance is the scope ceiling alone — the back-compatible behavior, so
   * a server configured before OCP-7 is unchanged. PRESENT, it gates each mapped tool through
   * `authorizeBearer` (scope ceiling AND policy floor) BEFORE dispatch: within `operator` mode a
   * destructive tool becomes reachable only by a subject whose roles the policy grants the
   * tool's permission — closing the gap where any write-scoped bearer could drive any write.
   */
  policy?: Policy<string, string>;

  /**
   * The permission each tool demands — `tool name → policy permission` — the per-tool half of
   * the OCP-7 floor. Consulted ONLY when {@link policy} is set; a tool absent from this map
   * carries no floor (the scope ceiling governs it), so a deployment maps exactly the tools it
   * wants role-gated (typically the destructive ones). Each mapped tool's required SCOPE is the
   * {@link writeScope}, so the floor is an exact intersection with the existing ceiling.
   */
  toolPermissions?: Readonly<Record<string, string>>;

  /**
   * The browser origins allowed to reach this server (the DNS-rebinding allowlist). The
   * SDK transport's own origin/Host guard is left off in favor of this tested check, which
   * runs FIRST (a bad origin is refused before any token is read); note it guards `Origin`
   * only — Host-header rebinding is a deployment concern (bind to loopback / a trusted host).
   */
  allowedOrigins: readonly string[];

  /**
   * The absolute URL of the PRM document, for the `WWW-Authenticate` pointer on a 401. MUST
   * match the path the app actually mounts the {@link McpHttpHandlers.metadata} handler at
   * (RFC 9728 §3.1), or discovery 404s.
   */
  resourceMetadataUrl: string;

  /** The MCP server identity advertised to clients; defaults to this package. */
  serverInfo?: { name: string; version: string };
}

/** The `@lesto/web` handlers an app mounts to expose a remote MCP Resource Server. */
export interface McpHttpHandlers {
  /** Serves the RFC 9728 PRM — mount at `/.well-known/oauth-protected-resource` (GET). */
  metadata: Handler;

  /** The MCP Streamable-HTTP endpoint — mount at the server's MCP path (POST). */
  rpc: Handler;

  /**
   * The GET handler for the MCP path — mount at the server's MCP path (GET). The MCP
   * Streamable-HTTP transport lets a client open an optional server→client SSE stream with a
   * GET to the endpoint; this stateless JSON Resource Server offers none, so it answers `405`
   * with `Allow: POST` — the spec-correct "no SSE here" a real `StreamableHTTPClientTransport`
   * reads cleanly, rather than a `404` it would surface as a transport error.
   */
  noStream: Handler;
}

/** The advertised identity when the caller supplies none. */
const DEFAULT_SERVER_INFO = { name: "@lesto/mcp", version: "0.0.0" } as const;

// A real `StreamableHTTPClientTransport` probes GET on the MCP path for the optional
// server→client SSE stream; this stateless JSON RS offers none, so answer 405 (`Allow: POST`)
// — the client reads a clean "no SSE here" instead of a 404 it surfaces as a transport error.
const noStream: Handler = () => ({ status: 405, headers: { allow: "POST" }, body: "" });

/** Reconstruct a Web `Request` from a normalized {@link LestoRequest} for the SDK transport. */
function toFetchRequest(req: LestoRequest): Request {
  // The body is handed to the transport via `parsedBody`, so a bodyless Request is enough;
  // the transport reads only the method and headers off it. The host is irrelevant — the
  // Origin guard already ran — so a placeholder URL carries the path.
  return new Request(`https://mcp.invalid${req.path}`, {
    method: req.method,
    headers: req.headers,
  });
}

/** Adapt the SDK transport's Web `Response` back into a {@link AnyLestoResponse}. */
async function fromFetchResponse(response: Response): Promise<AnyLestoResponse> {
  const headers: Record<string, string> = {};

  response.headers.forEach((value, key) => {
    headers[key] = value;
  });

  // `enableJsonResponse` keeps every body a single JSON string (no SSE), so `.text()` is
  // the whole response.
  return { status: response.status, headers, body: await response.text() };
}

/** Drive one MCP request through a freshly-wired SDK server + stateless transport. */
async function runStreamableHttp(
  context: LestoMcpContext,
  tools: ReturnType<typeof buildTools>,
  req: LestoRequest,
  serverInfo: { name: string; version: string },
): Promise<AnyLestoResponse> {
  const server = new Server(serverInfo, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: { destructiveHint: tool.destructive },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const result = await dispatch(
      context,
      tools,
      request.params.name,
      request.params.arguments ?? {},
    );

    // Serialize once for the text block — back-compat, every client can read it. When the tool's
    // result is a JSON object, ALSO return it as `structuredContent` so a client reads the object
    // directly (`result.structuredContent`) instead of parsing the text (MCP 2025-06-18). Spec
    // guidance: the text IS the serialized structured result, so they always agree. Arrays/
    // primitives (e.g. `list_routes`) have no object form and stay text-only — still one parse.
    const text = JSON.stringify(result);
    const isObject = result !== null && typeof result === "object" && !Array.isArray(result);

    return {
      content: [{ type: "text" as const, text }],
      ...(isObject ? { structuredContent: result as Record<string, unknown> } : {}),
    };
  });

  // Stateless: a fresh transport per request, JSON responses (no SSE). Omitting
  // `sessionIdGenerator` (rather than passing `undefined`) is what the SDK reads as
  // stateless — and what `exactOptionalPropertyTypes` requires.
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });

  await server.connect(transport);

  // The body is already decoded by the runtime, so hand it over via `parsedBody`.
  const response = await transport.handleRequest(toFetchRequest(req), { parsedBody: req.body });

  return fromFetchResponse(response);
}

/**
 * Build the app-mounted handlers for a remote MCP Resource Server.
 *
 * The `metadata` handler serves the PRM; the `rpc` handler gates each request through
 * `http.ts` — `Origin` guard, then bearer authentication (`401` + challenge on failure),
 * then the scope ceiling (`403` + `insufficient_scope` before a scope-short write reaches
 * dispatch), then — when a {@link McpHttpServerOptions.policy} is configured — the per-tool
 * ROLE floor (`403` before a role-short call reaches dispatch, OCP-7) — and, on an accepted
 * request, drives the SDK transport against a per-request context whose `resolvePrincipal` is
 * the authenticated session.
 */
export function createMcpHttpHandlers(options: McpHttpServerOptions): McpHttpHandlers {
  const serverInfo = options.serverInfo ?? DEFAULT_SERVER_INFO;

  // The connection-constant context (ADR 0043): the deployment's compiled policy rides HERE so the
  // dispatch-level domain-tool floor adjudicates against the SAME policy the HTTP floor does. The
  // per-request runContext (below) adds only `mode` + `resolvePrincipal`.
  const baseContext: LestoMcpContext = {
    ...options.context,
    ...(options.policy === undefined ? {} : { policy: options.policy }),
  };

  // Validate the domain-tool declarations up front (ADR 0043 D2 — a destructive tool with no floor,
  // a name collision, a governed tool with no policy each refuse to register) and learn the built
  // framework tool names for the unknown-tool floor check. Destructive domain tools are absent here
  // (no per-request resolver yet), but every declaration is still validated before that gate.
  const constructionTools = buildTools(baseContext);

  // The per-tool floor (OCP-7 + ADR 0043 D3), compiled once in tested code: framework floors from the
  // deployment map, domain floors from each governed declaration, disjoint ownership enforced.
  const requirements = compileToolFloor({
    ...(options.toolPermissions === undefined ? {} : { toolPermissions: options.toolPermissions }),
    ...(options.context.domainTools === undefined
      ? {}
      : { domainTools: options.context.domainTools }),
    knownToolNames: new Set(constructionTools.map((tool) => tool.name)),
    writeScope: options.writeScope,
  });

  const metadataBody = JSON.stringify(
    protectedResourceMetadata({
      resource: options.resource,
      authorizationServers: options.authorizationServers,
      ...(options.scopesSupported === undefined
        ? {}
        : { scopesSupported: options.scopesSupported }),
    }),
  );

  const metadata: Handler = () => ({
    status: 200,
    headers: { "content-type": "application/json" },
    body: metadataBody,
  });

  const rpc: Handler = async (c) => {
    const decision = await gateMcpHttpRequest({
      origin: c.header("origin"),
      authorization: c.header("authorization"),
      allowedOrigins: options.allowedOrigins,
      authenticate: options.authenticate,
      resourceMetadata: options.resourceMetadataUrl,
      writeScope: options.writeScope,
    });

    if (decision.kind === "reject") {
      return {
        status: decision.status,
        headers: {
          "content-type": "application/json",
          ...(decision.wwwAuthenticate === undefined
            ? {}
            : { "www-authenticate": decision.wwwAuthenticate }),
        },
        body: decision.body,
      };
    }

    const { session, mode } = decision;

    // Per-request context: the connection-constant seams (incl. the ADR 0043 policy), plus this
    // request's mode and a `resolvePrincipal` closed over its authenticated session (seam decision a).
    const runContext: LestoMcpContext = {
      ...baseContext,
      mode,
      resolvePrincipal: () => session.principal,
    };

    const tools = buildTools(runContext);

    // Scope ceiling: refuse a scope-short write at the HTTP layer (403) before dispatch.
    const denial = scopeCeilingChallenge({
      message: c.req.body,
      mode,
      destructiveTools: new Set(tools.filter((tool) => tool.destructive).map((tool) => tool.name)),
      writeScope: options.writeScope,
    });

    if (denial !== undefined) {
      return {
        status: 403,
        headers: { "content-type": "application/json", "www-authenticate": denial.wwwAuthenticate },
        body: denial.body,
      };
    }

    // Policy floor (OCP-7): refuse a tool whose permission the subject's roles do not hold —
    // even in operator mode — at the HTTP layer (403) before dispatch. A no-op when no policy
    // is configured, so the scope ceiling stays the sole gate (the back-compatible default).
    const floorDenial = policyFloorChallenge({
      message: c.req.body,
      scopes: session.scopes,
      roles: session.principal.actorRoles,
      policy: options.policy,
      requirements,
      resourceMetadata: options.resourceMetadataUrl,
    });

    if (floorDenial !== undefined) {
      return {
        status: 403,
        headers: {
          "content-type": "application/json",
          "www-authenticate": floorDenial.wwwAuthenticate,
        },
        body: floorDenial.body,
      };
    }

    return runStreamableHttp(runContext, tools, c.req, serverInfo);
  };

  return { metadata, rpc, noStream };
}

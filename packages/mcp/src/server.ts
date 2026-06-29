/**
 * The MCP transports for the Lesto control plane: the stdio server (`lesto mcp`)
 * and the loopback HTTP dev server (`lesto dev`, ADR 0032 Phase 1).
 *
 * This is pure wiring and lives behind a coverage exclusion: it owns no business
 * logic. It builds the SDK `Server`, registers the Lesto tool set (the real logic,
 * in `tools.ts`), and connects a transport. Everything an agent can actually *do*
 * is decided by `buildTools` / `dispatch` (tested directly), and every dev-transport
 * security decision is made by the covered `http-transport.ts` gate; this file only
 * carries those decisions onto the wire — the irreducible socket bind.
 */

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { buildTools, dispatch } from "./tools";
import type { ContentModules, LestoMcpContext, LestoTool } from "./tools";
import { buildResources, listResources, readResource } from "./resources";
import {
  gateDevRequest,
  headerValue,
  loopbackAllowlist,
  nodeHeadersToWeb,
  parseDevBody,
} from "./http-transport";
import type { DevMcpSecurity } from "./http-transport";
import { rethrowUnlessMissingContentPeer } from "./content-peer";

/**
 * The default content loader the server injects into the context: dynamic-import the
 * optional content peers (literal specifiers so the resolved module types still flow)
 * so `@lesto/mcp` boots and serves its generic tools without them. A missing peer is
 * classified by {@link rethrowUnlessMissingContentPeer} (covered, in `content-peer.ts`)
 * into a coded `MCP_CONTENT_PACKAGES_MISSING` the first time a content tool runs; the
 * only logic that stays HERE (coverage-excluded) is the literal `import()` itself.
 */
async function defaultLoadContent(): Promise<ContentModules> {
  try {
    const [core, store] = await Promise.all([
      import("@lesto/content-core"),
      import("@lesto/content-store"),
    ]);

    return { core, store };
  } catch (error) {
    rethrowUnlessMissingContentPeer(error);
  }
}

/**
 * Register the `tools/list` + `tools/call` handlers on an SDK server — shared by the
 * stdio server and the loopback dev HTTP server so the wire shape can't drift. Both
 * delegate to the tested `buildTools`/`dispatch`; this only carries them onto the wire.
 */
function registerToolHandlers(server: Server, context: LestoMcpContext, tools: LestoTool[]): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      // Surface the destructive flag so a client can warn before invoking a tool
      // that mutates state or drives the live app.
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

    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  });
}

/**
 * Stand up the MCP server over stdio and serve the Lesto tool set.
 *
 * Resolves only once the client disconnects (the transport closes); the server runs
 * until then.
 */
export async function startMcpServer(context: LestoMcpContext): Promise<void> {
  // Inject the real content loader unless the caller supplied one; the content tools
  // run against the optional peers through it, and refuse (coded) when they're absent.
  const runContext: LestoMcpContext = {
    ...context,
    loadContent: context.loadContent ?? defaultLoadContent,
  };

  const tools = buildTools(runContext);
  const resources = buildResources(runContext);

  const server = new Server(
    { name: "@lesto/mcp", version: "0.0.0" },
    { capabilities: { tools: {}, resources: {} } },
  );

  registerToolHandlers(server, runContext, tools);

  // The read-only app contract (ADR 0034 Part A). Both handlers delegate straight
  // to the covered builders in `resources.ts` — this file adds no select logic.
  server.setRequestHandler(ListResourcesRequestSchema, async () => listResources(resources));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) =>
    readResource(resources, request.params.uri),
  );

  const transport = new StdioServerTransport();

  await server.connect(transport);

  // `connect` resolves the instant the transport is wired — NOT when it closes. If we
  // returned here the caller would `process.exit(0)` immediately and the server would
  // die before serving a single request. Stay resolved-pending until the client
  // disconnects (stdin ends / transport closes), which is what "serve over stdio" means.
  await new Promise<void>((resolve) => {
    // The SDK's `Protocol` exposes `onclose` as a settable hook — it has no
    // `addEventListener`, so the property assignment is the API, not a smell.
    // oxlint-disable-next-line unicorn/prefer-add-event-listener
    server.onclose = resolve;
  });
}

/** The header the loopback dev MCP client presents the per-session token in. */
const DEV_TOKEN_HEADER = "x-lesto-dev-token";

/** A running loopback dev MCP server (ADR 0032 Phase 1). */
export interface McpHttpServerHandle {
  /** The bound loopback port (resolved when `0` was requested). */
  port: number;

  /** Stop the server — close the loopback socket. */
  close(): Promise<void>;
}

/** Read a node request body to a string. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Drive one accepted dev MCP request through a fresh stateless SDK transport. */
async function runDevMcp(
  context: LestoMcpContext,
  req: IncomingMessage,
  parsedBody: unknown,
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  const tools = buildTools(context);

  const server = new Server(
    { name: "@lesto/mcp", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );

  registerToolHandlers(server, context, tools);

  // Stateless: a fresh transport per request, JSON responses (no SSE), mirroring the
  // remote Streamable-HTTP path. The covered `gateDevRequest` already ran, so the SDK's
  // own DNS-rebinding guard is redundant and left off.
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });

  await server.connect(transport);

  const webRequest = new Request(`http://127.0.0.1${req.url ?? "/"}`, {
    method: req.method ?? "POST",
    headers: nodeHeadersToWeb(req.headers),
  });

  const response = await transport.handleRequest(webRequest, { parsedBody });

  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });

  return { status: response.status, headers, body: await response.text() };
}

/** Gate one inbound dev connection (covered `gateDevRequest`), then dispatch or refuse. */
async function handleDevConnection(
  context: LestoMcpContext,
  security: DevMcpSecurity,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // Gate on the HEADERS first — before reading the body — so a refused (foreign-Origin /
  // untokened) request never buffers an unbounded body into memory.
  const decision = gateDevRequest({
    origin: headerValue(req.headers.origin),
    host: headerValue(req.headers.host),
    token: headerValue(req.headers[DEV_TOKEN_HEADER]),
    security,
  });

  if (decision.kind === "reject") {
    res.writeHead(decision.status, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: decision.code, message: decision.reason }));

    return;
  }

  const parsedBody = parseDevBody(await readBody(req));

  const { status, headers, body } = await runDevMcp(context, req, parsedBody);

  res.writeHead(status, headers);
  res.end(body);
}

/**
 * Stand the DEV-ONLY loopback MCP server up (ADR 0032 Phase 1).
 *
 * Binds a `node:http` server to loopback (`127.0.0.1`), mints nothing itself — the
 * caller supplies the per-session `token` — and gates EVERY request through the
 * covered `gateDevRequest` (foreign Origin/Host or wrong token → coded
 * `MCP_DEV_ORIGIN_REJECTED`) before driving the SDK transport against the injected
 * dev `context`. This is the irreducible socket bind; all security logic is in the
 * covered `http-transport.ts`. Mounted ONLY by the `lesto dev` bin path (Inc 4b).
 */
export function startMcpHttpServer(
  context: LestoMcpContext,
  options: { token: string; port?: number; host?: string },
): Promise<McpHttpServerHandle> {
  const host = options.host ?? "127.0.0.1";

  // The allowlist depends on the bound port; set once `listen` resolves, before any
  // request can arrive. A request landing in the race window gets a plain 503.
  let security: DevMcpSecurity | undefined;

  const httpServer = createServer((req, res) => {
    if (security === undefined) {
      res.writeHead(503);
      res.end();

      return;
    }

    handleDevConnection(context, security, req, res).catch(() => {
      // A failure in the dev glue (NOT a tool error — those are JSON-RPC responses the
      // SDK shapes) must not hang the socket or surface as an unhandled rejection.
      if (!res.headersSent) res.writeHead(500);

      res.end();
    });
  });

  return new Promise((resolve, reject) => {
    httpServer.once("error", reject);

    httpServer.listen(options.port ?? 0, host, () => {
      const port = (httpServer.address() as AddressInfo).port;
      const { allowedOrigins, allowedHosts } = loopbackAllowlist(port);

      security = { token: options.token, allowedOrigins, allowedHosts };

      resolve({
        port,
        close: () =>
          new Promise<void>((closed) => {
            httpServer.close(() => closed());
          }),
      });
    });
  });
}

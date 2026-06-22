/**
 * The stdio transport for the Lesto MCP control plane.
 *
 * This is pure wiring and lives behind a coverage exclusion: it owns no business
 * logic. It builds the SDK `Server`, registers the Lesto tool set (the real logic,
 * in `tools.ts`), and connects a process `StdioServerTransport`. Everything an
 * agent can actually *do* is decided by `buildTools` / `dispatch`, which are
 * tested directly; this file only carries those decisions onto the wire.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { buildTools, dispatch } from "./tools";
import type { ContentModules, LestoMcpContext } from "./tools";
import { McpError } from "./errors";

const CONTENT_PACKAGES_HINT =
  "The content tools need the content packages — run `npm i @lesto/content-core @lesto/content-store`.";

/**
 * Convert a missing optional content PEER into the coded refusal, and rethrow any
 * other error untouched — a real failure INSIDE an installed content package must not
 * be masked as "go install it". Classifies on the missing specifier the runtime names
 * (`Cannot find package '<x>'`), not the whole message. Mirrors `@lesto/cli`'s loader.
 */
function rethrowUnlessMissingContentPeer(error: unknown): never {
  if (error instanceof Error && "code" in error && error.code === "ERR_MODULE_NOT_FOUND") {
    const missing = /Cannot find (?:package|module) '([^']+)'/.exec(error.message)?.[1];

    if (missing?.startsWith("@lesto/content-")) {
      throw new McpError("MCP_CONTENT_PACKAGES_MISSING", CONTENT_PACKAGES_HINT);
    }
  }

  throw error;
}

/**
 * The default content loader the server injects into the context: dynamic-import the
 * optional content peers (literal specifiers so the resolved module types still flow)
 * so `@lesto/mcp` boots and serves its generic tools without them. A missing peer
 * surfaces as a coded `MCP_CONTENT_PACKAGES_MISSING` the first time a content tool runs.
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
 * Stand up the MCP server over stdio and serve the Lesto tool set.
 *
 * Resolves once the transport is connected; the server then runs until the
 * client disconnects or the process exits.
 */
export async function startMcpServer(context: LestoMcpContext): Promise<void> {
  // Inject the real content loader unless the caller supplied one; the content tools
  // run against the optional peers through it, and refuse (coded) when they're absent.
  const runContext: LestoMcpContext = {
    ...context,
    loadContent: context.loadContent ?? defaultLoadContent,
  };

  const tools = buildTools(runContext);

  const server = new Server(
    { name: "@lesto/mcp", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );

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
      runContext,
      tools,
      request.params.name,
      request.params.arguments ?? {},
    );

    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
    };
  });

  const transport = new StdioServerTransport();

  await server.connect(transport);
}

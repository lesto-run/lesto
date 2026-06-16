/**
 * The stdio transport for the Keel MCP control plane.
 *
 * This is pure wiring and lives behind a coverage exclusion: it owns no business
 * logic. It builds the SDK `Server`, registers the Keel tool set (the real logic,
 * in `tools.ts`), and connects a process `StdioServerTransport`. Everything an
 * agent can actually *do* is decided by `buildTools` / `dispatch`, which are
 * tested directly; this file only carries those decisions onto the wire.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { buildTools, dispatch } from "./tools";
import type { KeelMcpContext } from "./tools";

/**
 * Stand up the MCP server over stdio and serve the Keel tool set.
 *
 * Resolves once the transport is connected; the server then runs until the
 * client disconnects or the process exits.
 */
export async function startMcpServer(context: KeelMcpContext): Promise<void> {
  const tools = buildTools(context);

  const server = new Server(
    { name: "@keel/mcp", version: "0.0.0" },
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
      context,
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

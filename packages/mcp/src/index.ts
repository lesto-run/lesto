/**
 * @volo/mcp — the Volo MCP control plane.
 *
 * Exposes Volo operations to AI agents as MCP tools over `@modelcontextprotocol/sdk`.
 *
 *   const tools = buildTools({ app, router, generateUi });
 *
 *   await dispatch(tools, "list_routes", {});             // the app's routes
 *   await dispatch(tools, "handle_request", { ... });     // drive the running app
 *
 *   await startMcpServer({ app, router });                // serve over stdio
 *
 * The tool handlers are pure and fully tested; the stdio transport is a thin,
 * separate adapter in `server.ts`.
 */

export { buildTools, dispatch } from "./tools";
export type {
  DispatchOptions,
  VoloMcpContext,
  VoloTool,
  McpAuditRecord,
  McpAuditSink,
  McpMode,
} from "./tools";

export { startMcpServer } from "./server";

export { McpError } from "./errors";
export type { McpErrorCode } from "./errors";

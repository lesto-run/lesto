/**
 * @lesto/content-mcp - MCP (Model Context Protocol) server for Docks content engine
 *
 * This package provides MCP servers for integrating Docks with Claude Desktop
 * and other MCP-compatible tools.
 *
 * Two server implementations are available:
 *
 * 1. Standalone server (createMcpServer, startMcpServer):
 *    - Loads content directly from the filesystem
 *    - No dependencies on Studio API
 *    - Best for simple use cases
 *
 * 2. HTTP server (createMcpHttpServer, startMcpHttpServer):
 *    - Wraps the Studio HTTP API
 *    - Consistent state with Studio Chat Panel
 *    - Additional features: voice, AI, quality tools
 *    - Recommended for full-featured usage
 *
 * @example
 * ```typescript
 * // Start standalone MCP server
 * import { startMcpServer } from "@lesto/content-mcp";
 * await startMcpServer({ cwd: process.cwd() });
 *
 * // Start HTTP MCP server (requires Studio running)
 * import { startMcpHttpServer } from "@lesto/content-mcp";
 * await startMcpHttpServer({ studioUrl: "http://localhost:4400" });
 * ```
 */

// Standalone MCP server (works without Studio)
export { createMcpServer, startMcpServer } from "./server.js";
export type { McpServerOptions } from "./server.js";

// HTTP MCP server (wraps Studio API)
export { createMcpHttpServer, startMcpHttpServer } from "./http.js";
export type { McpHttpServerOptions } from "./http.js";

// Client for interacting with Studio API
export {
  McpClient,
  getMcpClient,
  getDefaultMcpClient,
  createMcpClient,
  StudioNotRunningError,
} from "./client.js";
export type {
  McpClientOptions,
  McpClientResponse,
  SseEvent,
  CollectionInfo,
  CollectionListResponse,
  EntryInfo,
  SchemaField,
  SchemaResponse,
  VoiceProfileResponse,
  AIStatusResponse,
} from "./client.js";

// Tool utilities
export { ToolBuilder, zodToMcpSchema, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT } from "./tools.js";

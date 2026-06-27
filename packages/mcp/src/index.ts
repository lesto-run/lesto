/**
 * @lesto/mcp — the Lesto MCP control plane.
 *
 * Exposes Lesto operations to AI agents as MCP tools over `@modelcontextprotocol/sdk`.
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

export { buildTools, dispatch, mcpPrincipalResolver } from "./tools";
export type {
  AppSchemaShape,
  ContentModules,
  DispatchOptions,
  LestoMcpContext,
  LestoTool,
  McpAuditRecord,
  McpAuditSink,
  McpMode,
  McpPrincipalResolverOptions,
} from "./tools";

export { startMcpServer } from "./server";

export { buildResources, listResources, readResource } from "./resources";
export type { LestoResource } from "./resources";

export {
  authorizeBearer,
  bearerChallenge,
  bearerFromAuthorization,
  createBearerAuthenticator,
  gateMcpHttpRequest,
  insufficientScopeChallenge,
  isOriginAllowed,
  mcpModeForScopes,
  policyFloorChallenge,
  protectedResourceMetadata,
  scopeCeilingChallenge,
} from "./http";
export type {
  AccessTokenClaims,
  BearerAuthenticatorOptions,
  BearerAuthorization,
  BearerSession,
  McpHttpGateDecision,
  McpHttpGateOptions,
  ProtectedResourceMetadata,
  ProtectedResourceMetadataOptions,
  ToolRequirement,
  VerifyAccessToken,
} from "./http";

export { createMcpHttpHandlers } from "./streamable-http";
export type { McpHttpHandlers, McpHttpServerOptions } from "./streamable-http";

export { McpError } from "./errors";
export type { McpErrorCode } from "./errors";

/**
 * @lesto/mcp — the Lesto MCP control plane.
 *
 * Exposes Lesto operations to AI agents as MCP tools over `@modelcontextprotocol/sdk`.
 *
 *   const context = { app, routes, audit };
 *   const tools = buildTools(context);
 *
 *   await dispatch(context, tools, "list_routes", {});         // the app's routes
 *   await dispatch(context, tools, "handle_request", { ... }); // drive the running app
 *
 *   await startMcpServer({ app, routes, audit });              // serve over stdio
 *
 * The tool handlers are pure and fully tested; the stdio transport is a thin,
 * separate adapter in `server.ts`.
 */

export { buildTools, defineDomainTool, dispatch, mcpPrincipalResolver } from "./tools";
export type {
  AppSchemaShape,
  ContentModules,
  DispatchOptions,
  LestoDomainTool,
  LestoMcpContext,
  LestoTool,
  McpAuditRecord,
  McpAuditSink,
  McpDevStateReader,
  McpMode,
  McpPrincipalResolverOptions,
} from "./tools";

export { startMcpServer, startMcpHttpServer } from "./server";
export type { McpHttpServerHandle } from "./server";

export { buildResources, describeApp, listResources, readResource } from "./resources";
export type { LestoResource } from "./resources";

// The loopback dev MCP transport's covered security core (ADR 0032 Phase 1) — the
// Origin/Host allowlist + per-session-token gate, reused by the live-reload WS retrofit.
export {
  gateDevRequest,
  isHostAllowed,
  isLiveReloadUpgradeAllowed,
  loopbackAllowlist,
} from "./http-transport";
export type { DevMcpGateDecision, DevMcpSecurity } from "./http-transport";

export {
  authorizeBearer,
  bearerChallenge,
  bearerFromAuthorization,
  compileToolFloor,
  createBearerAuthenticator,
  gateMcpHttpRequest,
  insufficientScopeChallenge,
  isOriginAllowed,
  mcpModeForScopes,
  policyFloorChallenge,
  protectedResourceMetadata,
  refusalBody,
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

/**
 * The shared AI/agent span vocabulary (ADR 0031).
 *
 * Two records of one agent action must agree on what to call things: the
 * (covered) `mcp.tool` span the control plane emits over `@lesto/mcp`'s
 * `dispatch`, and the (preview) `ai.generate` / `ai.tool` spans `@lesto/ai`
 * emits. This module is that one agreement — value-level span names and
 * attribute keys, plus a pure mapper from an MCP audit record's *shape* onto the
 * `mcp.*` attribute bag.
 *
 * It is deliberately *the shared vocabulary the later trace-attachment phases
 * agree on*, NOT a wave keystone (0034-P1 and 0035-P1 import none of it). And it
 * holds the layering line: `@lesto/observability` gains no `@lesto/mcp` and no
 * `@lesto/ai` import — {@link mcpAuditToSpanAttributes} takes a STRUCTURAL record
 * (the same structural-marker discipline ADR 0028 uses), never an imported type,
 * so the dependency graph stays acyclic.
 */

/** The span name an `@lesto/ai` model call opens — one per `generateText` turn. */
export const AI_GENERATE_SPAN = "ai.generate";

/** The span name an `@lesto/ai` tool execution opens — one per `runAgent` tool call. */
export const AI_TOOL_SPAN = "ai.tool";

/** The span name a governed MCP dispatch opens — one per audited `@lesto/mcp` tool call. */
export const MCP_TOOL_SPAN = "mcp.tool";

/** Attribute key: the model id a `generateText` call ran against. */
export const AI_MODEL_ATTR = "ai.model";

/** Attribute key: tokens the model read (the parsed prompt `Usage`). */
export const AI_USAGE_INPUT_TOKENS_ATTR = "ai.usage.input_tokens";

/** Attribute key: tokens the model wrote (the parsed completion `Usage`). */
export const AI_USAGE_OUTPUT_TOKENS_ATTR = "ai.usage.output_tokens";

/** Attribute key: why the model stopped (the `StopReason`). */
export const AI_STOP_REASON_ATTR = "ai.stop_reason";

/**
 * Attribute key: whether the span wraps a streamed (`streamText`) or one-shot (`generateText`)
 * model call — a boolean set on EVERY `ai.generate` span (L-1cbabfc0). It exists so a trace query
 * can segment streamed vs one-shot latency, and so a span missing `ai.usage.*`/`ai.stop_reason`
 * is read correctly: expected on a *torn* streamed span (`true`; a complete stream carries them,
 * recovered from `message_delta`), a regression on a one-shot one (`false`), never an
 * undocumented implicit "this was streamed" signal.
 */
export const AI_STREAMING_ATTR = "ai.streaming";

/** Attribute key: the name of the tool a `runAgent` turn invoked. */
export const AI_TOOL_NAME_ATTR = "ai.tool.name";

/** Attribute key: the MCP tool name as dispatched. */
export const MCP_TOOL_ATTR = "mcp.tool";

/** Attribute key: the SHA-256 hex digest of the canonicalized MCP input. */
export const MCP_INPUT_HASH_ATTR = "mcp.input_hash";

/** Attribute key: whether the MCP dispatch returned (`ok`) or threw (`error`). */
export const MCP_OUTCOME_ATTR = "mcp.outcome";

/** Attribute key: the wall-clock duration of the MCP dispatch, in milliseconds. */
export const MCP_DURATION_MS_ATTR = "mcp.duration_ms";

/**
 * The structural shape of an MCP audit record {@link mcpAuditToSpanAttributes}
 * reads — exactly the four fields it maps, declared structurally so
 * `@lesto/observability` imports no `McpAuditRecord` from `@lesto/mcp` (no
 * cross-edge). `@lesto/mcp`'s real record is a structural supertype of this, so
 * the app passes it straight through with no cast.
 */
export interface McpAuditShape {
  /** The tool name as dispatched. */
  readonly tool: string;

  /** A SHA-256 hex digest of the canonicalized input. */
  readonly inputHash: string;

  /** Whether the handler returned (`ok`) or threw (`error`). */
  readonly outcome: "ok" | "error";

  /** Wall-clock duration of the dispatch, in milliseconds. */
  readonly durationMs: number;
}

/**
 * Map an MCP audit record's shape onto the `mcp.*` attribute bag for its span.
 *
 * Pure and total: the same four fields the mandatory audit already carries become
 * the four `mcp.*` attributes, so the standalone `mcp.tool` span and the audit
 * line read as one record of one action. The input is structural (see
 * {@link McpAuditShape}) — the app hands its real audit record straight through.
 */
export function mcpAuditToSpanAttributes(record: McpAuditShape): Record<string, unknown> {
  return {
    [MCP_TOOL_ATTR]: record.tool,
    [MCP_INPUT_HASH_ATTR]: record.inputHash,
    [MCP_OUTCOME_ATTR]: record.outcome,
    [MCP_DURATION_MS_ATTR]: record.durationMs,
  };
}

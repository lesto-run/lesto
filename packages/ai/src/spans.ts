/**
 * The AI/agent span vocabulary, RE-STATED (ADR 0031 Phase 2, PREVIEW).
 *
 * These value-level constants MUST equal the canonical ones in `@lesto/observability`'s
 * `agent-vocabulary.ts` (`AI_GENERATE_SPAN = "ai.generate"`, `AI_TOOL_SPAN`, `AI_MODEL_ATTR`,
 * `AI_USAGE_INPUT_TOKENS_ATTR`, `AI_USAGE_OUTPUT_TOKENS_ATTR`, `AI_STOP_REASON_ATTR`,
 * `AI_STREAMING_ATTR`, `AI_TOOL_NAME_ATTR`). They are RE-STATED here rather than imported so
 * `@lesto/ai` stays the dependency-free model layer it is — the layering line is that `@lesto/ai`
 * gains no `@lesto/observability` edge (ADR 0031). The estate consumer (Inc 4), which legitimately
 * depends on observability, is the seam that asserts the two vocabularies agree.
 *
 * The names are structural strings that land on the emitted span; the app's `Tracer` adapter
 * reads them back through the same vocabulary, so a `mcp.tool` audit line and an `ai.generate`
 * span read as one record of one agent action.
 */

/** Span name: one per `generateText` model call. Equals `AI_GENERATE_SPAN` in observability. */
export const AI_GENERATE_SPAN = "ai.generate";

/** Span name: one per `runAgent` tool execution. Equals `AI_TOOL_SPAN` in observability. */
export const AI_TOOL_SPAN = "ai.tool";

/** Attribute: the model id the call ran against (`modelId ?? model.defaultModelId`). */
export const AI_MODEL_ATTR = "ai.model";

/** Attribute: prompt tokens the model read (the parsed `Usage.inputTokens`). */
export const AI_USAGE_INPUT_TOKENS_ATTR = "ai.usage.input_tokens";

/** Attribute: completion tokens the model wrote (the parsed `Usage.outputTokens`). */
export const AI_USAGE_OUTPUT_TOKENS_ATTR = "ai.usage.output_tokens";

/** Attribute: why the model stopped this turn (the `StopReason`). */
export const AI_STOP_REASON_ATTR = "ai.stop_reason";

/**
 * Attribute: whether this `ai.generate` span wraps a streamed (`streamText` → `true`) or one-shot
 * (`generateText` → `false`) call. Set on EVERY span so a trace query can segment the two, and so
 * a span missing `ai.usage.*`/`ai.stop_reason` reads as expected on a *torn* stream (`true`; a
 * complete stream carries them, recovered from `message_delta`) rather than a bug on a one-shot
 * (`false`). Equals `AI_STREAMING_ATTR` in observability.
 */
export const AI_STREAMING_ATTR = "ai.streaming";

/** Attribute: the tool name a `runAgent` turn invoked (the `ToolCall.name`). */
export const AI_TOOL_NAME_ATTR = "ai.tool.name";

/**
 * Attribute: the coded {@link import("./errors").AiError} recorded on an errored span — e.g.
 * `AI_HTTP_ERROR` on a failed generation, `AI_TOOL_NOT_FOUND` on a hallucinated tool. A
 * preview `@lesto/ai`-local attribute; the shared vocabulary carries only the `mcp.*` outcome.
 */
export const AI_ERROR_CODE_ATTR = "ai.error_code";

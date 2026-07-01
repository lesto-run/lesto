/**
 * @lesto/ai — PREVIEW app-builder AI primitives (ADR 0021).
 *
 * The other half of Lesto's AI story: the MCP control plane lets agents OPERATE
 * Lesto; this package lets developers BUILD AI features into a Lesto app. It is
 * provider-agnostic and dependency-free — the Anthropic Messages API over an
 * INJECTED `fetch` transport, the same way `@lesto/auth` does TOTP over
 * `node:crypto` (ADR 0020). The injected transport is what makes the pure core —
 * message assembly, the agent/tool loop, SSE stream parsing — testable with no
 * network, exactly as `@lesto/bench` injects a `SampleSource` + `clock`.
 *
 *   import { createAnthropic, generateText, streamText, runAgent } from "@lesto/ai";
 *
 *   const model = createAnthropic({ apiKey: env.ANTHROPIC_API_KEY }); // default claude-opus-4-8
 *   const { text } = await generateText({ model, messages: [{ role: "user", content: "Hi" }] });
 *
 * PREVIEW: experimental, below the 100%-coverage gate (it declares no `test:cov`,
 * so `scripts/coverage-gate.ts` skips it) — its pure core is still fully tested.
 */

// Provider (Anthropic Messages API behind the LanguageModel interface)
export { createAnthropic, DEFAULT_MODEL_ID, parseResponse, parseStream } from "./anthropic";
export type { AnthropicConfig } from "./anthropic";

// Model layer — Increment 1
export { generateText, streamText } from "./generate";

// Tool / agent loop — Increment 2
export { runAgent } from "./agent";
export type { AgentResult, AgentStep, RunAgentOptions } from "./agent";

// Retrieval seam — Increment 3
export { cosineSimilarity, MemoryVectorStore, retrieve } from "./retrieval";
export type {
  RetrievedContext,
  RetrieveOptions,
  VectorMatch,
  VectorQueryOptions,
  VectorRecord,
  VectorStore,
} from "./retrieval";

// Evals / guardrails hook — Increment 4
export { createLlmJudge, DEFAULT_JUDGE_MODEL_ID, guard } from "./evals";
export type { Eval, EvalResult, JudgeOptions } from "./evals";

// Shared vocabulary
export type {
  AgentSpan,
  AgentTracer,
  GenerateOptions,
  GenerateResult,
  LanguageModel,
  Message,
  Role,
  StopReason,
  StreamDelta,
  ToolCall,
  ToolSet,
  ToolSpec,
  Transport,
  Usage,
} from "./types";

// The AI/agent span vocabulary (ADR 0031 Phase 2, PREVIEW) — re-stated from
// `@lesto/observability`'s `agent-vocabulary` so a consumer (the estate AI route) can
// build the `Tracer`→`AgentTracer` adapter and assert the emitted span names/attributes
// without `@lesto/ai` taking an observability dependency.
export {
  AI_ERROR_CODE_ATTR,
  AI_GENERATE_SPAN,
  AI_MODEL_ATTR,
  AI_STOP_REASON_ATTR,
  AI_TOOL_NAME_ATTR,
  AI_TOOL_SPAN,
  AI_USAGE_INPUT_TOKENS_ATTR,
  AI_USAGE_OUTPUT_TOKENS_ATTR,
} from "./spans";

// Errors carry codes
export { AiError, LestoError } from "./errors";
export type { AiErrorCode } from "./errors";

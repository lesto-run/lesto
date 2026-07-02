/**
 * The shared vocabulary of the model layer.
 *
 * Everything here is provider-agnostic: a `LanguageModel` is an interface, not
 * the Anthropic client; messages and tool calls are normalized shapes the pure
 * core works on. The Anthropic-specific wire format lives entirely in
 * `anthropic.ts` behind this interface (ADR 0021, Increment 1).
 */

/** A conversational role. `tool` carries the result of a tool the model asked for. */
export type Role = "user" | "assistant";

/** A plain text segment of a turn. */
export interface TextBlock {
  readonly type: "text";
  readonly text: string;
}

/** An assistant's tool request, replayed back so the model sees its own call (carries the id to answer). */
export interface ToolUseBlock {
  readonly type: "tool_use";
  readonly id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
}

/** The result of a tool, answering a prior {@link ToolUseBlock} by its `toolUseId`. */
export interface ToolResultBlock {
  readonly type: "tool_result";
  readonly toolUseId: string;
  readonly content: string;
}

/** A structured content block — the form a turn takes once a tool exchange is replayed. */
export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

/**
 * A single turn in the conversation. Plain `string` content for an ordinary turn;
 * an array of {@link ContentBlock}s once tools are in play, so the agent loop can
 * replay the assistant's `tool_use` and answer with a `tool_result` carrying the
 * matching id — the shape the Anthropic Messages API requires for a tool round-trip.
 */
export interface Message {
  readonly role: Role;
  readonly content: string | readonly ContentBlock[];
}

/** A tool call the model emitted on a turn: which tool, the args it chose, and the call id to answer. */
export interface ToolCall {
  /** The provider's id for this call — echoed back when we feed the result in. */
  readonly id: string;
  /** The registered tool name the model wants to run. */
  readonly name: string;
  /** The arguments the model produced, as parsed JSON. Validating these is the caller's boundary concern. */
  readonly input: Record<string, unknown>;
}

/** Why the model stopped this turn. `tool_use` means it wants a tool run before continuing. */
export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";

/** Token accounting for one generation, passed straight through from the provider. */
export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** A finished, non-streamed generation. */
export interface GenerateResult {
  /** The assembled text the model produced (all text blocks concatenated). */
  readonly text: string;
  /** Any tool calls the model emitted this turn. Empty unless `stopReason === "tool_use"`. */
  readonly toolCalls: readonly ToolCall[];
  readonly stopReason: StopReason;
  readonly usage: Usage;
}

/** One delta off a streamed generation. */
export interface StreamDelta {
  /** The incremental text for this frame. */
  readonly text: string;
}

/**
 * The injected HTTP transport — the one thing that varies (ADR 0006).
 *
 * The pure core assembles a `Request` and hands it here; a real call uses global
 * `fetch`, a test passes a fake that returns canned `Response`s, so the message
 * assembly, response parsing, and stream parsing are all exercised with no
 * network. This is the `SampleSource`/`clock` injection `@lesto/bench` uses,
 * applied to HTTP.
 */
export type Transport = (request: Request) => Promise<Response>;

/**
 * A live agent span (ADR 0031 Phase 2, PREVIEW) — the small, structural surface `@lesto/ai`
 * drives: open it, populate attributes learned along the way, mark the outcome, then close it.
 * Deliberately narrower than an `@lesto/observability` `Span`, so the emitter stays trivial and
 * dependency-free.
 *
 * The span is opened BEFORE the model call (so it carries the call's real duration), with the
 * one attribute known up front — the model id — fixed at {@link AgentTracer.startSpan} time. The
 * attributes learned only AFTER the call (the parsed `Usage`/`StopReason` on success, the
 * `AiError` code on failure) ride in via {@link setAttributes}.
 */
export interface AgentSpan {
  /**
   * Populate attributes learned after the span opened — the parsed `Usage`/`StopReason` once a
   * generation completes, or the `AiError` code once it fails. **Required** (L-97b980a4): every
   * tracer must accept the bag, because a missing `setAttributes` would drop usage/stop-reason/
   * error-code silently — a permanently-untestable gap, indistinguishable from a tracer that
   * simply forgot. A tracer that genuinely wants to ignore the after-the-fact attributes writes
   * an explicit one-line no-op (`setAttributes() {}`) — visible in code, not a silent interface
   * hole. (Its faults are still isolated: `generateText`/`streamText` wrap each call in `safely`.)
   */
  setAttributes(attributes: Record<string, unknown>): void;

  /** Mark the span's outcome — `"error"` when the call threw, `"ok"` when it returned. */
  setStatus(status: "unset" | "ok" | "error"): void;

  /** Close the span. Called exactly once, on both the success and error paths. */
  end(): void;
}

/**
 * The injected tracer seam (ADR 0031 Phase 2, PREVIEW) — the ONE telemetry edge, injected
 * exactly like {@link Transport}: the pure core opens a flat-attribute span per model call
 * (`ai.generate`) and per tool run (`ai.tool`) and never reaches for a global.
 *
 * `startSpan` takes a FLAT attribute bag on purpose. A real `@lesto/observability` `Tracer`
 * does NOT satisfy this shape directly — its `startSpan(name, options)` takes a
 * `StartSpanOptions` object whose attributes live under `options.attributes`, so handing it
 * a flat bag as the 2nd arg would silently DROP every attribute. The app therefore ADAPTS
 * the `Tracer` to this seam (parenting each span on the in-flight request span — ADR 0031
 * Inc 4). Absent the seam, span emission is a clean no-op and the core is byte-unchanged.
 */
export interface AgentTracer {
  startSpan(name: string, attributes: Record<string, unknown>): AgentSpan;
}

/** Options shared by `generateText` and `streamText`. */
export interface GenerateOptions {
  readonly model: LanguageModel;
  /** The conversation so far. */
  readonly messages: readonly Message[];
  /** An optional system prompt. */
  readonly system?: string;
  /** Override the model's default id (e.g. `claude-haiku-4-5-20251001` for cheap work). */
  readonly modelId?: string;
  /** The output token ceiling for this call. */
  readonly maxTokens?: number;
  /** Tools the model may call, as a name→spec map. */
  readonly tools?: ToolSet;
  /**
   * An optional injected tracer (PREVIEW). Present → `generateText` opens one `ai.generate`
   * span per model call; absent → no telemetry, unchanged behaviour. Injected, never global.
   */
  readonly tracer?: AgentTracer;
}

/** A tool the model can call: its schema (sent to the model) and its executor (the caller's code). */
export interface ToolSpec {
  /** A human description the model reads to decide when to use the tool. */
  readonly description: string;
  /** JSON Schema for the tool's arguments, sent to the model verbatim. */
  readonly inputSchema: Record<string, unknown>;
  /**
   * Runs the tool. Receives the model-supplied args; returns a string result fed
   * back to the model. Validating `input` against `inputSchema` before acting is
   * the tool's (caller's) boundary concern (ADR 0005) — the loop passes it through.
   */
  readonly execute: (input: Record<string, unknown>) => Promise<string>;
}

/** A set of tools keyed by the name the model uses to call them. */
export type ToolSet = Readonly<Record<string, ToolSpec>>;

/**
 * A provider, normalized.
 *
 * It owns exactly two things: the wire format (build a provider `Request` from
 * normalized options; parse a provider `Response` into a `GenerateResult` /
 * stream of `StreamDelta`) and the transport it sends over. Everything else —
 * the agent loop, retrieval, evals — is provider-agnostic logic on top.
 */
export interface LanguageModel {
  /** The model id used when a call does not override it. */
  readonly defaultModelId: string;
  /** Build the provider HTTP request for a non-streamed generation. Pure. */
  buildRequest(options: GenerateOptions): Request;
  /** Build the provider HTTP request for a streamed generation. Pure. */
  buildStreamRequest(options: GenerateOptions): Request;
  /** Parse a non-streamed provider response into a normalized result. */
  parseResponse(response: Response): Promise<GenerateResult>;
  /** Parse a streamed provider response into normalized text deltas. */
  parseStream(response: Response): AsyncIterable<StreamDelta>;
  /** The transport this model sends over (injected; defaults to `fetch`). */
  readonly transport: Transport;
}

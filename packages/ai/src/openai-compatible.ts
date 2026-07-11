/**
 * The OpenAI chat-completions API, behind the `LanguageModel` interface.
 *
 * This is the second concrete provider (ADR 0021 §1: "a second provider is
 * additive, not a refactor"), sitting alongside `anthropic.ts` behind the exact
 * same interface. It is deliberately a screen of `fetch`-shaped code rather than a
 * vendored `openai` / `ai` SDK — the same call `anthropic.ts` makes, and the same
 * call `@lesto/auth` makes doing TOTP over `node:crypto` (ADR 0020). The transport
 * is injected (defaults to global `fetch`) so request building, response parsing,
 * and SSE stream parsing are all unit-testable without a network, and the package
 * stays edge-portable (no Node-only SDK globals).
 *
 * Why this one adapter matters: LM Studio, Ollama, vLLM, LiteLLM, OpenRouter — and
 * OpenAI itself — all speak the OpenAI chat-completions wire format. So this single
 * file unlocks **local models and any OpenAI-compatible provider** through the same
 * `generateText` / `streamText` / `runAgent` core, with zero new dependencies.
 *
 *   // A local LM Studio server (any model it has loaded):
 *   const model = createOpenAICompatible({
 *     baseURL: "http://localhost:1234/v1",
 *     defaultModelId: "local-model",
 *   });
 *   const { text } = await generateText({ model, messages: [{ role: "user", content: "Hi" }] });
 *
 *   // Ollama's OpenAI-compatible endpoint:
 *   createOpenAICompatible({ baseURL: "http://localhost:11434/v1", defaultModelId: "llama3.2" });
 *
 *   // OpenAI itself (chat-completions models — see the `max_tokens` caveat on that field below):
 *   createOpenAICompatible({ baseURL: "https://api.openai.com/v1", apiKey: env.OPENAI_API_KEY, defaultModelId: "gpt-4o-mini" });
 *
 * The normalized vocabulary (`Message`, `ToolCall`, `StopReason`, `Usage`) is
 * Anthropic-shaped (ADR 0021, Increment 1); this adapter's job is to map the OpenAI
 * wire format onto it. The two shapes differ in three places worth calling out, all
 * handled here: OpenAI carries the system prompt as a leading `role: "system"`
 * message (not a top-level field); it answers each tool call with a separate
 * `role: "tool"` message (so one normalized tool-result *user turn* fans out to N of
 * them); and it encodes tool-call `input` as a JSON **string** (`arguments`) rather
 * than a JSON object — a string that can itself be malformed (`AI_RESPONSE_MALFORMED`).
 */

import { AiError } from "./errors";
import { parseSseStream } from "./sse";

import type { ParsedFrame } from "./sse";
import type {
  ContentBlock as MessageBlock,
  GenerateOptions,
  GenerateResult,
  LanguageModel,
  Message,
  StopReason,
  StreamDelta,
  StreamFinal,
  ToolCall,
  Transport,
  Usage,
} from "./types";

/** A sensible output ceiling when a call does not name one — mirrors `anthropic.ts`. */
const DEFAULT_MAX_TOKENS = 1024;

export interface OpenAICompatibleConfig {
  /**
   * The API base URL, up to and including the version segment — e.g.
   * `https://api.openai.com/v1`, `http://localhost:1234/v1` (LM Studio),
   * `http://localhost:11434/v1` (Ollama). `/chat/completions` is appended.
   */
  readonly baseURL: string;
  /**
   * The default model id when a call does not override it. **Required** and
   * deliberately un-defaulted: an OpenAI-compatible endpoint has no universal
   * default model (LM Studio serves whatever it loaded; Ollama/vLLM need the exact
   * served name), so naming it is the caller's — never a hidden guess (ADR 0021:
   * "the model is always an explicit field, never a hidden global").
   */
  readonly defaultModelId: string;
  /**
   * The API key, sent as `Authorization: Bearer <key>`. Optional: local servers
   * (LM Studio, Ollama) accept any key or none, so it is omitted from the headers
   * when absent rather than sent empty.
   */
  readonly apiKey?: string;
  /**
   * Extra headers merged onto every request — the seam providers like OpenRouter
   * need (`HTTP-Referer`, `X-Title`) or a gateway's auth header. Merged after the defaults.
   */
  readonly headers?: Readonly<Record<string, string>>;
  /** The HTTP transport. Defaults to global `fetch`; inject a fake in tests. */
  readonly transport?: Transport;
}

/**
 * Build a normalized `LanguageModel` over any OpenAI chat-completions-compatible endpoint.
 *
 *   const model = createOpenAICompatible({ baseURL: "http://localhost:1234/v1", defaultModelId: "local-model" });
 *
 * Pass `transport` to drive the pure core off canned responses with no network.
 */
export function createOpenAICompatible(config: OpenAICompatibleConfig): LanguageModel {
  const transport = config.transport ?? ((request) => fetch(request));
  const defaultModelId = config.defaultModelId;

  // Join base + path with exactly one slash regardless of a trailing slash on baseURL.
  const url = `${config.baseURL.replace(/\/+$/, "")}/chat/completions`;

  const headers = (): Record<string, string> => ({
    "content-type": "application/json",
    ...(config.apiKey === undefined ? {} : { authorization: `Bearer ${config.apiKey}` }),
    ...config.headers,
  });

  // The request body is identical for streamed and non-streamed calls except for the
  // `stream` flag (and, when streaming, asking the server to include a final usage
  // chunk) — assembling it once keeps the two builders honest.
  const body = (options: GenerateOptions, stream: boolean): string => {
    const payload: Record<string, unknown> = {
      model: options.modelId ?? defaultModelId,
      // NOTE: OpenAI's reasoning models (o-series and successors) reject `max_tokens` and
      // require `max_completion_tokens` — a call against one 400s (loud, `AI_HTTP_ERROR`,
      // not silent). `max_tokens` is correct for chat-completions models and every local
      // target (LM Studio/Ollama/vLLM). A per-model field-name policy is tracked as a follow-up.
      max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: toWireMessages(options.system, options.messages),
      stream,
    };

    // OpenAI omits usage from a stream unless asked; request the terminal usage chunk
    // so a streamed call reports the same `Usage` a non-streamed one does. Current
    // mainstream servers (LM Studio/Ollama/vLLM/LiteLLM/OpenRouter) accept or ignore it;
    // a strict server that rejects it fails loud as `AI_HTTP_ERROR` (never a silent zero).
    if (stream) {
      payload["stream_options"] = { include_usage: true };
    }

    if (options.tools !== undefined) {
      payload["tools"] = Object.entries(options.tools).map(([name, tool]) => ({
        type: "function",
        function: { name, description: tool.description, parameters: tool.inputSchema },
      }));
    }

    return JSON.stringify(payload);
  };

  return {
    defaultModelId,
    transport,

    buildRequest(options) {
      return new Request(url, { method: "POST", headers: headers(), body: body(options, false) });
    },

    buildStreamRequest(options) {
      return new Request(url, { method: "POST", headers: headers(), body: body(options, true) });
    },

    parseResponse,
    parseStream,
  };
}

/**
 * Assemble the OpenAI `messages` array from the normalized system prompt + turns.
 *
 * Three normalized→wire mappings live here (the shapes that differ from Anthropic):
 *  - the `system` prompt becomes a leading `{ role: "system" }` message;
 *  - an assistant turn's `tool_use` blocks become the message's `tool_calls` array
 *    (with `input` re-encoded to the `arguments` JSON string);
 *  - a user turn's `tool_result` blocks each become a *separate* `{ role: "tool" }`
 *    message — one normalized turn fans out to N, since OpenAI answers each call individually.
 */
function toWireMessages(
  system: string | undefined,
  messages: readonly Message[],
): Record<string, unknown>[] {
  const wire: Record<string, unknown>[] = [];

  if (system !== undefined) {
    wire.push({ role: "system", content: system });
  }

  for (const message of messages) {
    // A plain string turn rides through unchanged.
    if (typeof message.content === "string") {
      wire.push({ role: message.role, content: message.content });
      continue;
    }

    if (message.role === "assistant") {
      wire.push(assistantWireMessage(message.content));
      continue;
    }

    // A user turn of blocks: each `tool_result` is its own `role: "tool"` message; any
    // text block rides as an ordinary user message. The agent loop only ever emits
    // tool_result here, but we map per-block so a hand-built mixed turn is honored — and
    // we emit ALL tool_result messages BEFORE any text, because OpenAI requires every
    // `role: "tool"` message to immediately follow the assistant `tool_calls` turn; a
    // user message interposed between them is a 400. Array order alone could violate that.
    for (const block of message.content) {
      if (block.type === "tool_result") {
        wire.push({ role: "tool", tool_call_id: block.toolUseId, content: block.content });
      }
    }

    for (const block of message.content) {
      if (block.type === "text") {
        wire.push({ role: "user", content: block.text });
      }
    }
  }

  return wire;
}

/**
 * One assistant turn of content blocks → an OpenAI assistant message. Text blocks are
 * concatenated into `content` (null when empty — the shape OpenAI wants for a pure
 * tool-call turn); `tool_use` blocks become the `tool_calls` array.
 */
function assistantWireMessage(blocks: readonly MessageBlock[]): Record<string, unknown> {
  const text = blocks
    .filter((block): block is Extract<MessageBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("");

  const toolUses = blocks.filter(
    (block): block is Extract<MessageBlock, { type: "tool_use" }> => block.type === "tool_use",
  );

  const message: Record<string, unknown> = {
    role: "assistant",
    content: text === "" ? null : text,
  };

  if (toolUses.length > 0) {
    message["tool_calls"] = toolUses.map((block) => ({
      id: block.id,
      type: "function",
      function: { name: block.name, arguments: JSON.stringify(block.input) },
    }));
  }

  return message;
}

/**
 * Parse a non-streamed chat-completions response into a normalized {@link GenerateResult}.
 *
 * A non-2xx is the loud failure: `AI_HTTP_ERROR` with the status in `details`, so the
 * boundary branches on the code and the status, never on the message string.
 *
 * Two `AI_RESPONSE_MALFORMED` refusals guard the 2xx path — the failure modes unique to
 * this wire format: a body that is not JSON, or a 2xx with no choice/message (the
 * error-shaped 200 some OpenAI-compatible gateways return). Both are refused loudly
 * rather than fabricating an empty `end_turn` completion the agent loop would read as
 * "the model said nothing" — the fail-open a bare optional-chain would leave. A tool
 * call whose `arguments` string is not a JSON object is the third (Anthropic sends tool
 * input as a real object, so it has none of these).
 */
async function parseResponse(response: Response): Promise<GenerateResult> {
  if (!response.ok) {
    throw new AiError("AI_HTTP_ERROR", `OpenAI-compatible endpoint responded ${response.status}.`, {
      status: response.status,
    });
  }

  let json: ChatCompletion;

  try {
    json = (await response.json()) as ChatCompletion;
  } catch {
    throw new AiError("AI_RESPONSE_MALFORMED", "Response body was not valid JSON.");
  }

  const message = json.choices?.[0]?.message;

  if (message === undefined) {
    throw new AiError("AI_RESPONSE_MALFORMED", "Response carried no choice/message to parse.");
  }

  const text = message.content ?? "";

  const toolCalls: ToolCall[] = (message.tool_calls ?? [])
    .filter((call) => call.type === "function" && call.function !== undefined)
    .map((call) => ({
      id: call.id,
      name: call.function.name,
      input: parseArguments(call.function.arguments),
    }));

  return {
    text,
    toolCalls,
    stopReason: normalizeFinishReason(json.choices?.[0]?.finish_reason),
    usage: normalizeUsage(json.usage),
  };
}

/**
 * Parse a chat-completions SSE stream into normalized text deltas, returning the final
 * {@link StreamFinal} (usage + stop reason) once the stream drains.
 *
 * The stream is a sequence of `data: <json>\n\n` frames terminated by `data: [DONE]`.
 * Text rides on `choices[0].delta.content` (yielded); the stop reason on
 * `choices[0].finish_reason`, and — because we asked with `stream_options.include_usage`
 * — the token accounting on a terminal chunk whose `choices` is empty and `usage` is set.
 * The meta is folded into the returned value rather than yielded, so a `for-await`
 * consumer sees only text — the exact contract `anthropic.ts` holds. The parser is a
 * pure async transform over the response's `ReadableStream<Uint8Array>` — fed a canned
 * stream in tests, asserting the exact deltas AND the final accounting, with no network.
 *
 * A non-2xx fails loud as `AI_HTTP_ERROR`; a frame whose `data:` is present but not JSON
 * fails as `AI_STREAM_MALFORMED` rather than silently dropping tokens. A torn final frame
 * (a dropped connection mid-frame) is tolerated quietly — the stream just ended early.
 */
function parseStream(response: Response): AsyncGenerator<StreamDelta, StreamFinal | undefined> {
  return parseSseStream(response, interpretFrame, "OpenAI-compatible endpoint");
}

/**
 * Map one parsed chat-completions chunk to a {@link ParsedFrame}: any combination of a text token
 * (`choices[0].delta.content`), the stop reason (`choices[0].finish_reason`), and the token usage
 * (the terminal `stream_options.include_usage` chunk whose `choices` is empty). Unlike Anthropic's
 * text-XOR-meta frames, an OpenAI chunk can legitimately carry a content delta AND a `finish_reason`
 * together, so every meaningful field is captured additively. A frame that carries nothing (a
 * role-only opening delta) returns an empty bag the engine skips. Pure and total; never throws.
 */
function interpretFrame(json: unknown): ParsedFrame | undefined {
  const chunk = json as ChatCompletionChunk;

  const choice = chunk.choices?.[0];
  const parsed: {
    text?: string;
    inputTokens?: number;
    outputTokens?: number;
    stopReason?: StopReason;
  } = {};

  // The incremental text token. Only a non-empty string is a delta worth yielding — the
  // opening `{ role: "assistant" }` chunk carries `content: ""` (or none), which is not a token.
  const content = choice?.delta?.content;
  if (typeof content === "string" && content !== "") {
    parsed.text = content;
  }

  // The stop reason lands on the last content-bearing chunk; the usage on a later terminal
  // chunk (empty `choices`) because we asked with `stream_options.include_usage`.
  if (choice?.finish_reason != null) {
    parsed.stopReason = normalizeFinishReason(choice.finish_reason);
  }

  if (chunk.usage != null) {
    if (chunk.usage.prompt_tokens !== undefined) parsed.inputTokens = chunk.usage.prompt_tokens;
    if (chunk.usage.completion_tokens !== undefined) {
      parsed.outputTokens = chunk.usage.completion_tokens;
    }
  }

  // A role-only opening delta yields an empty bag; the shared engine treats `{}` as a skip
  // (identical to `undefined`), so no explicit collapse is needed here.
  return parsed;
}

/**
 * Parse a tool call's `arguments` JSON string into the normalized object `input`.
 *
 * An empty (or whitespace-only) string is a no-arg tool call → `{}` (legitimate; OpenAI
 * emits `""` for a tool that takes no arguments). A non-empty string that is not a JSON
 * *object* is a malformed provider response → `AI_RESPONSE_MALFORMED`, never a silent `{}`.
 */
function parseArguments(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined || raw.trim() === "") {
    return {};
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AiError("AI_RESPONSE_MALFORMED", "Tool call arguments were not valid JSON.", {
      arguments: raw,
    });
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AiError("AI_RESPONSE_MALFORMED", "Tool call arguments were not a JSON object.", {
      arguments: raw,
    });
  }

  return parsed as Record<string, unknown>;
}

/** Map OpenAI's `finish_reason` onto our stop-reason union, defaulting unknowns to `end_turn`. */
function normalizeFinishReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "length":
      return "max_tokens";
    default:
      // "stop", "content_filter", null, or anything unrecognized: the turn ended.
      return "end_turn";
  }
}

/** Normalize the provider's usage block, tolerating missing counts as zero. */
function normalizeUsage(usage: ChatUsage | undefined): Usage {
  return {
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
  };
}

// ── OpenAI chat-completions wire shapes (the only place they appear) ─────────

interface ChatToolCall {
  readonly id: string;
  readonly type: string;
  readonly function: { readonly name: string; readonly arguments?: string };
}

interface ChatUsage {
  readonly prompt_tokens?: number;
  readonly completion_tokens?: number;
}

interface ChatCompletion {
  readonly choices?: readonly {
    readonly message?: {
      readonly content?: string | null;
      readonly tool_calls?: readonly ChatToolCall[];
    };
    readonly finish_reason?: string | null;
  }[];
  readonly usage?: ChatUsage;
}

interface ChatCompletionChunk {
  readonly choices?: readonly {
    readonly delta?: { readonly content?: string | null };
    readonly finish_reason?: string | null;
  }[];
  readonly usage?: ChatUsage | null;
}

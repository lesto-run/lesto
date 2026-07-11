/**
 * The Anthropic Messages API, behind the `LanguageModel` interface.
 *
 * This is the ONLY file that knows the Anthropic wire format. It is deliberately
 * a screen of `fetch`-shaped code rather than a vendored `@anthropic-ai/sdk` —
 * the same call `@lesto/auth` makes doing TOTP over `node:crypto` (ADR 0020).
 * The transport is injected (defaults to global `fetch`) so request building,
 * response parsing, and SSE stream parsing are all unit-testable without a
 * network and the package stays edge-portable (no Node-only SDK globals).
 *
 * The current Claude models (ADR 0021): Opus 4.8 `claude-opus-4-8`, Sonnet 4.6
 * `claude-sonnet-4-6`, Haiku 4.5 `claude-haiku-4-5-20251001`, Fable 5
 * `claude-fable-5`. The default below is Opus 4.8.
 */

import { AiError } from "./errors";
import { parseSseStream } from "./sse";

import type { ParsedFrame } from "./sse";
import type {
  ContentBlock as MessageBlock,
  GenerateOptions,
  GenerateResult,
  LanguageModel,
  StopReason,
  StreamDelta,
  StreamFinal,
  ToolCall,
  Transport,
  Usage,
} from "./types";

const MESSAGES_URL = "https://api.anthropic.com/v1/messages";

const ANTHROPIC_VERSION = "2023-06-01";

/** The default model: current Claude Opus (ADR 0021). */
export const DEFAULT_MODEL_ID = "claude-opus-4-8";

/** A sensible output ceiling when a call does not name one. */
const DEFAULT_MAX_TOKENS = 1024;

export interface AnthropicConfig {
  /** The Anthropic API key. */
  readonly apiKey: string;
  /** Override the default model id (`claude-opus-4-8`). */
  readonly defaultModelId?: string;
  /** The HTTP transport. Defaults to global `fetch`; inject a fake in tests. */
  readonly transport?: Transport;
}

/**
 * Build a normalized `LanguageModel` over the Anthropic Messages API.
 *
 *   const model = createAnthropic({ apiKey: env.ANTHROPIC_API_KEY });
 *
 * Pass `transport` to drive the pure core off canned responses with no network.
 */
export function createAnthropic(config: AnthropicConfig): LanguageModel {
  const transport = config.transport ?? ((request) => fetch(request));
  const defaultModelId = config.defaultModelId ?? DEFAULT_MODEL_ID;

  const headers = (): Record<string, string> => ({
    "content-type": "application/json",
    "x-api-key": config.apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
  });

  // The request body is identical for streamed and non-streamed calls except for
  // the `stream` flag — assembling it once keeps the two builders honest.
  const body = (options: GenerateOptions, stream: boolean): string => {
    const payload: Record<string, unknown> = {
      model: options.modelId ?? defaultModelId,
      max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: options.messages.map((m) => ({
        role: m.role,
        // A string turn rides through; a block turn (a replayed tool exchange) is
        // serialized to the Anthropic content-block wire format, with `tool_use_id`
        // threaded so the API can pair each result to the call it answers.
        content: typeof m.content === "string" ? m.content : m.content.map(serializeBlock),
      })),
      stream,
    };

    if (options.system !== undefined) {
      payload["system"] = options.system;
    }

    if (options.tools !== undefined) {
      payload["tools"] = Object.entries(options.tools).map(([name, tool]) => ({
        name,
        description: tool.description,
        input_schema: tool.inputSchema,
      }));
    }

    return JSON.stringify(payload);
  };

  return {
    defaultModelId,
    transport,

    buildRequest(options) {
      return new Request(MESSAGES_URL, {
        method: "POST",
        headers: headers(),
        body: body(options, false),
      });
    },

    buildStreamRequest(options) {
      return new Request(MESSAGES_URL, {
        method: "POST",
        headers: headers(),
        body: body(options, true),
      });
    },

    parseResponse,
    parseStream,
  };
}

/** Serialize one normalized content block to the Anthropic request wire shape. */
function serializeBlock(block: MessageBlock): Record<string, unknown> {
  switch (block.type) {
    case "tool_use":
      return { type: "tool_use", id: block.id, name: block.name, input: block.input };
    case "tool_result":
      return { type: "tool_result", tool_use_id: block.toolUseId, content: block.content };
    default:
      return { type: "text", text: block.text };
  }
}

/**
 * Parse a non-streamed Messages response into a normalized {@link GenerateResult}.
 *
 * A non-2xx is the loud failure: `AI_HTTP_ERROR` with the status in `details`, so
 * the boundary branches on the code and the status, never on the message string.
 *
 * Two `AI_RESPONSE_MALFORMED` refusals guard the 2xx path (mirroring `openai-compatible.ts`):
 * a body that is not JSON (a misconfigured proxy/gateway returning a 200 with an HTML/text
 * body), or a 2xx with no `content` array (an error-shaped 200). Both are refused loudly rather
 * than throwing an uncoded `SyntaxError`/`TypeError` the boundary can't branch on. An EMPTY
 * `content` array is legitimate (yields `text: ""`), so the guard is `Array.isArray`, not presence.
 */
export async function parseResponse(response: Response): Promise<GenerateResult> {
  if (!response.ok) {
    throw new AiError("AI_HTTP_ERROR", `Anthropic responded ${response.status}.`, {
      status: response.status,
    });
  }

  let json: AnthropicMessage;

  try {
    json = (await response.json()) as AnthropicMessage;
  } catch {
    throw new AiError("AI_RESPONSE_MALFORMED", "Response body was not valid JSON.");
  }

  if (!Array.isArray(json.content)) {
    throw new AiError("AI_RESPONSE_MALFORMED", "Response carried no content array to parse.");
  }

  const text = json.content
    .filter((block): block is TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");

  const toolCalls: ToolCall[] = json.content
    .filter((block): block is ToolUseBlock => block.type === "tool_use")
    .map((block) => ({ id: block.id, name: block.name, input: block.input }));

  return {
    text,
    toolCalls,
    stopReason: normalizeStopReason(json.stop_reason),
    usage: normalizeUsage(json.usage),
  };
}

/**
 * Parse the Messages SSE stream into normalized text deltas, returning the final
 * {@link StreamFinal} (usage + stop reason) once the stream drains.
 *
 * The stream lifecycle — HTTP/body refusal, the `\n\n` frame loop, `data:` extraction, the
 * `[DONE]` skip, `JSON.parse`→`AI_STREAM_MALFORMED`, torn-final tolerance, the both-counts return
 * discipline, and reader cleanup — lives in the shared {@link parseSseStream} engine. This provider
 * supplies only {@link interpretFrame}. Text rides on `content_block_delta`/`text_delta` frames;
 * the token accounting rides out-of-band on `message_start` (input tokens) and `message_delta`
 * (output tokens + stop reason), folded into the returned value rather than yielded — so a
 * `for-await` consumer sees only text.
 */
export function parseStream(
  response: Response,
): AsyncGenerator<StreamDelta, StreamFinal | undefined> {
  return parseSseStream(response, interpretFrame, "Anthropic");
}

/**
 * Map one parsed Anthropic stream event to a {@link ParsedFrame}: a text token
 * (`content_block_delta`/`text_delta`), a tool-call fragment (`content_block_start` announces a
 * `tool_use` block's id + name; `content_block_delta`/`input_json_delta` carries its argument-JSON
 * chunks — F5), the input tokens (`message_start`), or the output tokens + stop reason
 * (`message_delta`). Any other event (a text-block `content_block_start`, `content_block_stop`,
 * `ping`, `message_stop`, …) contributes nothing (`{}`/`undefined`). The tool-call FRAGMENTS are
 * accumulated (and their args parsed) by the shared engine, so this stays pure and total; never
 * throws (the engine owns JSON parsing).
 */
function interpretFrame(json: unknown): ParsedFrame | undefined {
  const event = json as AnthropicStreamEvent;

  if (
    event.type === "content_block_delta" &&
    event.delta?.type === "text_delta" &&
    event.delta.text !== undefined
  ) {
    return { text: event.delta.text };
  }

  // A tool_use block is announced on `content_block_start` (its id + name; the `input` here is an
  // empty placeholder — the real arguments stream as `input_json_delta` frames below). A text-block
  // `content_block_start` and every other block kind contribute nothing here.
  if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
    return {
      toolCalls: [
        { index: event.index ?? 0, id: event.content_block.id, name: event.content_block.name },
      ],
    };
  }

  // The tool arguments stream as partial-JSON chunks on `content_block_delta`/`input_json_delta`,
  // under the SAME block `index` as the announce above — concatenated (and parsed once) by the engine.
  if (
    event.type === "content_block_delta" &&
    event.delta?.type === "input_json_delta" &&
    event.delta.partial_json !== undefined
  ) {
    return { toolCalls: [{ index: event.index ?? 0, argsFragment: event.delta.partial_json }] };
  }

  // The prompt (input) token count arrives up front on `message_start`. Its `usage` ALSO carries a
  // small INITIAL `output_tokens` (typically 1–4) — deliberately ignored: the authoritative final
  // cumulative output count lands on `message_delta` below. Reading it here would defeat the
  // torn-stream guard (a stream cut after `message_start` would report a misleadingly-tiny output
  // instead of withholding usage), so `message_start` contributes input tokens only.
  if (event.type === "message_start") {
    const inputTokens = event.message?.usage?.input_tokens;
    return inputTokens === undefined ? {} : { inputTokens };
  }

  // The final cumulative output count + the stop reason arrive on `message_delta`.
  if (event.type === "message_delta") {
    const outputTokens = event.usage?.output_tokens;
    return {
      ...(outputTokens === undefined ? {} : { outputTokens }),
      ...(event.delta?.stop_reason == null
        ? {}
        : { stopReason: normalizeStopReason(event.delta.stop_reason) }),
    };
  }

  return undefined;
}

/** Map the provider's stop reason onto our union, defaulting unknowns to `end_turn`. */
function normalizeStopReason(reason: string | null): StopReason {
  switch (reason) {
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "stop_sequence":
      return "stop_sequence";
    default:
      return "end_turn";
  }
}

/** Normalize the provider's usage block, tolerating missing counts as zero. */
function normalizeUsage(usage: AnthropicUsage | undefined): Usage {
  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
  };
}

// ── Anthropic wire shapes (the only place they appear) ──────────────────────

interface TextBlock {
  readonly type: "text";
  readonly text: string;
}

interface ToolUseBlock {
  readonly type: "tool_use";
  readonly id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
}

type ContentBlock = TextBlock | ToolUseBlock | { readonly type: string };

interface AnthropicUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
}

interface AnthropicMessage {
  readonly content: readonly ContentBlock[];
  readonly stop_reason: string | null;
  readonly usage?: AnthropicUsage;
}

interface AnthropicStreamEvent {
  readonly type: string;
  /** On `content_block_*` events: which content block this frame belongs to (0-based). */
  readonly index?: number;
  /**
   * `text_delta` carries the token text; `input_json_delta` carries a `partial_json` chunk of a
   * tool call's arguments; `message_delta` carries the final `stop_reason`.
   */
  readonly delta?: {
    readonly type?: string;
    readonly text?: string;
    readonly partial_json?: string;
    readonly stop_reason?: string | null;
  };
  /** On `content_block_start`: the block being opened — a `tool_use` block carries its id + name. */
  readonly content_block?: {
    readonly type?: string;
    readonly id?: string;
    readonly name?: string;
  };
  /** On `message_start`: the opening message, whose `usage` carries the prompt (input) token count. */
  readonly message?: { readonly usage?: AnthropicUsage };
  /** On `message_delta`: the final cumulative `usage` (output token count). */
  readonly usage?: AnthropicUsage;
}

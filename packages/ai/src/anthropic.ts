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
 */
export async function parseResponse(response: Response): Promise<GenerateResult> {
  if (!response.ok) {
    throw new AiError("AI_HTTP_ERROR", `Anthropic responded ${response.status}.`, {
      status: response.status,
    });
  }

  const json = (await response.json()) as AnthropicMessage;

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
 * The stream is a sequence of `event: <type>\n data: <json>\n\n` frames. Text rides on
 * `content_block_delta`/`text_delta` frames (yielded); the token accounting rides out-of-band on
 * `message_start` (input tokens) and `message_delta` (output tokens + stop reason), which are
 * folded into the returned value rather than yielded — so a `for-await` consumer sees only text.
 * The parser is a pure async transform over the response's `ReadableStream<Uint8Array>` — fed a
 * canned stream in tests, asserting the exact deltas AND the final accounting, with no network.
 *
 * A non-2xx fails loud as `AI_HTTP_ERROR`; a frame whose `data:` is not JSON
 * fails as `AI_STREAM_MALFORMED` rather than silently dropping tokens.
 */
export async function* parseStream(
  response: Response,
): AsyncGenerator<StreamDelta, StreamFinal | undefined> {
  if (!response.ok) {
    throw new AiError("AI_HTTP_ERROR", `Anthropic responded ${response.status}.`, {
      status: response.status,
    });
  }

  if (response.body === null) {
    throw new AiError("AI_STREAM_MALFORMED", "Streaming response had no body.");
  }

  const decoder = new TextDecoder();
  let buffer = "";

  const reader = response.body.getReader();

  // The token accounting Anthropic reports out-of-band, folded in as the meta frames arrive. Left
  // undefined until seen, so a torn stream that never delivered them is distinguishable from a
  // reported zero (the former returns `undefined`; the latter, real zeros).
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let stopReason: StopReason | undefined;

  const absorb = (meta: Extract<ParsedFrame, { kind: "meta" }>): void => {
    if (meta.inputTokens !== undefined) inputTokens = meta.inputTokens;
    if (meta.outputTokens !== undefined) outputTokens = meta.outputTokens;
    if (meta.stopReason !== undefined) stopReason = meta.stopReason;
  };

  try {
    // Read chunks, accumulate, and emit one delta per complete `\n\n`-terminated
    // frame. A partial frame stays in the buffer until the next chunk completes it,
    // so a token split across two network reads is never lost or double-counted.
    for (;;) {
      const { done, value } = await reader.read();

      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf("\n\n");

      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        const parsed = parseFrame(frame);

        if (parsed?.kind === "text") yield { text: parsed.text };
        else if (parsed?.kind === "meta") absorb(parsed);

        boundary = buffer.indexOf("\n\n");
      }
    }

    // Flush a final frame the stream closed WITHOUT a trailing blank line — recovering a
    // complete-but-unterminated last delta the loop's `\n\n` scan would otherwise drop.
    // Unlike a mid-stream frame, this trailing remainder can also be a TORN frame from an
    // aborted/dropped connection (incomplete JSON): tolerate that quietly — the stream just
    // ended early, so end with the deltas already yielded rather than raising
    // AI_STREAM_MALFORMED on a truncation. A malformed frame mid-stream still throws (above).
    buffer += decoder.decode();

    let last: ParsedFrame | undefined;
    try {
      last = parseFrame(buffer);
    } catch {
      last = undefined;
    }

    if (last?.kind === "text") yield { text: last.text };
    else if (last?.kind === "meta") absorb(last);

    // Surface the final accounting as the generator's RETURN value (`streamText` reads it via
    // `yield*`). `usage` is reported ONLY when BOTH counts genuinely arrived — never a fabricated
    // zero: a stream torn after `message_start` (input seen) but before `message_delta` (output
    // lost) reports no usage, exactly the "never received" case `ai.streaming = true` marks as
    // expected. When nothing meaningful arrived at all, the whole value is `undefined`.
    if (inputTokens !== undefined && outputTokens !== undefined) {
      return {
        usage: { inputTokens, outputTokens },
        ...(stopReason === undefined ? {} : { stopReason }),
      };
    }

    return stopReason === undefined ? undefined : { stopReason };
  } finally {
    // Release the reader / cancel the upstream body on EVERY exit — a normal drain, a thrown
    // frame, AND an early `for-await` `break` (which resumes the generator here via its
    // `return()`). Without this the locked reader and its underlying socket leak whenever a
    // consumer stops early — a common pattern for streamed output. `cancel()` on an
    // already-closed stream is a no-op; swallow any rejection so cleanup never masks the result.
    await reader.cancel().catch(() => {});
  }
}

/**
 * Turn one SSE frame into a {@link ParsedFrame}: a `text` token, a `meta` frame (`message_start`
 * → input tokens; `message_delta` → output tokens + stop reason), or `undefined` for a frame we
 * ignore (`content_block_start`, `ping`, `message_stop`, …).
 *
 * A `data:` line that is present but not valid JSON is malformed — refused
 * loudly. The terminal `data: [DONE]` sentinel some providers send is ignored.
 */
function parseFrame(frame: string): ParsedFrame | undefined {
  const dataLine = frame.split("\n").find((line) => line.startsWith("data:"));

  if (dataLine === undefined) {
    return undefined;
  }

  const raw = dataLine.slice("data:".length).trim();

  if (raw === "" || raw === "[DONE]") {
    return undefined;
  }

  let event: AnthropicStreamEvent;

  try {
    event = JSON.parse(raw) as AnthropicStreamEvent;
  } catch {
    throw new AiError("AI_STREAM_MALFORMED", "Stream frame data was not valid JSON.", { frame });
  }

  if (
    event.type === "content_block_delta" &&
    event.delta?.type === "text_delta" &&
    event.delta.text !== undefined
  ) {
    return { kind: "text", text: event.delta.text };
  }

  // The prompt (input) token count arrives up front on `message_start`. Its `usage` ALSO carries a
  // small INITIAL `output_tokens` (typically 1–4) — deliberately ignored: the authoritative final
  // cumulative output count lands on `message_delta` below. Reading it here would defeat the
  // torn-stream guard (a stream cut after `message_start` would report a misleadingly-tiny output
  // instead of withholding usage), so `message_start` contributes input tokens only.
  if (event.type === "message_start") {
    const inputTokens = event.message?.usage?.input_tokens;
    return inputTokens === undefined ? { kind: "meta" } : { kind: "meta", inputTokens };
  }

  // The final cumulative output count + the stop reason arrive on `message_delta`.
  if (event.type === "message_delta") {
    const outputTokens = event.usage?.output_tokens;
    return {
      kind: "meta",
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
  /** `text_delta` carries the token text; `message_delta` carries the final `stop_reason`. */
  readonly delta?: {
    readonly type?: string;
    readonly text?: string;
    readonly stop_reason?: string | null;
  };
  /** On `message_start`: the opening message, whose `usage` carries the prompt (input) token count. */
  readonly message?: { readonly usage?: AnthropicUsage };
  /** On `message_delta`: the final cumulative `usage` (output token count). */
  readonly usage?: AnthropicUsage;
}

/**
 * One interpreted stream frame: a text token to yield, or a `meta` frame carrying the token/stop
 * accounting Anthropic reports out-of-band (`message_start` → input tokens; `message_delta` →
 * output tokens + stop reason). {@link parseStream} yields the text and folds the meta into the
 * {@link StreamFinal} it returns. Frames we don't care about parse to `undefined`.
 */
type ParsedFrame =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "meta";
      readonly inputTokens?: number;
      readonly outputTokens?: number;
      readonly stopReason?: StopReason;
    };

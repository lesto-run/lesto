/**
 * `generateText` / `streamText` — the model-layer keystone (ADR 0021, Increment 1).
 *
 * Both are deliberately thin: the model builds the provider request (pure), the
 * injected transport sends it, the model parses the response (pure). All the
 * opinion lives in the provider behind the `LanguageModel` interface; this file
 * is just the send. That split is what lets a test drive the whole path off a
 * fake transport with no network.
 */

import { AiError } from "./errors";
import {
  AI_ERROR_CODE_ATTR,
  AI_GENERATE_SPAN,
  AI_MODEL_ATTR,
  AI_STOP_REASON_ATTR,
  AI_USAGE_INPUT_TOKENS_ATTR,
  AI_USAGE_OUTPUT_TOKENS_ATTR,
} from "./spans";

import type { GenerateOptions, GenerateResult, StreamDelta } from "./types";

/**
 * Generate a single, non-streamed completion.
 *
 *   const { text } = await generateText({ model, messages });
 *
 * Returns the assembled text, any tool calls, the stop reason, and token usage.
 * Throws `AI_HTTP_ERROR` (coded, status in `details`) on a non-2xx.
 *
 * When an `AgentTracer` is injected (ADR 0031 Phase 2, PREVIEW), each call emits one
 * `ai.generate` span. The span is opened **before** the model call — with the one attribute
 * known up front, the model id — so it wraps the request build, the transport round-trip, and
 * the parse: it carries the call's **real duration**, not a point-in-time record. The parsed
 * `Usage`/`StopReason` (or, on failure, the `AiError` code) are populated **after** the call via
 * {@link AgentSpan.setAttributes}, then the span is marked `ok`/`error` and closed. Absent a
 * tracer this is the exact original send — no span, no overhead.
 */
export async function generateText(options: GenerateOptions): Promise<GenerateResult> {
  const { tracer } = options;

  // Open BEFORE the call so the span carries the generation's real latency; the model id is the
  // only attribute known up front. A minimal tracer without `setAttributes` still gets the span,
  // its duration, and its status — just not the after-the-fact token/stop-reason attributes.
  const span = tracer?.startSpan(AI_GENERATE_SPAN, {
    [AI_MODEL_ATTR]: options.modelId ?? options.model.defaultModelId,
  });

  try {
    const request = options.model.buildRequest(options);
    const response = await options.model.transport(request);
    const result = await options.model.parseResponse(response);

    span?.setAttributes?.({
      [AI_USAGE_INPUT_TOKENS_ATTR]: result.usage.inputTokens,
      [AI_USAGE_OUTPUT_TOKENS_ATTR]: result.usage.outputTokens,
      [AI_STOP_REASON_ATTR]: result.stopReason,
    });
    span?.setStatus("ok");
    span?.end();

    return result;
  } catch (error) {
    // The coded provider failure (`AI_HTTP_ERROR`) — or any other throw — is recorded on the
    // already-open span before it propagates, so a failed generation is visible on the trace too.
    if (error instanceof AiError) span?.setAttributes?.({ [AI_ERROR_CODE_ATTR]: error.code });
    span?.setStatus("error");
    span?.end();

    throw error;
  }
}

/**
 * Stream a completion as text deltas.
 *
 *   for await (const { text } of streamText({ model, messages })) writeToClient(text);
 *
 * Yields one {@link StreamDelta} per text frame. On Workers the underlying
 * `ReadableStream` pipes straight to the client response (`waitUntil` keeps the
 * generation alive past the first byte). Throws `AI_HTTP_ERROR` on a non-2xx and
 * `AI_STREAM_MALFORMED` on an unparseable frame.
 *
 * When an `AgentTracer` is injected (ADR 0031 Phase 2, PREVIEW), one `ai.generate` span brackets
 * the **whole stream lifetime** — opened before the request on the first pull, closed after the
 * last frame (or on an early break / error) — so it carries the streamed generation's real
 * duration. It carries the model id and outcome; unlike the non-streamed path it records no
 * `Usage`/`StopReason` (the delta stream yields text only, not a final token count). A thrown
 * error marks the span `error` with the `AiError` code. Absent a tracer this is the exact
 * original stream — no span, no overhead.
 */
export async function* streamText(options: GenerateOptions): AsyncIterable<StreamDelta> {
  const { tracer } = options;

  // Opened on the first pull (async generators are lazy), before the request goes out, and closed
  // in `finally` — so the span spans open → last frame → close, even on an early `break` (which
  // runs the generator's `return()` → the `finally`) or a mid-stream throw. No leak either way.
  const span = tracer?.startSpan(AI_GENERATE_SPAN, {
    [AI_MODEL_ATTR]: options.modelId ?? options.model.defaultModelId,
  });

  try {
    const request = options.model.buildStreamRequest(options);
    const response = await options.model.transport(request);

    yield* options.model.parseStream(response);

    span?.setStatus("ok");
  } catch (error) {
    if (error instanceof AiError) span?.setAttributes?.({ [AI_ERROR_CODE_ATTR]: error.code });
    span?.setStatus("error");

    throw error;
  } finally {
    span?.end();
  }
}

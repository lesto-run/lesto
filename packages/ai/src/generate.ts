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
 * When an `AgentTracer` is injected (ADR 0031 Phase 2, PREVIEW), each call records one
 * `ai.generate` span carrying the model id and — on success — the parsed `Usage` and
 * `StopReason`; a thrown provider error marks the span `error` with the `AiError` code. The
 * span is opened AFTER the call resolves because the minimal {@link AgentSpan} seam has no
 * `setAttribute`, so the parsed `Usage`/`StopReason` can only ride in the start-time bag.
 * Absent a tracer this is the exact original send — no span, no overhead.
 */
export async function generateText(options: GenerateOptions): Promise<GenerateResult> {
  const { tracer } = options;

  try {
    const request = options.model.buildRequest(options);
    const response = await options.model.transport(request);
    const result = await options.model.parseResponse(response);

    const span = tracer?.startSpan(AI_GENERATE_SPAN, {
      [AI_MODEL_ATTR]: options.modelId ?? options.model.defaultModelId,
      [AI_USAGE_INPUT_TOKENS_ATTR]: result.usage.inputTokens,
      [AI_USAGE_OUTPUT_TOKENS_ATTR]: result.usage.outputTokens,
      [AI_STOP_REASON_ATTR]: result.stopReason,
    });
    span?.setStatus("ok");
    span?.end();

    return result;
  } catch (error) {
    // The coded provider failure (`AI_HTTP_ERROR`) — or any other throw — is recorded on an
    // errored span before it propagates, so a failed generation is visible on the trace too.
    const span = tracer?.startSpan(AI_GENERATE_SPAN, {
      [AI_MODEL_ATTR]: options.modelId ?? options.model.defaultModelId,
      ...(error instanceof AiError ? { [AI_ERROR_CODE_ATTR]: error.code } : {}),
    });
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
 */
export async function* streamText(options: GenerateOptions): AsyncIterable<StreamDelta> {
  const request = options.model.buildStreamRequest(options);
  const response = await options.model.transport(request);

  yield* options.model.parseStream(response);
}

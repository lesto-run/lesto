/**
 * `generateText` / `streamText` — the model-layer keystone (ADR 0021, Increment 1).
 *
 * Both are deliberately thin: the model builds the provider request (pure), the
 * injected transport sends it, the model parses the response (pure). All the
 * opinion lives in the provider behind the `LanguageModel` interface; this file
 * is just the send. That split is what lets a test drive the whole path off a
 * fake transport with no network.
 */

import type { GenerateOptions, GenerateResult, StreamDelta } from "./types";

/**
 * Generate a single, non-streamed completion.
 *
 *   const { text } = await generateText({ model, messages });
 *
 * Returns the assembled text, any tool calls, the stop reason, and token usage.
 * Throws `AI_HTTP_ERROR` (coded, status in `details`) on a non-2xx.
 */
export async function generateText(options: GenerateOptions): Promise<GenerateResult> {
  const request = options.model.buildRequest(options);
  const response = await options.model.transport(request);

  return options.model.parseResponse(response);
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

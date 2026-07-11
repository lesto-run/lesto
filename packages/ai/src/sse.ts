/**
 * The shared SSE stream engine behind every provider's `parseStream`.
 *
 * Both providers' streamed responses have the same lifecycle — an HTTP/body refusal, a
 * `TextDecoder` + `\n\n` frame loop, `data:`-line extraction, a `[DONE]`/comment skip,
 * `JSON.parse` → `AI_STREAM_MALFORMED`, a torn-final-frame tolerance, usage/stop
 * accumulation with the "both counts or nothing" discipline, and a reader-cancel on every
 * exit — differing ONLY in how one already-parsed JSON payload is interpreted. That shared
 * lifecycle lives here exactly once: it needed four separate subtle correctness fixes on the
 * Anthropic path historically (reader leak on early break, fabricated-zero usage, a rejecting
 * `cancel()` masking the real error, usage recovery), and owning it once means the next such
 * fix lands once instead of having to be hand-transplanted into every provider.
 *
 * A provider supplies only a pure {@link FrameInterpreter}; the wire shapes stay in the
 * provider file. Internal — deliberately NOT re-exported from `index.ts`.
 */

import { AiError } from "./errors";

import type { StopReason, StreamDelta, StreamFinal } from "./types";

/**
 * One interpreted stream frame — an ADDITIVE bag: a single frame may carry a text delta AND a
 * usage count / the stop reason together (an OpenAI chunk can; Anthropic frames happen to
 * populate only one field-group at a time, which the bag represents identically). `parseSseStream`
 * yields the `text` and folds the rest into the {@link StreamFinal} it returns. An empty `{}`
 * (or `undefined`) is a frame that contributed nothing — both are treated as a skip.
 */
export interface ParsedFrame {
  readonly text?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly stopReason?: StopReason;
}

/**
 * Interpret one already-parsed SSE `data:` JSON payload into a {@link ParsedFrame} — the ONLY
 * provider-specific part of streaming. MUST be total (defensive field reads over `unknown`) and
 * MUST NOT throw: the engine owns `JSON.parse` and the malformed-frame refusal, so an interpreter
 * throw would be an uncoded bug — surfaced mid-stream but swallowed at the torn-final flush.
 * Returning `undefined` or `{}` skips the frame.
 */
export type FrameInterpreter = (json: unknown) => ParsedFrame | undefined;

/**
 * Drive a provider SSE `Response` into normalized text deltas, returning the final
 * {@link StreamFinal} (usage + stop reason) once the stream drains — or `undefined` if it ended
 * before the provider reported them. `providerLabel` names the provider in the HTTP-refusal
 * message (e.g. `"Anthropic"`, `"OpenAI-compatible endpoint"`).
 *
 * A non-2xx fails loud as `AI_HTTP_ERROR`; a `data:` frame present but not JSON fails as
 * `AI_STREAM_MALFORMED` rather than silently dropping tokens. A torn final frame (a dropped
 * connection mid-frame) is tolerated quietly — the stream just ended early. Usage is reported
 * ONLY when BOTH counts arrived — never a fabricated zero. The parser is a pure async transform
 * over the response's `ReadableStream<Uint8Array>` — fed a canned stream in tests, with no network.
 */
export async function* parseSseStream(
  response: Response,
  interpret: FrameInterpreter,
  providerLabel: string,
): AsyncGenerator<StreamDelta, StreamFinal | undefined> {
  if (!response.ok) {
    throw new AiError("AI_HTTP_ERROR", `${providerLabel} responded ${response.status}.`, {
      status: response.status,
    });
  }

  if (response.body === null) {
    throw new AiError("AI_STREAM_MALFORMED", "Streaming response had no body.");
  }

  const decoder = new TextDecoder();
  let buffer = "";

  const reader = response.body.getReader();

  // The token accounting a provider reports out-of-band, folded in as the meta frames arrive. Left
  // undefined until seen, so a torn stream that never delivered them is distinguishable from a
  // reported zero (the former returns `undefined`; the latter, real zeros).
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let stopReason: StopReason | undefined;

  const absorb = (parsed: ParsedFrame): void => {
    if (parsed.inputTokens !== undefined) inputTokens = parsed.inputTokens;
    if (parsed.outputTokens !== undefined) outputTokens = parsed.outputTokens;
    if (parsed.stopReason !== undefined) stopReason = parsed.stopReason;
  };

  try {
    // Read chunks, accumulate, and emit one delta per complete `\n\n`-terminated frame. A partial
    // frame stays buffered until the next chunk completes it, so a token split across two network
    // reads is never lost or double-counted.
    for (;;) {
      const { done, value } = await reader.read();

      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf("\n\n");

      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        const parsed = parseFrame(frame, interpret);

        if (parsed !== undefined) {
          // Yield on `text !== undefined` (strict — never truthiness): a provider that emits an
          // empty-string text delta still yields it. Every parsed bag is absorbed too, so a frame
          // that carries text AND meta contributes both.
          if (parsed.text !== undefined) yield { text: parsed.text };
          absorb(parsed);
        }

        boundary = buffer.indexOf("\n\n");
      }
    }

    // Flush a final frame the stream closed WITHOUT a trailing blank line — recovering a
    // complete-but-unterminated last delta the loop's `\n\n` scan would otherwise drop. Unlike a
    // mid-stream frame, this trailing remainder can also be a TORN frame from an aborted/dropped
    // connection (incomplete JSON): tolerate that quietly — the stream just ended early, so end
    // with the deltas already yielded rather than raising AI_STREAM_MALFORMED on a truncation. A
    // malformed frame mid-stream still throws (in `parseFrame`, above).
    buffer += decoder.decode();

    let last: ParsedFrame | undefined;
    try {
      last = parseFrame(buffer, interpret);
    } catch {
      last = undefined;
    }

    if (last !== undefined) {
      if (last.text !== undefined) yield { text: last.text };
      absorb(last);
    }

    // Surface the final accounting as the generator's RETURN value (`streamText` reads it via
    // `yield*`). `usage` is reported ONLY when BOTH counts genuinely arrived — never a fabricated
    // zero: a stream torn before both landed reports no usage, exactly the "never received" case
    // `ai.streaming = true` marks as expected. When nothing meaningful arrived, the whole value is
    // `undefined`.
    if (inputTokens !== undefined && outputTokens !== undefined) {
      return {
        usage: { inputTokens, outputTokens },
        ...(stopReason === undefined ? {} : { stopReason }),
      };
    }

    return stopReason === undefined ? undefined : { stopReason };
  } finally {
    // Release the reader / cancel the upstream body on EVERY exit — a normal drain, a thrown frame,
    // AND an early `for-await` `break` (which resumes the generator here via its `return()`).
    // Without this the locked reader and its underlying socket leak whenever a consumer stops early
    // — a common pattern for streamed output. `cancel()` on an already-closed stream is a no-op;
    // swallow any rejection so cleanup never masks the result.
    await reader.cancel().catch(() => {});
  }
}

/**
 * Split one SSE frame down to its `data:` payload, skip the sentinels, parse the JSON, and hand it
 * to the provider's {@link FrameInterpreter}. A `data:` line present but not valid JSON is refused
 * loudly as `AI_STREAM_MALFORMED`; the terminal `data: [DONE]` sentinel and a comment/`event:`-only
 * frame (no `data:` line) are ignored.
 */
function parseFrame(frame: string, interpret: FrameInterpreter): ParsedFrame | undefined {
  const dataLine = frame.split("\n").find((line) => line.startsWith("data:"));

  if (dataLine === undefined) {
    return undefined;
  }

  const raw = dataLine.slice("data:".length).trim();

  if (raw === "" || raw === "[DONE]") {
    return undefined;
  }

  let json: unknown;

  try {
    json = JSON.parse(raw);
  } catch {
    throw new AiError("AI_STREAM_MALFORMED", "Stream frame data was not valid JSON.", { frame });
  }

  return interpret(json);
}

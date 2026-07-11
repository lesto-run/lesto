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
 * The frame/field scan is spec-general, not just tuned to the two current providers: `\r\n` and
 * bare `\r` line endings are normalized to `\n` before the `\n\n` boundary scan (a CRLF-emitting
 * provider would otherwise never produce the `\n\n` this engine looks for, buffering the whole
 * stream to close and losing every delta at once), and a frame's `data:` lines are joined with
 * `\n` rather than only the first one being read (per the SSE spec). Both current providers only
 * ever emit LF frames with a single `data:` line, so this is a no-op for them today — but a
 * future provider that doesn't is handled correctly on day one instead of silently mishandled.
 *
 * A provider supplies only a pure {@link FrameInterpreter}; the wire shapes stay in the
 * provider file. Internal — deliberately NOT re-exported from `index.ts`.
 */

import { AiError } from "./errors";

import type { StopReason, StreamDelta, StreamFinal, ToolCall, Usage } from "./types";

/**
 * One fragment of a streamed tool call (finding F5). Both providers stream a tool call the same
 * way — an ANNOUNCE fragment (the `id` + `name`, no args) followed by argument-JSON chunks — and
 * both correlate the pieces by a small integer `index` (Anthropic's content-block index; OpenAI's
 * tool-call index). The interpreter's only job is to project one wire frame onto this shape; the
 * engine owns the stateful accumulation (concatenate `argsFragment`s by `index`) and the final
 * `JSON.parse`, so the interpreters stay pure and total and a third provider is still one file.
 */
export interface ToolCallFragment {
  /** The tool call this fragment belongs to; fragments sharing an `index` accumulate into one call. */
  readonly index: number;
  /** The provider's call id — on the announce fragment. `undefined` on the argument-chunk fragments. */
  readonly id?: string | undefined;
  /** The tool name — on the announce fragment. `undefined` on the argument-chunk fragments. */
  readonly name?: string | undefined;
  /** A chunk of the arguments-JSON string, concatenated across fragments and parsed once at drain. */
  readonly argsFragment?: string | undefined;
}

/**
 * One interpreted stream frame — an ADDITIVE bag: a single frame may carry a text delta, a usage
 * count / the stop reason, AND one-or-more {@link ToolCallFragment}s together (an OpenAI chunk can
 * carry text + finish_reason, or several tool-call fragments at once; Anthropic frames happen to
 * populate only one field-group at a time, which the bag represents identically). `parseSseStream`
 * yields the `text`, accumulates the `toolCalls` fragments, and folds the rest into the
 * {@link StreamFinal} it returns. An empty `{}` (or `undefined`) is a frame that contributed
 * nothing — both are treated as a skip.
 */
export interface ParsedFrame {
  readonly text?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly stopReason?: StopReason;
  /** Tool-call fragments this frame carried (F5) — accumulated by `index`, never yielded raw. */
  readonly toolCalls?: readonly ToolCallFragment[];
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

  // Streamed tool calls (F5), accumulated by their `index` as the fragments arrive: the announce
  // fragment sets id/name, the argument-JSON chunks concatenate onto `args`. Assembled into
  // complete `ToolCall`s (id/name + parsed `input`) once the stream drains — never yielded raw.
  const toolAccumulators = new Map<number, ToolCallAccumulator>();

  const absorb = (parsed: ParsedFrame): void => {
    if (parsed.inputTokens !== undefined) inputTokens = parsed.inputTokens;
    if (parsed.outputTokens !== undefined) outputTokens = parsed.outputTokens;
    if (parsed.stopReason !== undefined) stopReason = parsed.stopReason;

    if (parsed.toolCalls !== undefined) {
      for (const fragment of parsed.toolCalls) {
        let accumulator = toolAccumulators.get(fragment.index);
        if (accumulator === undefined) {
          accumulator = { id: "", name: "", args: "" };
          toolAccumulators.set(fragment.index, accumulator);
        }
        if (fragment.id !== undefined) accumulator.id = fragment.id;
        if (fragment.name !== undefined) accumulator.name = fragment.name;
        if (fragment.argsFragment !== undefined) accumulator.args += fragment.argsFragment;
      }
    }
  };

  try {
    // Read chunks, normalize their line endings to `\n` (SSE permits `\r\n` and a bare `\r` too;
    // only `\n` is scanned for below), and emit one delta per complete `\n\n`-terminated frame. A
    // partial frame stays buffered until the next chunk completes it, so a token — or a line
    // ending — split across two network reads is never lost or double-counted.
    for (;;) {
      const { done, value } = await reader.read();

      if (done) break;

      buffer = normalizeLineEndings(buffer + decoder.decode(value, { stream: true }));

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
    buffer = normalizeLineEndings(buffer + decoder.decode());

    let last: ParsedFrame | undefined;
    try {
      last = parseFrame(buffer, interpret);
    } catch (error) {
      // Tolerate ONLY a torn final frame — incomplete JSON the connection dropped mid-write, which
      // `parseFrame` reports as `AI_STREAM_MALFORMED`. Anything else (an interpreter fault, now that
      // interpretation is a per-provider seam) is a real bug: surface it rather than bury it at EOF.
      if (error instanceof AiError && error.code === "AI_STREAM_MALFORMED") {
        last = undefined;
      } else {
        throw error;
      }
    }

    if (last !== undefined) {
      if (last.text !== undefined) yield { text: last.text };
      absorb(last);
    }

    // Assemble any streamed tool calls from their accumulated fragments — id/name from the announce
    // fragment, the arguments concatenated across the JSON-delta fragments and parsed once here (the
    // engine owns JSON parsing for tool args as it does for the frame body). A tool call whose args
    // never form valid JSON fails LOUD as AI_STREAM_MALFORMED rather than fabricating `{}` or being
    // dropped silently (F5): a partial tool call is useless — and unsafe — to run. Each complete
    // call is yielded inline as its own delta (`text: ""`) so a `for-await` consumer sees it without
    // reassembling fragments, and all of them ride on the returned `toolCalls`.
    const toolCalls = assembleToolCalls(toolAccumulators);

    for (const toolCall of toolCalls) {
      yield { text: "", toolCall };
    }

    // Surface the final accounting as the generator's RETURN value (`streamText` reads it via
    // `yield*`). `usage` is reported ONLY when BOTH counts genuinely arrived — never a fabricated
    // zero: a stream torn before both landed reports no usage, exactly the "never received" case
    // `ai.streaming = true` marks as expected. When nothing meaningful arrived — no usage, no stop
    // reason, and no tool call — the whole value is `undefined`.
    const final: { usage?: Usage; stopReason?: StopReason; toolCalls?: readonly ToolCall[] } = {};

    if (inputTokens !== undefined && outputTokens !== undefined) {
      final.usage = { inputTokens, outputTokens };
    }
    if (stopReason !== undefined) {
      final.stopReason = stopReason;
    }
    if (toolCalls.length > 0) {
      final.toolCalls = toolCalls;
    }

    return Object.keys(final).length === 0 ? undefined : final;
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
 * Normalize one accumulated buffer's line endings to bare `\n`, ahead of the `\n\n`-boundary scan
 * and the field-line split in {@link parseFrame} — both of which only ever look for `\n`. The SSE
 * spec permits a line to end in `\r\n`, a bare `\r`, OR `\n`; without this a CRLF-emitting provider
 * never produces the `\n\n` the boundary scan looks for, so the whole stream buffers to close and
 * the final flush (which reads only the first `data:` line — see {@link parseFrame}) drops
 * everything after it. Run over the WHOLE accumulated buffer (not just the newest chunk) each time
 * so the result is the same regardless of how the underlying reads happen to chunk the bytes.
 */
function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/**
 * Split one SSE frame down to its `data:` payload(s), skip the sentinels, parse the JSON, and hand
 * it to the provider's {@link FrameInterpreter}. Per the SSE spec a frame MAY carry more than one
 * `data:` line — ALL of them are read and joined with `\n` (never just the first), so a
 * pretty-printed/multi-line JSON payload round-trips intact instead of being truncated to whatever
 * the first line alone happens to parse (or fail to parse) as. The joined payload, if present but
 * not valid JSON, is refused loudly as `AI_STREAM_MALFORMED`; the terminal `data: [DONE]` sentinel
 * and a comment/`event:`-only frame (no `data:` line at all) are ignored.
 */
function parseFrame(frame: string, interpret: FrameInterpreter): ParsedFrame | undefined {
  const dataLines = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim());

  if (dataLines.length === 0) {
    return undefined;
  }

  const raw = dataLines.join("\n");

  if (raw === "" || raw === "[DONE]") {
    return undefined;
  }

  let json: unknown;

  try {
    json = JSON.parse(raw);
  } catch {
    throw new AiError("AI_STREAM_MALFORMED", "Stream frame data was not valid JSON.", { frame });
  }

  // A `data:` payload that parses to a non-object (`null`, a number, a string, a boolean) carries no
  // frame for any provider — skip it. This is what makes the {@link FrameInterpreter} "total, never
  // throws" contract genuinely enforceable: an interpreter does `json as WireShape` then dereferences
  // it, which would throw a `TypeError` on `null` (and `null` alone — property access on the other
  // primitives yields `undefined`). Guarding here, at the one place that owns `JSON.parse`, makes
  // every interpreter honest at once, rather than each re-checking for null.
  if (typeof json !== "object" || json === null) {
    return undefined;
  }

  return interpret(json);
}

/** The growing state of one streamed tool call, keyed by its `index` while fragments arrive. */
interface ToolCallAccumulator {
  id: string;
  name: string;
  args: string;
}

/**
 * Assemble the accumulated tool-call fragments into complete {@link ToolCall}s, in `index` order —
 * the streamed counterpart to the non-streamed providers' tool-call parsing. The concatenated
 * argument string is parsed here (empty → `{}`, a legitimate no-arg call); anything that is not a
 * JSON object fails LOUD as `AI_STREAM_MALFORMED` (F5).
 */
function assembleToolCalls(accumulators: Map<number, ToolCallAccumulator>): ToolCall[] {
  return [...accumulators.entries()]
    .toSorted(([a], [b]) => a - b)
    .map(([, accumulator]) => ({
      id: accumulator.id,
      name: accumulator.name,
      input: parseToolArgs(accumulator.args),
    }));
}

/**
 * Parse a streamed tool call's concatenated `arguments` string into the normalized object `input`.
 *
 * An empty string is a no-arg call → `{}` (legitimate; both wire formats emit `""` for a tool that
 * takes none). A non-empty string that is not a JSON object is a malformed/torn tool-call stream →
 * `AI_STREAM_MALFORMED`, never a silent `{}` or a dropped call: a partial tool call is unusable.
 */
function parseToolArgs(raw: string): Record<string, unknown> {
  if (raw === "") {
    return {};
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AiError("AI_STREAM_MALFORMED", "Streamed tool call arguments were not valid JSON.", {
      arguments: raw,
    });
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AiError(
      "AI_STREAM_MALFORMED",
      "Streamed tool call arguments were not a JSON object.",
      {
        arguments: raw,
      },
    );
  }

  return parsed as Record<string, unknown>;
}

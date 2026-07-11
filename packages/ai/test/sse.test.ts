import { describe, expect, it } from "vitest";

import { AiError } from "../src/errors";
import { parseSseStream } from "../src/sse";

import { sseResponse } from "./fake-transport";

import type { FrameInterpreter } from "../src/sse";
import type { StreamDelta, StreamFinal } from "../src/types";

/**
 * A minimal, provider-agnostic {@link FrameInterpreter} that reads only `{ text: string }` —
 * the CRLF-boundary and multi-`data:`-line handling under test here lives entirely in the shared
 * engine (`sse.ts`), not in either provider's wire shape, so it is exercised directly against the
 * engine rather than laundered through Anthropic's or OpenAI's frame shapes.
 */
const echoInterpreter: FrameInterpreter = (json) => {
  if (typeof json !== "object" || json === null) {
    return undefined;
  }

  const obj = json as Record<string, unknown>;

  return typeof obj["text"] === "string" ? { text: obj["text"] } : undefined;
};

/** Drain a `parseSseStream` generator, returning both the yielded text and the RETURN value. */
async function collect(
  stream: AsyncGenerator<StreamDelta, StreamFinal | undefined>,
): Promise<{ texts: string[]; final: StreamFinal | undefined }> {
  const texts: string[] = [];
  let next = await stream.next();

  while (!next.done) {
    texts.push(next.value.text);
    next = await stream.next();
  }

  return { texts, final: next.value };
}

describe("parseSseStream — frame/field scan (engine-level, provider-agnostic)", () => {
  it("pins the existing LF, single-`data:`-line frame behavior unchanged", async () => {
    const frames = ['data: {"text":"foo"}\n\n', 'data: {"text":"bar"}\n\n'];

    const { texts } = await collect(parseSseStream(sseResponse(frames), echoInterpreter, "Test"));

    expect(texts).toEqual(["foo", "bar"]);
  });

  it("splits CRLF (\\r\\n\\r\\n) frame boundaries, not just LF — SSE-spec-legal line endings", async () => {
    // Before the fix: `indexOf("\n\n")` never matches "\r\n\r\n", so NEITHER frame boundary is ever
    // found mid-stream — everything buffers until the stream closes, and the final flush then reads
    // only the FIRST `data:` line of the entire combined buffer, silently dropping "bar" rather than
    // throwing. Confirmed RED against the pre-fix splitter (texts came back as ["foo"], not
    // ["foo", "bar"]) before landing the fix below.
    const frames = ['data: {"text":"foo"}\r\n\r\n', 'data: {"text":"bar"}\r\n\r\n'];

    const { texts } = await collect(parseSseStream(sseResponse(frames), echoInterpreter, "Test"));

    expect(texts).toEqual(["foo", "bar"]);
  });

  it("splits a bare-CR (\\r\\r) frame boundary too", async () => {
    const frames = ['data: {"text":"foo"}\r\r', 'data: {"text":"bar"}\r\r'];

    const { texts } = await collect(parseSseStream(sseResponse(frames), echoInterpreter, "Test"));

    expect(texts).toEqual(["foo", "bar"]);
  });

  it("recovers correctly even when a CRLF pair is split exactly across two network reads", async () => {
    // The trailing `\r` of the FIRST frame's terminator lands in one chunk; the paired `\n` (plus a
    // whole second CRLF-CRLF) lands in the next. Normalizing the accumulated buffer on every chunk
    // (rather than only the newest bytes) means the boundary is still found correctly.
    const frames = ['data: {"text":"joined"}\r', "\n\r\n"];

    const { texts } = await collect(parseSseStream(sseResponse(frames), echoInterpreter, "Test"));

    expect(texts).toEqual(["joined"]);
  });

  it("reassembles a JSON payload split across two network reads inside a CRLF-terminated frame", async () => {
    const frames = ['data: {"text":', '"joined"}\r\n\r\n'];

    const { texts } = await collect(parseSseStream(sseResponse(frames), echoInterpreter, "Test"));

    expect(texts).toEqual(["joined"]);
  });

  it("flushes a final CRLF frame the stream closed without a trailing blank line", async () => {
    const frames = ['data: {"text":"first"}\r\n\r\n', 'data: {"text":"last"}'];

    const { texts } = await collect(parseSseStream(sseResponse(frames), echoInterpreter, "Test"));

    expect(texts).toEqual(["first", "last"]);
  });

  it("tolerates a torn CRLF final frame from a dropped stream — yields what arrived, no throw", async () => {
    const frames = ['data: {"text":"partial"}\r\n\r\n', 'data: {"text":"trunc'];

    const { texts } = await collect(parseSseStream(sseResponse(frames), echoInterpreter, "Test"));

    expect(texts).toEqual(["partial"]);
  });

  it("joins multiple `data:` lines in one frame with `\\n` per the SSE spec, instead of reading only the first", async () => {
    // A pretty-printed/multi-line JSON payload split across three `data:` lines. Before the fix,
    // `parseFrame` read only the FIRST `data:` line ("data: {") in isolation — `JSON.parse("{")`
    // throws, so this spec-legal multi-line frame was incorrectly rejected as AI_STREAM_MALFORMED
    // mid-stream instead of being joined and parsed as the single JSON value it is. Confirmed RED
    // (an unexpected AI_STREAM_MALFORMED throw) against the pre-fix `parseFrame` before landing the
    // fix below.
    const frames = ['data: {\ndata:   "text": "joined"\ndata: }\n\n'];

    const { texts } = await collect(parseSseStream(sseResponse(frames), echoInterpreter, "Test"));

    expect(texts).toEqual(["joined"]);
  });

  it("joins multiple `data:` lines across a CRLF frame too (both fixes compose)", async () => {
    const frames = ['data: {\r\ndata:   "text": "joined"\r\ndata: }\r\n\r\n'];

    const { texts } = await collect(parseSseStream(sseResponse(frames), echoInterpreter, "Test"));

    expect(texts).toEqual(["joined"]);
  });

  it("still refuses a malformed (non-JSON) joined multi-`data:`-line payload with AI_STREAM_MALFORMED", async () => {
    const frames = ["data: {not\ndata: json}\n\n"];

    const iterate = async (): Promise<void> => {
      for await (const _ of parseSseStream(sseResponse(frames), echoInterpreter, "Test")) {
        // drain — the malformed joined frame throws on the first pull
      }
    };

    const error = await iterate().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AiError);
    expect((error as AiError).code).toBe("AI_STREAM_MALFORMED");
  });

  it("ignores a comment/event:-only frame (no `data:` line at all) regardless of line ending", async () => {
    const frames = [
      ": a comment line with no data\r\n\r\n",
      'event: ping\r\ndata: {"text":"x"}\r\n\r\n',
    ];

    const { texts } = await collect(parseSseStream(sseResponse(frames), echoInterpreter, "Test"));

    expect(texts).toEqual(["x"]);
  });
});

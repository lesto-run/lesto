import { describe, expect, it } from "vitest";

import { createAnthropic, DEFAULT_MODEL_ID } from "../src/anthropic";
import { AiError } from "../src/errors";

import {
  constantTransport,
  jsonResponse,
  sseResponse,
  textMessage,
  toolUseMessage,
} from "./fake-transport";

import type { GenerateOptions, StreamDelta, StreamFinal } from "../src/types";

/**
 * Drain a `parseStream` generator to completion, returning both the yielded text and the RETURN
 * value (the {@link StreamFinal}) — which a `for-await` loop discards, so the tests that assert
 * the final accounting iterate by hand.
 */
async function collectStream(
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

const baseOptions = (model: ReturnType<typeof createAnthropic>): GenerateOptions => ({
  model,
  messages: [{ role: "user", content: "Hello" }],
});

/** Build one SSE `data:` frame from a JSON payload — avoids hand-escaping nested tool-call JSON. */
const data = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;

describe("createAnthropic — request assembly", () => {
  it("defaults the model id to claude-opus-4-8 and sets the auth + version headers", async () => {
    const model = createAnthropic({ apiKey: "sk-test" });

    expect(model.defaultModelId).toBe(DEFAULT_MODEL_ID);

    const request = model.buildRequest(baseOptions(model));

    expect(request.method).toBe("POST");
    expect(request.url).toBe("https://api.anthropic.com/v1/messages");
    expect(request.headers.get("x-api-key")).toBe("sk-test");
    expect(request.headers.get("anthropic-version")).toBe("2023-06-01");

    const body = (await request.json()) as Record<string, unknown>;

    expect(body["model"]).toBe(DEFAULT_MODEL_ID);
    expect(body["stream"]).toBe(false);
    expect(body["max_tokens"]).toBe(1024);
    expect(body["messages"]).toEqual([{ role: "user", content: "Hello" }]);
    expect(body["system"]).toBeUndefined();
    expect(body["tools"]).toBeUndefined();
  });

  it("serializes a content-block turn (text + tool_use + tool_result) to the Anthropic wire shape", async () => {
    const model = createAnthropic({ apiKey: "sk-test" });

    const request = model.buildRequest({
      model,
      messages: [
        { role: "user", content: "Weather in Rome?" }, // string content rides through
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me check." },
            { type: "tool_use", id: "call-1", name: "getWeather", input: { city: "Rome" } },
          ],
        },
        { role: "user", content: [{ type: "tool_result", toolUseId: "call-1", content: "sunny" }] },
      ],
    });

    const body = (await request.json()) as { messages: unknown[] };

    // `toolUseId` is rewritten to the wire's `tool_use_id`; text/tool_use pass through.
    expect(body.messages).toEqual([
      { role: "user", content: "Weather in Rome?" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check." },
          { type: "tool_use", id: "call-1", name: "getWeather", input: { city: "Rome" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "sunny" }] },
    ]);
  });

  it("honors an overridden model id, system prompt, max tokens, and tool set", async () => {
    const model = createAnthropic({ apiKey: "sk-test", defaultModelId: "claude-fable-5" });

    expect(model.defaultModelId).toBe("claude-fable-5");

    const request = model.buildRequest({
      model,
      messages: [{ role: "user", content: "x" }],
      system: "Be terse.",
      modelId: "claude-haiku-4-5-20251001",
      maxTokens: 256,
      tools: {
        getWeather: {
          description: "weather",
          inputSchema: { type: "object" },
          execute: async () => "sunny",
        },
      },
    });

    const body = (await request.json()) as Record<string, unknown>;

    expect(body["model"]).toBe("claude-haiku-4-5-20251001");
    expect(body["system"]).toBe("Be terse.");
    expect(body["max_tokens"]).toBe(256);
    expect(body["tools"]).toEqual([
      { name: "getWeather", description: "weather", input_schema: { type: "object" } },
    ]);
  });

  it("sets stream:true on the stream request builder", async () => {
    const model = createAnthropic({ apiKey: "sk-test" });

    const body = (await model.buildStreamRequest(baseOptions(model)).json()) as Record<
      string,
      unknown
    >;

    expect(body["stream"]).toBe(true);
  });
});

describe("parseResponse", () => {
  it("assembles text blocks, tool calls, stop reason, and usage", async () => {
    const model = createAnthropic({ apiKey: "sk-test" });

    const response = jsonResponse({
      content: [
        { type: "text", text: "Mars " },
        { type: "text", text: "and Venus." },
        { type: "tool_use", id: "t1", name: "lookup", input: { q: "planets" } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 11, output_tokens: 22 },
    });

    const result = await model.parseResponse(response);

    expect(result.text).toBe("Mars and Venus.");
    expect(result.toolCalls).toEqual([{ id: "t1", name: "lookup", input: { q: "planets" } }]);
    expect(result.stopReason).toBe("tool_use");
    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 22 });
  });

  it("normalizes an unknown stop reason to end_turn and missing usage to zero", async () => {
    const model = createAnthropic({ apiKey: "sk-test" });

    const result = await model.parseResponse(
      jsonResponse({ content: [{ type: "text", text: "hi" }], stop_reason: "weird" }),
    );

    expect(result.stopReason).toBe("end_turn");
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it.each([
    ["max_tokens", "max_tokens"],
    ["stop_sequence", "stop_sequence"],
    [null, "end_turn"],
  ])("maps stop reason %s to %s", async (wire, expected) => {
    const model = createAnthropic({ apiKey: "sk-test" });

    const result = await model.parseResponse(
      jsonResponse({ content: [{ type: "text", text: "" }], stop_reason: wire }),
    );

    expect(result.stopReason).toBe(expected);
  });

  it("refuses a non-2xx with a coded AI_HTTP_ERROR carrying the status", async () => {
    const model = createAnthropic({ apiKey: "sk-test" });

    const error = await model.parseResponse(jsonResponse({}, 429)).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AiError);
    expect((error as AiError).code).toBe("AI_HTTP_ERROR");
    expect((error as AiError).details["status"]).toBe(429);
  });

  it("refuses a 2xx whose body is not JSON with AI_RESPONSE_MALFORMED (not an uncoded SyntaxError)", async () => {
    const model = createAnthropic({ apiKey: "sk-test" });
    const html = new Response("<html>not json</html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });

    const error = await model.parseResponse(html).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AiError);
    expect((error as AiError).code).toBe("AI_RESPONSE_MALFORMED");
  });

  it("refuses a 2xx with no content array with AI_RESPONSE_MALFORMED (not an uncoded TypeError)", async () => {
    const model = createAnthropic({ apiKey: "sk-test" });

    const error = await model
      .parseResponse(jsonResponse({ error: "overloaded", stop_reason: null }))
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AiError);
    expect((error as AiError).code).toBe("AI_RESPONSE_MALFORMED");
  });

  it("accepts a 2xx with an EMPTY content array — legitimate, yields empty text", async () => {
    const model = createAnthropic({ apiKey: "sk-test" });

    const result = await model.parseResponse(
      jsonResponse({
        content: [],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 0 },
      }),
    );

    expect(result.text).toBe("");
    expect(result.toolCalls).toEqual([]);
  });
});

describe("parseStream", () => {
  it("yields text deltas from content_block_delta frames and ignores the rest", async () => {
    const model = createAnthropic({ apiKey: "sk-test" });

    const frames = [
      'event: message_start\ndata: {"type":"message_start"}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];

    const deltas: string[] = [];

    for await (const delta of model.parseStream(sseResponse(frames))) {
      deltas.push(delta.text);
    }

    expect(deltas).toEqual(["Hel", "lo"]);
  });

  it("folds message_start + message_delta into the returned final usage/stop reason (not yielded)", async () => {
    const model = createAnthropic({ apiKey: "sk-test" });

    // input tokens ride on message_start; the final output count + stop reason on message_delta.
    const frames = [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":12}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];

    const { texts, final } = await collectStream(model.parseStream(sseResponse(frames)));

    // The meta frames are folded in, NOT surfaced as text deltas — the consumer still sees text only.
    expect(texts).toEqual(["Hi"]);
    expect(final).toEqual({ usage: { inputTokens: 12, outputTokens: 7 }, stopReason: "end_turn" });
  });

  it("returns usage without a stop reason when message_delta carries a null stop_reason", async () => {
    const model = createAnthropic({ apiKey: "sk-test" });

    const frames = [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":null},"usage":{"output_tokens":9}}\n\n',
    ];

    const { final } = await collectStream(model.parseStream(sseResponse(frames)));

    expect(final).toEqual({ usage: { inputTokens: 3, outputTokens: 9 } });
  });

  it("returns undefined when the stream ends before any usage/stop-reason frame (torn stream)", async () => {
    const model = createAnthropic({ apiKey: "sk-test" });

    const frames = [
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"x"}}\n\n',
    ];

    const { texts, final } = await collectStream(model.parseStream(sseResponse(frames)));

    expect(texts).toEqual(["x"]);
    expect(final).toBeUndefined();
  });

  it("returns undefined — NOT a fabricated zero — when torn after message_start but before message_delta", async () => {
    const model = createAnthropic({ apiKey: "sk-test" });

    // The most likely torn shape: input arrived on message_start, then the connection dropped
    // before message_delta delivered the final output count. message_start carries a small INITIAL
    // output_tokens (2 here) that is deliberately ignored — using it would report a misleadingly
    // tiny {15, 2} for a stream that streamed more; usage is withheld entirely instead.
    const frames = [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":15,"output_tokens":2}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}\n\n',
    ];

    const { texts, final } = await collectStream(model.parseStream(sseResponse(frames)));

    expect(texts).toEqual(["partial"]);
    expect(final).toBeUndefined();
  });

  it("ignores message_start's initial output_tokens — the final uses message_delta's cumulative count", async () => {
    const model = createAnthropic({ apiKey: "sk-test" });

    // message_start reports output_tokens: 2 (the initial count); message_delta reports the
    // authoritative cumulative 20. The returned final must reflect 20, never message_start's 2.
    const frames = [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":2}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":20}}\n\n',
    ];

    const { final } = await collectStream(model.parseStream(sseResponse(frames)));

    expect(final).toEqual({ usage: { inputTokens: 10, outputTokens: 20 }, stopReason: "end_turn" });
  });

  it("cancels the upstream body when the consumer breaks early (no leaked reader)", async () => {
    // A stream the consumer abandons mid-way: parseStream locks a reader on response.body, so its
    // `finally` must cancel the body on an early break — otherwise the reader + its socket leak.
    let cancelled = false;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"a"}}\n\n',
          ),
        );
        controller.enqueue(
          encoder.encode(
            'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"b"}}\n\n',
          ),
        );
        // Deliberately NOT closed — an open SSE stream the consumer walks away from.
      },
      cancel() {
        cancelled = true;
      },
    });
    const model = createAnthropic({ apiKey: "sk-test" });
    const response = new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

    for await (const delta of model.parseStream(response)) {
      expect(delta.text).toBe("a");
      break; // early break → the generator's return() runs the finally → reader.cancel()
    }

    expect(cancelled).toBe(true);
  });

  it("swallows a REJECTING cancel() on an early break — the clean break still completes", async () => {
    // The finally does `reader.cancel().catch(() => {})`; if the underlying source's cancel throws,
    // that rejection must NOT escape to the consumer and turn a clean break into a thrown error.
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"a"}}\n\n',
          ),
        );
      },
      cancel() {
        throw new Error("cancel boom"); // → reader.cancel() rejects
      },
    });
    const model = createAnthropic({ apiKey: "sk-test" });
    const response = new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

    let broke = false;
    for await (const delta of model.parseStream(response)) {
      expect(delta.text).toBe("a");
      broke = true;
      break; // if the rejecting cancel escaped the finally, this loop would throw instead
    }

    expect(broke).toBe(true);
  });

  it("a rejecting cancel() does not mask a mid-stream AI_STREAM_MALFORMED", async () => {
    // The real error must win: a cleanup-time cancel rejection in the finally must not replace the
    // AiError the parse threw.
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("data: {not json}\n\n")); // → AI_STREAM_MALFORMED
      },
      cancel() {
        throw new Error("cancel boom");
      },
    });
    const model = createAnthropic({ apiKey: "sk-test" });
    const response = new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

    const error = await (async () => {
      for await (const _ of model.parseStream(response)) {
        // drain — the malformed frame throws on the first pull
      }
    })().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AiError);
    expect((error as AiError).code).toBe("AI_STREAM_MALFORMED");
  });

  it("returns just the stop reason when message_delta carries one but no usage", async () => {
    const model = createAnthropic({ apiKey: "sk-test" });

    // A message_delta with a stop_reason but no usage block: report the stop reason we did get,
    // withhold usage (never fabricated) — the `{ stopReason }`-only return.
    const frames = [
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"x"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}\n\n',
    ];

    const { final } = await collectStream(model.parseStream(sseResponse(frames)));

    expect(final).toEqual({ stopReason: "max_tokens" });
  });

  it("reassembles a frame split across two network reads", async () => {
    const model = createAnthropic({ apiKey: "sk-test" });

    // The frame is delivered in two chunks; the parser must buffer the partial.
    const frames = [
      'event: content_block_delta\ndata: {"type":"content_block_delta",',
      '"delta":{"type":"text_delta","text":"joined"}}\n\n',
    ];

    const deltas: string[] = [];

    for await (const delta of model.parseStream(sseResponse(frames))) {
      deltas.push(delta.text);
    }

    expect(deltas).toEqual(["joined"]);
  });

  it("flushes a final text delta the stream closed without a trailing blank line", async () => {
    const model = createAnthropic({ apiKey: "sk-test" });

    // The last frame has NO terminating `\n\n` — a server that closes right after the
    // delta. Without a post-loop flush the buffered final token is silently dropped.
    const frames = [
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"first"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"last"}}',
    ];

    const deltas: string[] = [];

    for await (const delta of model.parseStream(sseResponse(frames))) {
      deltas.push(delta.text);
    }

    expect(deltas).toEqual(["first", "last"]);
  });

  it("tolerates a torn final frame from a dropped stream — yields what arrived, no throw", async () => {
    const model = createAnthropic({ apiKey: "sk-test" });

    // First frame complete; the connection then drops MID-frame: a `data:` line with
    // truncated JSON and no `\n\n`. The flush must end quietly with "partial", not raise
    // AI_STREAM_MALFORMED (which is reserved for a malformed frame mid-stream).
    const frames = [
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_de',
    ];

    const deltas: string[] = [];

    for await (const delta of model.parseStream(sseResponse(frames))) {
      deltas.push(delta.text);
    }

    expect(deltas).toEqual(["partial"]);
  });

  it("ignores a [DONE] sentinel, a comment line, a ping, and a text-block content_block_start (no text, no tool call)", async () => {
    const model = createAnthropic({ apiKey: "sk-test" });

    // Frames the interpreter must contribute nothing for: the [DONE] sentinel, a comment line with
    // no data, a keep-alive ping, and a TEXT-block content_block_start (only a tool_use block opens
    // a tool-call fragment — F5). None yield a text delta or a tool call.
    const frames = [
      "data: [DONE]\n\n",
      ": a comment line with no data\n\n",
      'event: ping\ndata: {"type":"ping"}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    ];

    const deltas: StreamDelta[] = [];

    for await (const delta of model.parseStream(sseResponse(frames))) {
      deltas.push(delta);
    }

    expect(deltas).toEqual([]);
  });

  it("assembles a streamed tool call from content_block_start + input_json_delta and surfaces it in the deltas AND the final (finding F5)", async () => {
    const model = createAnthropic({ apiKey: "sk-test" });

    // A real Anthropic tool-use stream: the block is announced (id + name) on content_block_start,
    // its arguments arrive as input_json_delta partial-JSON chunks under the same index, and the
    // turn closes with stop_reason "tool_use". None of this is a text delta — before F5 it was
    // dropped entirely, forcing runAgent off streaming onto the non-streamed fallback.
    const frames = [
      data({ type: "message_start", message: { usage: { input_tokens: 10 } } }),
      data({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_1", name: "get_weather", input: {} },
      }),
      data({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"city":' },
      }),
      data({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '"Paris"}' },
      }),
      data({ type: "content_block_stop", index: 0 }),
      data({
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
        usage: { output_tokens: 15 },
      }),
      data({ type: "message_stop" }),
    ];

    const deltas: StreamDelta[] = [];
    const stream = model.parseStream(sseResponse(frames));
    let next = await stream.next();
    while (!next.done) {
      deltas.push(next.value);
      next = await stream.next();
    }
    const final = next.value;

    const expectedCall = { id: "toolu_1", name: "get_weather", input: { city: "Paris" } };

    // The completed tool call rides inline as its own delta (text ""), not lost between text frames.
    expect(deltas).toEqual([{ text: "", toolCall: expectedCall }]);
    // ...and on the final accounting, alongside usage + the tool_use stop reason.
    expect(final).toEqual({
      usage: { inputTokens: 10, outputTokens: 15 },
      stopReason: "tool_use",
      toolCalls: [expectedCall],
    });
  });

  it("defaults a tool-call block index to 0 when a frame omits it (defensive: a relay that strips index still assembles)", async () => {
    const model = createAnthropic({ apiKey: "sk-test" });

    // Anthropic always sends `index`, but a lenient relay/proxy could strip it. Both the announce and
    // the argument chunk omit it here — they still correlate (default 0) into one assembled call.
    const frames = [
      data({
        type: "content_block_start",
        content_block: { type: "tool_use", id: "toolu_0", name: "noop" },
      }),
      data({
        type: "content_block_delta",
        delta: { type: "input_json_delta", partial_json: '{"ok":true}' },
      }),
      data({
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
        usage: { output_tokens: 2 },
      }),
    ];

    const deltas: StreamDelta[] = [];
    const stream = model.parseStream(sseResponse(frames));
    let next = await stream.next();
    while (!next.done) {
      deltas.push(next.value);
      next = await stream.next();
    }

    expect(deltas).toEqual([
      { text: "", toolCall: { id: "toolu_0", name: "noop", input: { ok: true } } },
    ]);
  });

  it("interleaves a text block with a streamed tool call — text yields as deltas, the tool call assembles at the end", async () => {
    const model = createAnthropic({ apiKey: "sk-test" });

    // Index 0 is a text block; index 1 is a tool_use block. The text streams as ordinary deltas;
    // the tool call accumulates under index 1 and surfaces once, after the text.
    const frames = [
      data({ type: "message_start", message: { usage: { input_tokens: 4 } } }),
      data({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      data({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Let me check. " },
      }),
      data({ type: "content_block_stop", index: 0 }),
      data({
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "toolu_9", name: "lookup", input: {} },
      }),
      data({
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"q":"x"}' },
      }),
      data({ type: "content_block_stop", index: 1 }),
      data({
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
        usage: { output_tokens: 8 },
      }),
    ];

    const deltas: StreamDelta[] = [];
    const stream = model.parseStream(sseResponse(frames));
    let next = await stream.next();
    while (!next.done) {
      deltas.push(next.value);
      next = await stream.next();
    }
    const final = next.value;

    expect(deltas).toEqual([
      { text: "Let me check. " },
      { text: "", toolCall: { id: "toolu_9", name: "lookup", input: { q: "x" } } },
    ]);
    expect(final).toEqual({
      usage: { inputTokens: 4, outputTokens: 8 },
      stopReason: "tool_use",
      toolCalls: [{ id: "toolu_9", name: "lookup", input: { q: "x" } }],
    });
  });

  it("refuses a non-2xx stream with AI_HTTP_ERROR", async () => {
    const model = createAnthropic({ apiKey: "sk-test" });

    const iterate = async (): Promise<void> => {
      for await (const _ of model.parseStream(sseResponse([], 500))) {
        // drain
      }
    };

    const error = await iterate().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AiError);
    expect((error as AiError).code).toBe("AI_HTTP_ERROR");
  });

  it("refuses a stream with no body", async () => {
    const model = createAnthropic({ apiKey: "sk-test" });

    const bodyless = new Response(null, { status: 200 });

    const iterate = async (): Promise<void> => {
      for await (const _ of model.parseStream(bodyless)) {
        // drain
      }
    };

    const error = await iterate().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AiError);
    expect((error as AiError).code).toBe("AI_STREAM_MALFORMED");
  });

  it("refuses a malformed (non-JSON) data frame with AI_STREAM_MALFORMED", async () => {
    const model = createAnthropic({ apiKey: "sk-test" });

    const iterate = async (): Promise<void> => {
      for await (const _ of model.parseStream(sseResponse(["data: {not json}\n\n"]))) {
        // drain
      }
    };

    const error = await iterate().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AiError);
    expect((error as AiError).code).toBe("AI_STREAM_MALFORMED");
  });
});

describe("transport injection", () => {
  it("uses the injected transport so no network is touched", async () => {
    const { transport, requests } = constantTransport(jsonResponse(textMessage("ok")));
    const model = createAnthropic({ apiKey: "sk-test", transport });

    const response = await model.transport(model.buildRequest(baseOptions(model)));
    const result = await model.parseResponse(response);

    expect(result.text).toBe("ok");
    expect(requests).toHaveLength(1);
  });

  it("the tool-use shorthand round-trips through parseResponse", async () => {
    const model = createAnthropic({ apiKey: "sk-test" });

    const result = await model.parseResponse(
      jsonResponse(toolUseMessage("t9", "search", { q: "x" })),
    );

    expect(result.stopReason).toBe("tool_use");
    expect(result.toolCalls[0]?.name).toBe("search");
  });
});

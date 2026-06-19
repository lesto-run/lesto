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

import type { GenerateOptions } from "../src/types";

const baseOptions = (model: ReturnType<typeof createAnthropic>): GenerateOptions => ({
  model,
  messages: [{ role: "user", content: "Hello" }],
});

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

  it("ignores a [DONE] sentinel and a non-text delta", async () => {
    const model = createAnthropic({ apiKey: "sk-test" });

    const frames = [
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{}"}}\n\n',
      "data: [DONE]\n\n",
      ": a comment line with no data\n\n",
    ];

    const deltas: string[] = [];

    for await (const delta of model.parseStream(sseResponse(frames))) {
      deltas.push(delta.text);
    }

    expect(deltas).toEqual([]);
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

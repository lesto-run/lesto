import { describe, expect, it } from "vitest";

import { runAgent } from "../src/agent";
import { AiError } from "../src/errors";
import { generateText, streamText } from "../src/generate";
import { createOpenAICompatible } from "../src/openai-compatible";
import {
  AI_GENERATE_SPAN,
  AI_MODEL_ATTR,
  AI_STOP_REASON_ATTR,
  AI_STREAMING_ATTR,
  AI_USAGE_INPUT_TOKENS_ATTR,
  AI_USAGE_OUTPUT_TOKENS_ATTR,
} from "../src/spans";

import {
  constantTransport,
  jsonResponse,
  openaiTextMessage,
  openaiToolUseMessage,
  scriptedTransport,
  sseResponse,
} from "./fake-transport";
import { recordingTracer } from "./fake-tracer";

import type { GenerateOptions, StreamDelta, StreamFinal } from "../src/types";

/**
 * Drain a `parseStream` generator to completion, returning both the yielded text and the RETURN
 * value (the {@link StreamFinal}) — which a `for-await` loop discards, so the tests that assert the
 * final accounting iterate by hand. Mirrors the helper in `anthropic.test.ts`.
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

const model = (extra: Partial<Parameters<typeof createOpenAICompatible>[0]> = {}) =>
  createOpenAICompatible({
    baseURL: "http://localhost:1234/v1",
    defaultModelId: "local-model",
    ...extra,
  });

const baseOptions = (m: ReturnType<typeof createOpenAICompatible>): GenerateOptions => ({
  model: m,
  messages: [{ role: "user", content: "Hello" }],
});

describe("createOpenAICompatible — request assembly", () => {
  it("posts to <baseURL>/chat/completions, sets content-type, and defaults the model id", async () => {
    const m = model();

    expect(m.defaultModelId).toBe("local-model");

    const request = m.buildRequest(baseOptions(m));

    expect(request.method).toBe("POST");
    expect(request.url).toBe("http://localhost:1234/v1/chat/completions");
    expect(request.headers.get("content-type")).toBe("application/json");

    const body = (await request.json()) as Record<string, unknown>;

    expect(body["model"]).toBe("local-model");
    expect(body["stream"]).toBe(false);
    expect(body["max_tokens"]).toBe(1024);
    expect(body["messages"]).toEqual([{ role: "user", content: "Hello" }]);
  });

  it("strips a trailing slash on baseURL so the path is never doubled", async () => {
    const request = model({ baseURL: "https://api.openai.com/v1/" }).buildRequest(
      baseOptions(model({ baseURL: "https://api.openai.com/v1/" })),
    );

    expect(request.url).toBe("https://api.openai.com/v1/chat/completions");
  });

  it("sends Authorization: Bearer only when an apiKey is configured", async () => {
    const withKey = model({ apiKey: "sk-live" }).buildRequest(
      baseOptions(model({ apiKey: "sk-live" })),
    );
    expect(withKey.headers.get("authorization")).toBe("Bearer sk-live");

    // A local server (LM Studio/Ollama) needs no key — the header is omitted, not sent empty.
    const noKey = model().buildRequest(baseOptions(model()));
    expect(noKey.headers.get("authorization")).toBeNull();
  });

  it("merges extra headers (the OpenRouter seam) onto every request", async () => {
    const m = model({ headers: { "http-referer": "https://lesto.run", "x-title": "Lesto" } });

    const request = m.buildRequest(baseOptions(m));

    expect(request.headers.get("http-referer")).toBe("https://lesto.run");
    expect(request.headers.get("x-title")).toBe("Lesto");
  });

  it("carries the system prompt as a leading role:system message, not a top-level field", async () => {
    const m = model();

    const request = m.buildRequest({
      model: m,
      messages: [{ role: "user", content: "Hi" }],
      system: "Be terse.",
    });

    const body = (await request.json()) as Record<string, unknown>;

    expect(body["system"]).toBeUndefined();
    expect(body["messages"]).toEqual([
      { role: "system", content: "Be terse." },
      { role: "user", content: "Hi" },
    ]);
  });

  it("honors an overridden model id, max tokens, and maps a tool set to OpenAI function tools", async () => {
    const m = model();

    const request = m.buildRequest({
      model: m,
      messages: [{ role: "user", content: "x" }],
      modelId: "gpt-4o-mini",
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

    expect(body["model"]).toBe("gpt-4o-mini");
    expect(body["max_tokens"]).toBe(256);
    expect(body["tools"]).toEqual([
      {
        type: "function",
        function: { name: "getWeather", description: "weather", parameters: { type: "object" } },
      },
    ]);
  });

  it("serializes an assistant tool_use turn to content + tool_calls (input re-encoded as an arguments string)", async () => {
    const m = model();

    const request = m.buildRequest({
      model: m,
      messages: [
        { role: "user", content: "Weather in Rome?" },
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

    expect(body.messages).toEqual([
      { role: "user", content: "Weather in Rome?" },
      {
        role: "assistant",
        content: "Let me check.",
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "getWeather", arguments: '{"city":"Rome"}' },
          },
        ],
      },
      // The single normalized tool-result user turn fans out to a role:"tool" message.
      { role: "tool", tool_call_id: "call-1", content: "sunny" },
    ]);
  });

  it("sends content:null for a pure tool-call assistant turn (no text blocks)", async () => {
    const m = model();

    const request = m.buildRequest({
      model: m,
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "t", input: {} }] },
      ],
    });

    const body = (await request.json()) as { messages: { content: unknown }[] };

    expect(body.messages[0]?.content).toBeNull();
  });

  it("fans a multi-result tool turn out to one role:tool message per result", async () => {
    const m = model();

    const request = m.buildRequest({
      model: m,
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", toolUseId: "a", content: "ra" },
            { type: "tool_result", toolUseId: "b", content: "rb" },
          ],
        },
      ],
    });

    const body = (await request.json()) as { messages: unknown[] };

    expect(body.messages).toEqual([
      { role: "tool", tool_call_id: "a", content: "ra" },
      { role: "tool", tool_call_id: "b", content: "rb" },
    ]);
  });

  it("emits tool_result messages BEFORE text in a hand-built mixed user turn (OpenAI ordering)", async () => {
    // OpenAI requires every role:"tool" message to immediately follow the assistant tool_calls
    // turn — a user text message interposed between them is a 400. So a mixed [text, tool_result]
    // block turn must serialize tool-first, regardless of array order, to stay wire-valid.
    const m = model();

    const request = m.buildRequest({
      model: m,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "and also" },
            { type: "tool_result", toolUseId: "a", content: "ra" },
          ],
        },
      ],
    });

    const body = (await request.json()) as { messages: unknown[] };

    expect(body.messages).toEqual([
      { role: "tool", tool_call_id: "a", content: "ra" },
      { role: "user", content: "and also" },
    ]);
  });

  it("sets stream:true and asks for the terminal usage chunk on the stream request builder", async () => {
    const m = model();

    const body = (await m.buildStreamRequest(baseOptions(m)).json()) as Record<string, unknown>;

    expect(body["stream"]).toBe(true);
    expect(body["stream_options"]).toEqual({ include_usage: true });
  });
});

describe("parseResponse", () => {
  it("assembles text, tool calls (arguments parsed to input), stop reason, and usage", async () => {
    const m = model();

    const response = jsonResponse({
      choices: [
        {
          message: {
            role: "assistant",
            content: "Mars and Venus.",
            tool_calls: [
              {
                id: "t1",
                type: "function",
                function: { name: "lookup", arguments: '{"q":"planets"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 11, completion_tokens: 22 },
    });

    const result = await m.parseResponse(response);

    expect(result.text).toBe("Mars and Venus.");
    expect(result.toolCalls).toEqual([{ id: "t1", name: "lookup", input: { q: "planets" } }]);
    expect(result.stopReason).toBe("tool_use");
    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 22 });
  });

  it("treats a null content and missing usage as empty text + zero tokens", async () => {
    const result = await model().parseResponse(
      jsonResponse({
        choices: [{ message: { role: "assistant", content: null }, finish_reason: "stop" }],
      }),
    );

    expect(result.text).toBe("");
    expect(result.toolCalls).toEqual([]);
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it("treats an empty-string arguments (no-arg tool) as {} — a legitimate call, not malformed", async () => {
    const result = await model().parseResponse(
      jsonResponse({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "t", type: "function", function: { name: "now", arguments: "" } }],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
    );

    expect(result.toolCalls).toEqual([{ id: "t", name: "now", input: {} }]);
  });

  it("ignores a non-function tool_call type", async () => {
    const result = await model().parseResponse(
      jsonResponse({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                { id: "t", type: "code_interpreter", function: { name: "x", arguments: "{}" } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
    );

    expect(result.toolCalls).toEqual([]);
  });

  it.each([
    ["tool_calls", "tool_use"],
    ["function_call", "tool_use"],
    ["length", "max_tokens"],
    ["stop", "end_turn"],
    ["content_filter", "end_turn"],
    [null, "end_turn"],
  ])("maps finish_reason %s to %s", async (wire, expected) => {
    const result = await model().parseResponse(
      jsonResponse({
        choices: [{ message: { role: "assistant", content: "" }, finish_reason: wire }],
      }),
    );

    expect(result.stopReason).toBe(expected);
  });

  it("refuses a non-2xx with a coded AI_HTTP_ERROR carrying the status", async () => {
    const error = await model()
      .parseResponse(jsonResponse({}, 429))
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AiError);
    expect((error as AiError).code).toBe("AI_HTTP_ERROR");
    expect((error as AiError).details["status"]).toBe(429);
  });

  it("refuses tool arguments that are not valid JSON with AI_RESPONSE_MALFORMED", async () => {
    const error = await model()
      .parseResponse(
        jsonResponse({
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  { id: "t", type: "function", function: { name: "x", arguments: "{not json}" } },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        }),
      )
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AiError);
    expect((error as AiError).code).toBe("AI_RESPONSE_MALFORMED");
  });

  it("refuses tool arguments that parse but are not a JSON object (e.g. an array) with AI_RESPONSE_MALFORMED", async () => {
    const error = await model()
      .parseResponse(
        jsonResponse({
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  { id: "t", type: "function", function: { name: "x", arguments: "[1,2]" } },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        }),
      )
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AiError);
    expect((error as AiError).code).toBe("AI_RESPONSE_MALFORMED");
  });

  it("refuses a 2xx whose body is not JSON with AI_RESPONSE_MALFORMED (not an uncoded SyntaxError)", async () => {
    // A misconfigured local gateway/proxy returning a 200 with an HTML/text body — realistic
    // for the LM Studio/Ollama audience. `response.json()` would throw a raw SyntaxError; the
    // parser must convert it to the coded refusal the boundary can branch on.
    const html = new Response("<html>not json</html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });

    const error = await model()
      .parseResponse(html)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AiError);
    expect((error as AiError).code).toBe("AI_RESPONSE_MALFORMED");
  });

  it("refuses a 2xx with no choices — never a fabricated empty end_turn success", async () => {
    // The error-shaped 200 some OpenAI-compatible gateways return (`{}` or `{error:...}`). A bare
    // optional-chain would fail open to { text:"", stopReason:"end_turn" } — a silent "model said
    // nothing" the agent loop reads as a finished run. It must refuse loudly instead.
    const error = await model()
      .parseResponse(jsonResponse({ error: "model not loaded" }))
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AiError);
    expect((error as AiError).code).toBe("AI_RESPONSE_MALFORMED");
  });

  it("refuses a 2xx whose choice carries no message with AI_RESPONSE_MALFORMED", async () => {
    const error = await model()
      .parseResponse(jsonResponse({ choices: [{ finish_reason: "stop" }] }))
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AiError);
    expect((error as AiError).code).toBe("AI_RESPONSE_MALFORMED");
  });
});

describe("parseStream", () => {
  it("yields content deltas and ignores the role-only opening delta + empty content", async () => {
    const frames = [
      'data: {"choices":[{"delta":{"role":"assistant","content":""}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      "data: [DONE]\n\n",
    ];

    const deltas: string[] = [];

    for await (const delta of model().parseStream(sseResponse(frames))) {
      deltas.push(delta.text);
    }

    expect(deltas).toEqual(["Hel", "lo"]);
  });

  it("folds finish_reason + the terminal usage chunk into the returned final (not yielded)", async () => {
    const frames = [
      'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      // The terminal usage chunk: empty choices, usage set (stream_options.include_usage).
      'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":7}}\n\n',
      "data: [DONE]\n\n",
    ];

    const { texts, final } = await collectStream(model().parseStream(sseResponse(frames)));

    expect(texts).toEqual(["Hi"]);
    expect(final).toEqual({ usage: { inputTokens: 12, outputTokens: 7 }, stopReason: "end_turn" });
  });

  it("captures a content delta and finish_reason arriving on the SAME chunk", async () => {
    // Some servers set finish_reason on the last content-bearing chunk. The additive frame
    // shape must yield the text AND record the stop reason — neither dropped.
    const frames = [
      'data: {"choices":[{"delta":{"content":"done"},"finish_reason":"length"}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":4}}\n\n',
    ];

    const { texts, final } = await collectStream(model().parseStream(sseResponse(frames)));

    expect(texts).toEqual(["done"]);
    expect(final).toEqual({ usage: { inputTokens: 2, outputTokens: 4 }, stopReason: "max_tokens" });
  });

  it("returns just the stop reason when a finish_reason arrived but no usage chunk did", async () => {
    const frames = [
      'data: {"choices":[{"delta":{"content":"x"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    ];

    const { final } = await collectStream(model().parseStream(sseResponse(frames)));

    expect(final).toEqual({ stopReason: "tool_use" });
  });

  it("returns usage without a stop reason when the usage chunk arrived but no finish_reason did", async () => {
    const frames = [
      'data: {"choices":[{"delta":{"content":"x"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":9}}\n\n',
    ];

    const { final } = await collectStream(model().parseStream(sseResponse(frames)));

    expect(final).toEqual({ usage: { inputTokens: 5, outputTokens: 9 } });
  });

  it("returns undefined — NOT a fabricated zero — when the stream tore before any usage/stop frame", async () => {
    const frames = ['data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'];

    const { texts, final } = await collectStream(model().parseStream(sseResponse(frames)));

    expect(texts).toEqual(["partial"]);
    expect(final).toBeUndefined();
  });

  it("reassembles a frame split across two network reads", async () => {
    const frames = ['data: {"choices":[{"delta":', '{"content":"joined"}}]}\n\n'];

    const deltas: string[] = [];

    for await (const delta of model().parseStream(sseResponse(frames))) {
      deltas.push(delta.text);
    }

    expect(deltas).toEqual(["joined"]);
  });

  it("flushes a final content delta the stream closed without a trailing blank line", async () => {
    const frames = [
      'data: {"choices":[{"delta":{"content":"first"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"last"}}]}',
    ];

    const deltas: string[] = [];

    for await (const delta of model().parseStream(sseResponse(frames))) {
      deltas.push(delta.text);
    }

    expect(deltas).toEqual(["first", "last"]);
  });

  it("tolerates a torn final frame from a dropped stream — yields what arrived, no throw", async () => {
    const frames = [
      'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"tru', // truncated JSON, no terminator
    ];

    const deltas: string[] = [];

    for await (const delta of model().parseStream(sseResponse(frames))) {
      deltas.push(delta.text);
    }

    expect(deltas).toEqual(["partial"]);
  });

  it("ignores a [DONE] sentinel and a comment-only frame", async () => {
    const frames = ["data: [DONE]\n\n", ": keep-alive comment\n\n"];

    const deltas: string[] = [];

    for await (const delta of model().parseStream(sseResponse(frames))) {
      deltas.push(delta.text);
    }

    expect(deltas).toEqual([]);
  });

  it("refuses a non-2xx stream with AI_HTTP_ERROR", async () => {
    const iterate = async (): Promise<void> => {
      for await (const _ of model().parseStream(sseResponse([], 500))) {
        // drain
      }
    };

    const error = await iterate().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AiError);
    expect((error as AiError).code).toBe("AI_HTTP_ERROR");
  });

  it("refuses a stream with no body", async () => {
    const iterate = async (): Promise<void> => {
      for await (const _ of model().parseStream(new Response(null, { status: 200 }))) {
        // drain
      }
    };

    const error = await iterate().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AiError);
    expect((error as AiError).code).toBe("AI_STREAM_MALFORMED");
  });

  it("refuses a malformed (non-JSON) data frame mid-stream with AI_STREAM_MALFORMED", async () => {
    const iterate = async (): Promise<void> => {
      for await (const _ of model().parseStream(sseResponse(["data: {not json}\n\n"]))) {
        // drain
      }
    };

    const error = await iterate().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AiError);
    expect((error as AiError).code).toBe("AI_STREAM_MALFORMED");
  });

  it("cancels the upstream body when the consumer breaks early (no leaked reader)", async () => {
    let cancelled = false;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"b"}}]}\n\n'));
        // Deliberately NOT closed — an open stream the consumer walks away from.
      },
      cancel() {
        cancelled = true;
      },
    });

    const response = new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

    for await (const delta of model().parseStream(response)) {
      expect(delta.text).toBe("a");
      break; // early break → generator return() → finally → reader.cancel()
    }

    expect(cancelled).toBe(true);
  });

  it("swallows a REJECTING cancel() on an early break — the clean break still completes", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'));
      },
      cancel() {
        throw new Error("cancel boom");
      },
    });

    const response = new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

    let broke = false;
    for await (const delta of model().parseStream(response)) {
      expect(delta.text).toBe("a");
      broke = true;
      break;
    }

    expect(broke).toBe(true);
  });

  it("a rejecting cancel() does not mask a mid-stream AI_STREAM_MALFORMED", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("data: {not json}\n\n"));
      },
      cancel() {
        throw new Error("cancel boom");
      },
    });

    const response = new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

    const error = await (async () => {
      for await (const _ of model().parseStream(response)) {
        // drain — the malformed frame throws on the first pull
      }
    })().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AiError);
    expect((error as AiError).code).toBe("AI_STREAM_MALFORMED");
  });
});

describe("end-to-end through the shared model core", () => {
  it("generateText round-trips against a fake transport with no network", async () => {
    const { transport, requests } = constantTransport(jsonResponse(openaiTextMessage("ok")));
    const m = model({ transport });

    const result = await generateText({ model: m, messages: [{ role: "user", content: "hi" }] });

    expect(result.text).toBe("ok");
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 5 });
    expect(requests).toHaveLength(1);
  });

  it("streamText round-trips the deltas through the shared core (no network)", async () => {
    const frames = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      "data: [DONE]\n\n",
    ];
    const { transport } = constantTransport(sseResponse(frames));
    const m = model({ transport });

    const deltas: string[] = [];
    for await (const delta of streamText({
      model: m,
      messages: [{ role: "user", content: "x" }],
    })) {
      deltas.push(delta.text);
    }

    expect(deltas).toEqual(["Hel", "lo"]);
  });

  it("fires the ai.generate span identically to the Anthropic path (model id, streaming flag, usage, stop reason)", async () => {
    // Acceptance: the telemetry seam is provider-agnostic — the OpenAI model must produce the
    // same `ai.generate` span shape `generateText` records for the Anthropic model.
    const { transport } = constantTransport(jsonResponse(openaiTextMessage("hi")));
    const m = model({ transport });
    const { tracer, spans } = recordingTracer();

    await generateText({ model: m, messages: [{ role: "user", content: "x" }], tracer });

    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe(AI_GENERATE_SPAN);
    expect(spans[0]?.status).toBe("ok");
    expect(spans[0]?.attributes).toEqual({
      [AI_MODEL_ATTR]: "local-model",
      [AI_STREAMING_ATTR]: false,
      [AI_USAGE_INPUT_TOKENS_ATTR]: 3,
      [AI_USAGE_OUTPUT_TOKENS_ATTR]: 5,
      [AI_STOP_REASON_ATTR]: "end_turn",
    });
  });

  it("runAgent drives a scripted tool exchange and replays it in the OpenAI wire shape", async () => {
    // Turn 1: the model asks for a tool. Turn 2: it answers with text.
    const { transport, requests } = scriptedTransport([
      jsonResponse(openaiToolUseMessage("call-1", "getWeather", { city: "Rome" })),
      jsonResponse(openaiTextMessage("It is sunny in Rome.")),
    ]);
    const m = model({ transport });

    const result = await runAgent({
      model: m,
      messages: [{ role: "user", content: "Weather in Rome?" }],
      tools: {
        getWeather: {
          description: "Current weather for a city.",
          inputSchema: { type: "object" },
          execute: async (input) => `sunny in ${String((input as { city: string }).city)}`,
        },
      },
      maxSteps: 4,
    });

    expect(result.text).toBe("It is sunny in Rome.");
    expect(result.steps).toHaveLength(1);
    expect(result.usage).toEqual({ inputTokens: 4 + 3, outputTokens: 6 + 5 });

    // The SECOND request must carry the tool exchange replayed in OpenAI's shape: the assistant's
    // tool_calls, then a role:"tool" answer keyed by the same id — proof the normalized
    // tool_use/tool_result blocks round-tripped back out through this adapter's serializer.
    const secondBody = (await requests[1]!.json()) as { messages: Record<string, unknown>[] };

    expect(secondBody.messages).toEqual([
      { role: "user", content: "Weather in Rome?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "getWeather", arguments: '{"city":"Rome"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call-1", content: "sunny in Rome" },
    ]);
  });
});

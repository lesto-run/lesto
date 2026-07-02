import { describe, expect, it } from "vitest";

import { createAnthropic } from "../src/anthropic";
import { AiError } from "../src/errors";
import { generateText, streamText } from "../src/generate";
import {
  AI_ERROR_CODE_ATTR,
  AI_GENERATE_SPAN,
  AI_MODEL_ATTR,
  AI_STOP_REASON_ATTR,
  AI_USAGE_INPUT_TOKENS_ATTR,
  AI_USAGE_OUTPUT_TOKENS_ATTR,
} from "../src/spans";

import { constantTransport, jsonResponse, sseResponse, textMessage } from "./fake-transport";
import { agentTracerAdapter, observabilityShapedTracer, recordingTracer } from "./fake-tracer";

describe("generateText", () => {
  it("sends the built request through the transport and returns the parsed result", async () => {
    const { transport, requests } = constantTransport(
      jsonResponse(textMessage("Mars, Venus, Earth.")),
    );
    const model = createAnthropic({ apiKey: "sk-test", transport });

    const result = await generateText({
      model,
      system: "Be terse.",
      messages: [{ role: "user", content: "Name three planets." }],
    });

    expect(result.text).toBe("Mars, Venus, Earth.");
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 5 });

    // The request that actually went over the (fake) transport carried the system prompt.
    const sent = (await requests[0]?.json()) as Record<string, unknown>;
    expect(sent["system"]).toBe("Be terse.");
    expect(sent["stream"]).toBe(false);
  });
});

describe("generateText — ai.generate span (ADR 0031 Phase 2, PREVIEW)", () => {
  it("opens one ai.generate span per call carrying model + usage + stop reason, status ok", async () => {
    const { transport } = constantTransport(jsonResponse(textMessage("done.")));
    const model = createAnthropic({ apiKey: "sk-test", transport });
    const { tracer, spans } = recordingTracer();

    const result = await generateText({
      model,
      messages: [{ role: "user", content: "go" }],
      tracer,
    });

    expect(spans).toHaveLength(1);
    const span = spans[0];
    expect(span?.name).toBe(AI_GENERATE_SPAN);
    expect(span?.status).toBe("ok");
    expect(span?.ended).toBe(true);
    // The attribute bag carries the data the call already had — the model id and the parsed usage.
    expect(span?.attributes).toEqual({
      [AI_MODEL_ATTR]: model.defaultModelId,
      [AI_USAGE_INPUT_TOKENS_ATTR]: result.usage.inputTokens,
      [AI_USAGE_OUTPUT_TOKENS_ATTR]: result.usage.outputTokens,
      [AI_STOP_REASON_ATTR]: result.stopReason,
    });
  });

  it("opens the span BEFORE the model call, so it brackets (times) the whole call", async () => {
    // The duration-bearing shape: the span must already be open — and NOT yet ended — when the
    // transport runs, proving it wraps the request/transport/parse rather than being a
    // point-in-time record written after the call resolves.
    const { tracer, spans } = recordingTracer();
    let openWhenCalled = false;
    let endedWhenCalled = true;

    const model = createAnthropic({
      apiKey: "sk-test",
      transport: async () => {
        openWhenCalled = spans.length === 1 && spans[0]?.name === AI_GENERATE_SPAN;
        endedWhenCalled = spans[0]?.ended ?? true;

        return jsonResponse(textMessage("timed."));
      },
    });

    await generateText({ model, messages: [{ role: "user", content: "go" }], tracer });

    expect(openWhenCalled).toBe(true);
    expect(endedWhenCalled).toBe(false);
    // …and it still closed cleanly, with the usage/stop-reason populated after the call.
    expect(spans[0]?.ended).toBe(true);
    expect(spans[0]?.attributes[AI_STOP_REASON_ATTR]).toBeDefined();
  });

  it("records the modelId override (not the model default) on the span", async () => {
    const { transport } = constantTransport(jsonResponse(textMessage("x")));
    const model = createAnthropic({ apiKey: "sk-test", transport });
    const { tracer, spans } = recordingTracer();

    await generateText({
      model,
      modelId: "claude-haiku-4-5-20251001",
      messages: [{ role: "user", content: "go" }],
      tracer,
    });

    expect(spans[0]?.attributes[AI_MODEL_ATTR]).toBe("claude-haiku-4-5-20251001");
  });

  it("marks the span error with the AiError code on a non-2xx, and still throws", async () => {
    const { transport } = constantTransport(jsonResponse({ error: "boom" }, 500));
    const model = createAnthropic({ apiKey: "sk-test", transport });
    const { tracer, spans } = recordingTracer();

    const error = await generateText({
      model,
      messages: [{ role: "user", content: "go" }],
      tracer,
    }).catch((e: unknown) => e);

    // The coded provider failure still propagates unchanged...
    expect(error).toBeInstanceOf(AiError);
    expect((error as AiError).code).toBe("AI_HTTP_ERROR");
    // ...and it left one errored ai.generate span carrying the code.
    expect(spans).toHaveLength(1);
    expect(spans[0]?.status).toBe("error");
    expect(spans[0]?.ended).toBe(true);
    expect(spans[0]?.attributes).toEqual({
      [AI_MODEL_ATTR]: model.defaultModelId,
      [AI_ERROR_CODE_ATTR]: "AI_HTTP_ERROR",
    });
  });

  it("is a clean no-op when no tracer is injected (unchanged behaviour)", async () => {
    const { transport, requests } = constantTransport(jsonResponse(textMessage("plain.")));
    const model = createAnthropic({ apiKey: "sk-test", transport });

    const result = await generateText({ model, messages: [{ role: "user", content: "go" }] });

    // Same result as the untraced path; the transport was still driven exactly once.
    expect(result.text).toBe("plain.");
    expect(requests).toHaveLength(1);
  });

  it("threads the attribute bag through the real Tracer-adapter onto the span (attribute-drop trap)", async () => {
    // The trap: an @lesto/observability `Tracer` reads attributes from `options.attributes`, so a
    // flat bag passed as the 2nd arg is dropped. Drive a generation through the documented adapter
    // over a signature-faithful tracer and assert the bag actually LANDS on the recorded span.
    const { transport } = constantTransport(jsonResponse(textMessage("adapted.")));
    const model = createAnthropic({ apiKey: "sk-test", transport });
    const shaped = observabilityShapedTracer();

    const result = await generateText({
      model,
      messages: [{ role: "user", content: "go" }],
      tracer: agentTracerAdapter(shaped.tracer),
    });

    expect(shaped.spans).toHaveLength(1);
    expect(shaped.spans[0]?.status).toBe("ok");
    // Had the adapter passed the bag flat, `.attributes` would be undefined — the trap.
    expect(shaped.spans[0]?.attributes).toEqual({
      [AI_MODEL_ATTR]: model.defaultModelId,
      [AI_USAGE_INPUT_TOKENS_ATTR]: result.usage.inputTokens,
      [AI_USAGE_OUTPUT_TOKENS_ATTR]: result.usage.outputTokens,
      [AI_STOP_REASON_ATTR]: result.stopReason,
    });
  });
});

describe("streamText", () => {
  it("streams text deltas through the transport", async () => {
    const frames = [
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"a"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"b"}}\n\n',
    ];

    const { transport, requests } = constantTransport(sseResponse(frames));
    const model = createAnthropic({ apiKey: "sk-test", transport });

    const deltas: string[] = [];

    for await (const delta of streamText({ model, messages: [{ role: "user", content: "x" }] })) {
      deltas.push(delta.text);
    }

    expect(deltas).toEqual(["a", "b"]);

    const sent = (await requests[0]?.json()) as Record<string, unknown>;
    expect(sent["stream"]).toBe(true);
  });
});

describe("streamText — ai.generate span (ADR 0031 Phase 2, PREVIEW)", () => {
  const twoFrames = [
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"a"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"b"}}\n\n',
  ];

  it("brackets the whole stream with one span: open before, still open mid-stream, ok + ended after", async () => {
    const { transport } = constantTransport(sseResponse(twoFrames));
    const model = createAnthropic({ apiKey: "sk-test", transport });
    const { tracer, spans } = recordingTracer();

    const deltas: string[] = [];
    for await (const delta of streamText({
      model,
      messages: [{ role: "user", content: "x" }],
      tracer,
    })) {
      // The span is open for the whole stream — not yet ended while frames are still arriving.
      expect(spans[0]?.ended).toBe(false);
      deltas.push(delta.text);
    }

    expect(deltas).toEqual(["a", "b"]);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe(AI_GENERATE_SPAN);
    // The streamed span carries the model id + outcome — but no post-hoc Usage/StopReason (the
    // delta stream yields text only), so its attribute bag is just the model id.
    expect(spans[0]?.attributes).toEqual({ [AI_MODEL_ATTR]: model.defaultModelId });
    expect(spans[0]?.status).toBe("ok");
    expect(spans[0]?.ended).toBe(true);
  });

  it("marks the stream span error with the AiError code and still ends it, on a non-2xx", async () => {
    const { transport } = constantTransport(jsonResponse({ error: "boom" }, 500));
    const model = createAnthropic({ apiKey: "sk-test", transport });
    const { tracer, spans } = recordingTracer();

    const error = await (async () => {
      for await (const _ of streamText({
        model,
        messages: [{ role: "user", content: "x" }],
        tracer,
      })) {
        // drain — the throw comes on the first pull
      }
    })().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AiError);
    expect((error as AiError).code).toBe("AI_HTTP_ERROR");
    expect(spans).toHaveLength(1);
    expect(spans[0]?.status).toBe("error");
    expect(spans[0]?.attributes).toEqual({
      [AI_MODEL_ATTR]: model.defaultModelId,
      [AI_ERROR_CODE_ATTR]: "AI_HTTP_ERROR",
    });
    expect(spans[0]?.ended).toBe(true);
  });

  it("is a clean no-op when no tracer is injected", async () => {
    const { transport } = constantTransport(sseResponse(twoFrames));
    const model = createAnthropic({ apiKey: "sk-test", transport });

    const deltas: string[] = [];
    for await (const delta of streamText({ model, messages: [{ role: "user", content: "x" }] })) {
      deltas.push(delta.text);
    }

    expect(deltas).toEqual(["a", "b"]);
  });

  it("an early for-await break still ends the span (via IteratorClose), leaving status unset", async () => {
    const { transport } = constantTransport(sseResponse(twoFrames));
    const model = createAnthropic({ apiKey: "sk-test", transport });
    const { tracer, spans } = recordingTracer();

    for await (const delta of streamText({
      model,
      messages: [{ role: "user", content: "x" }],
      tracer,
    })) {
      expect(delta.text).toBe("a");
      break; // for-await's IteratorClose forces the generator's return() → the finally.
    }

    expect(spans).toHaveLength(1);
    expect(spans[0]?.ended).toBe(true);
    // Never reached "ok" (the break skipped it) — an honest "we don't know", not a fabricated success.
    expect(spans[0]?.status).toBe("unset");
  });
});

describe("telemetry isolation — a broken tracer never masks the real result (ADR 0031 Phase 2)", () => {
  it("generateText still returns the real result when setStatus/end throw on the success path", async () => {
    const { transport } = constantTransport(jsonResponse(textMessage("still works.")));
    const model = createAnthropic({ apiKey: "sk-test", transport });

    const brokenTracer = {
      startSpan: () => ({
        setAttributes: () => {
          throw new Error("boom: broken tracer");
        },
        setStatus: () => {
          throw new Error("boom: broken tracer");
        },
        end: () => {
          throw new Error("boom: broken tracer");
        },
      }),
    };

    const result = await generateText({
      model,
      messages: [{ role: "user", content: "go" }],
      tracer: brokenTracer,
    });

    // The broken tracer's throws were swallowed — the real result still comes back, not an error.
    expect(result.text).toBe("still works.");
  });

  it("generateText still throws the ORIGINAL AiError, not a tracer fault, when the tracer breaks on the error path", async () => {
    const { transport } = constantTransport(jsonResponse({ error: "boom" }, 500));
    const model = createAnthropic({ apiKey: "sk-test", transport });

    const brokenTracer = {
      startSpan: () => ({
        setStatus: () => {
          throw new Error("boom: broken tracer");
        },
        end: () => {
          throw new Error("boom: broken tracer");
        },
      }),
    };

    const error = await generateText({
      model,
      messages: [{ role: "user", content: "go" }],
      tracer: brokenTracer,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AiError);
    expect((error as AiError).code).toBe("AI_HTTP_ERROR");
  });

  it("streamText still yields every delta and ends the (broken) span when setStatus/end throw", async () => {
    const frames = [
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"a"}}\n\n',
    ];
    const { transport } = constantTransport(sseResponse(frames));
    const model = createAnthropic({ apiKey: "sk-test", transport });

    let endCalled = false;
    const brokenTracer = {
      startSpan: () => ({
        setStatus: () => {
          throw new Error("boom: broken tracer");
        },
        end: () => {
          endCalled = true;
          throw new Error("boom: broken tracer");
        },
      }),
    };

    const deltas: string[] = [];
    for await (const delta of streamText({
      model,
      messages: [{ role: "user", content: "x" }],
      tracer: brokenTracer,
    })) {
      deltas.push(delta.text);
    }

    expect(deltas).toEqual(["a"]);
    expect(endCalled).toBe(true);
  });
});

describe("the attribute-drop trap, proven directly on observabilityShapedTracer", () => {
  it("a post-hoc setAttribute still records after a dropped start bag — but the dropped attribute stays gone", () => {
    const shaped = observabilityShapedTracer();

    // Simulates a BROKEN Tracer→AgentTracer adapter that dropped the start-time bag entirely
    // (e.g. it called `tracer.startSpan(name)` with no options) — the exact failure mode
    // `agentTracerAdapter` (the documented recipe) avoids by always nesting under `attributes`.
    const span = shaped.tracer.startSpan(AI_GENERATE_SPAN);
    span.setAttribute(AI_STOP_REASON_ATTR, "end_turn");

    // The post-hoc attribute recorded (materializing a fresh bag)...
    expect(shaped.spans[0]?.attributes).toEqual({ [AI_STOP_REASON_ATTR]: "end_turn" });
    // ...but `ai.model`, which only ever rides in the START bag, is provably gone — the drop this
    // double exists to make visible.
    expect(shaped.spans[0]?.attributes).not.toHaveProperty(AI_MODEL_ATTR);
  });
});

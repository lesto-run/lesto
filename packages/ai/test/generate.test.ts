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

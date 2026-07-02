/**
 * Unit tests for the AI concierge module (`src/assistant.ts`) — ADR 0031 Inc 4.
 *
 * The in-request span-parenting dogfood lives in `ai-trace.dogfood.test.ts` (node)
 * and `edge-assistant.test.ts` (edge). This file covers the module's other two
 * contracts: that estate is the seam where the two re-stated span vocabularies are
 * asserted equal, and that `resolveAssistantModel` picks the right model from the
 * environment (the local demo model with no key, a real Anthropic model with one).
 */

import { describe, expect, it } from "vitest";

import {
  AI_GENERATE_SPAN,
  AI_MODEL_ATTR,
  AI_STOP_REASON_ATTR,
  AI_STREAMING_ATTR,
  AI_TOOL_NAME_ATTR,
  AI_TOOL_SPAN,
  AI_USAGE_INPUT_TOKENS_ATTR,
  AI_USAGE_OUTPUT_TOKENS_ATTR,
  DEFAULT_MODEL_ID,
  generateText,
} from "@lesto/ai";
import type { Transport } from "@lesto/ai";
import {
  AI_GENERATE_SPAN as OBS_AI_GENERATE_SPAN,
  AI_MODEL_ATTR as OBS_AI_MODEL_ATTR,
  AI_STOP_REASON_ATTR as OBS_AI_STOP_REASON_ATTR,
  AI_STREAMING_ATTR as OBS_AI_STREAMING_ATTR,
  AI_TOOL_NAME_ATTR as OBS_AI_TOOL_NAME_ATTR,
  AI_TOOL_SPAN as OBS_AI_TOOL_SPAN,
  AI_USAGE_INPUT_TOKENS_ATTR as OBS_AI_USAGE_INPUT_TOKENS_ATTR,
  AI_USAGE_OUTPUT_TOKENS_ATTR as OBS_AI_USAGE_OUTPUT_TOKENS_ATTR,
} from "@lesto/observability";

import { localAssistantModel, resolveAssistantModel } from "../src/assistant";

describe("the shared AI span vocabulary agrees across the layer", () => {
  // ADR 0031 Inc 4: `@lesto/ai` and `@lesto/observability` RE-STATE the vocabulary
  // rather than import across the layer; estate is the consumer that depends on both,
  // so this is where they are asserted equal. A drift in either package fails here.
  it("`@lesto/ai`'s re-stated names/attrs equal `@lesto/observability`'s canonical set", () => {
    expect(AI_GENERATE_SPAN).toBe(OBS_AI_GENERATE_SPAN);
    expect(AI_TOOL_SPAN).toBe(OBS_AI_TOOL_SPAN);
    expect(AI_MODEL_ATTR).toBe(OBS_AI_MODEL_ATTR);
    expect(AI_USAGE_INPUT_TOKENS_ATTR).toBe(OBS_AI_USAGE_INPUT_TOKENS_ATTR);
    expect(AI_USAGE_OUTPUT_TOKENS_ATTR).toBe(OBS_AI_USAGE_OUTPUT_TOKENS_ATTR);
    expect(AI_STOP_REASON_ATTR).toBe(OBS_AI_STOP_REASON_ATTR);
    expect(AI_STREAMING_ATTR).toBe(OBS_AI_STREAMING_ATTR);
    expect(AI_TOOL_NAME_ATTR).toBe(OBS_AI_TOOL_NAME_ATTR);
  });
});

describe("resolveAssistantModel picks the model from the environment", () => {
  it("falls back to the committed local demo model when no API key is set", () => {
    expect(resolveAssistantModel().defaultModelId).toBe("lesto-local-demo");
    expect(resolveAssistantModel({}).defaultModelId).toBe("lesto-local-demo");
    expect(resolveAssistantModel({ apiKey: "" }).defaultModelId).toBe("lesto-local-demo");
    // The local model is a real, standalone `LanguageModel`.
    expect(localAssistantModel().defaultModelId).toBe("lesto-local-demo");
  });

  it("builds a real Anthropic model when an API key is set, driven off the injected transport", async () => {
    // The `transport` seam is what lets the real-model branch run with no network:
    // a canned Anthropic Messages response the model's `parseResponse` normalizes.
    const transport: Transport = async () =>
      new Response(
        JSON.stringify({
          content: [{ type: "text", text: "A grounded answer." }],
          stop_reason: "end_turn",
          usage: { input_tokens: 5, output_tokens: 7 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    const model = resolveAssistantModel({ apiKey: "sk-test-key", transport });
    expect(model.defaultModelId).toBe(DEFAULT_MODEL_ID);

    const result = await generateText({ model, messages: [{ role: "user", content: "hi" }] });
    expect(result.text).toBe("A grounded answer.");
    expect(result.stopReason).toBe("end_turn");
    expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 7 });
  });
});

import { describe, expect, it, vi } from "vitest";

import { runAgent } from "../src/agent";
import { createAnthropic } from "../src/anthropic";
import { AiError } from "../src/errors";

import { jsonResponse, scriptedTransport, textMessage, toolUseMessage } from "./fake-transport";

import type { ToolSet } from "../src/types";

const weatherTools = (impl: () => Promise<string>): ToolSet => ({
  getWeather: {
    description: "Current weather for a city.",
    inputSchema: { type: "object", properties: { city: { type: "string" } } },
    execute: impl,
  },
});

describe("runAgent", () => {
  it("drives a tool call then a final text turn to completion", async () => {
    // Turn 1: the model asks for getWeather. Turn 2: it answers in text.
    const { transport, requests } = scriptedTransport([
      jsonResponse(toolUseMessage("call-1", "getWeather", { city: "Rome" })),
      jsonResponse(textMessage("It's sunny in Rome.")),
    ]);

    const model = createAnthropic({ apiKey: "sk-test", transport });
    const execute = vi.fn(async () => "sunny, 24C");

    const result = await runAgent({
      model,
      messages: [{ role: "user", content: "Weather in Rome?" }],
      tools: weatherTools(execute),
    });

    expect(result.text).toBe("It's sunny in Rome.");
    expect(execute).toHaveBeenCalledWith({ city: "Rome" });

    // One step recorded (the tool turn); usage summed across both model turns.
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.toolCalls[0]?.name).toBe("getWeather");
    expect(result.steps[0]?.toolResults).toEqual(["sunny, 24C"]);
    expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 11 });

    // The second model call saw the tool result fed back into the conversation.
    const secondBody = (await requests[1]?.json()) as { messages: { content: string }[] };
    const lastTurn = secondBody.messages.at(-1);
    expect(lastTurn?.content).toContain("Result of getWeather: sunny, 24C");
  });

  it("returns immediately when the first turn is plain text", async () => {
    const { transport } = scriptedTransport([jsonResponse(textMessage("No tools needed."))]);
    const model = createAnthropic({ apiKey: "sk-test", transport });

    const result = await runAgent({
      model,
      messages: [{ role: "user", content: "hi" }],
      tools: weatherTools(async () => "x"),
    });

    expect(result.text).toBe("No tools needed.");
    expect(result.steps).toHaveLength(0);
  });

  it("does not mutate the caller's messages array", async () => {
    const { transport } = scriptedTransport([
      jsonResponse(toolUseMessage("c", "getWeather", {})),
      jsonResponse(textMessage("done")),
    ]);

    const model = createAnthropic({ apiKey: "sk-test", transport });
    const messages = [{ role: "user" as const, content: "go" }];

    await runAgent({ model, messages, tools: weatherTools(async () => "r") });

    expect(messages).toEqual([{ role: "user", content: "go" }]);
  });

  it("refuses an unknown tool name with AI_TOOL_NOT_FOUND", async () => {
    const { transport } = scriptedTransport([jsonResponse(toolUseMessage("c", "ghostTool", {}))]);

    const model = createAnthropic({ apiKey: "sk-test", transport });

    const error = await runAgent({
      model,
      messages: [{ role: "user", content: "x" }],
      tools: weatherTools(async () => "r"),
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AiError);
    expect((error as AiError).code).toBe("AI_TOOL_NOT_FOUND");
    expect((error as AiError).details["name"]).toBe("ghostTool");
  });

  it("refuses a runaway loop with AI_MAX_STEPS_EXCEEDED", async () => {
    // The model always asks for a tool; the loop must stop at the budget.
    const { transport } = scriptedTransport([
      jsonResponse(toolUseMessage("a", "getWeather", {})),
      jsonResponse(toolUseMessage("b", "getWeather", {})),
    ]);

    const model = createAnthropic({ apiKey: "sk-test", transport });

    const error = await runAgent({
      model,
      messages: [{ role: "user", content: "x" }],
      tools: weatherTools(async () => "r"),
      maxSteps: 2,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AiError);
    expect((error as AiError).code).toBe("AI_MAX_STEPS_EXCEEDED");
    expect((error as AiError).details["maxSteps"]).toBe(2);
  });

  it("refuses an invalid maxSteps", async () => {
    const { transport } = scriptedTransport([]);
    const model = createAnthropic({ apiKey: "sk-test", transport });

    const error = await runAgent({
      model,
      messages: [],
      tools: weatherTools(async () => "r"),
      maxSteps: 0,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AiError);
    expect((error as AiError).code).toBe("AI_INVALID_OPTION");
  });

  it("treats a tool_use stop with no tool calls as completion", async () => {
    // Degenerate provider turn: stop_reason tool_use but an empty content array.
    const { transport } = scriptedTransport([
      jsonResponse({
        content: [],
        stop_reason: "tool_use",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    ]);

    const model = createAnthropic({ apiKey: "sk-test", transport });

    const result = await runAgent({
      model,
      messages: [{ role: "user", content: "x" }],
      tools: weatherTools(async () => "r"),
    });

    expect(result.text).toBe("");
    expect(result.steps).toHaveLength(0);
  });
});

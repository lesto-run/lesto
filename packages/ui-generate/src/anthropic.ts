/**
 * The real model call: a thin wrapper over the Anthropic SDK.
 *
 * This is the one network boundary. It holds no business logic — it constructs
 * the client, forwards the forced tool, and returns the tool_use block's input.
 * All of the logic that matters (schema building, validation) lives in covered
 * modules; this file is excluded from coverage because exercising it means
 * making a real API call.
 */

import Anthropic from "@anthropic-ai/sdk";

import type { Complete } from "./generate";

/** Build a `Complete` backed by the Anthropic Messages API. */
export function anthropicComplete(options?: { apiKey?: string; model?: string }): Complete {
  const client = new Anthropic(options?.apiKey === undefined ? {} : { apiKey: options.apiKey });

  return async (request) => {
    const message = await client.messages.create({
      model: options?.model ?? "claude-opus-4-8",
      max_tokens: 16000,
      system: request.system,
      tools: [
        {
          name: request.tool.name,
          description: request.tool.description,
          input_schema: request.tool.inputSchema as Anthropic.Tool.InputSchema,
        },
      ],
      tool_choice: { type: "tool", name: request.tool.name },
      messages: [{ role: "user", content: request.prompt }],
    });

    const toolUse = message.content.find((block) => block.type === "tool_use");

    return toolUse?.input;
  };
}

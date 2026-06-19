import { describe, expect, it } from "vitest";

import { createAnthropic } from "../src/anthropic";
import { generateText, streamText } from "../src/generate";

import { constantTransport, jsonResponse, sseResponse, textMessage } from "./fake-transport";

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

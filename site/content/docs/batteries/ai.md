---
title: AI
description: Provider-agnostic AI primitives — text generation, streaming, an agent/tool loop, retrieval, and evals. Preview.
section: Batteries
order: 9
---

# AI

`@lesto/ai` is a dependency-free, provider-agnostic layer for building AI
features: a model interface, an agent loop, retrieval, and evals — over an
injected `fetch` transport, so it is fully testable with no network.

> **Preview.** `@lesto/ai`'s surface is experimental and exempt from the coverage
> gate; expect it to move before 1.0.

## Generate text

```ts
import { createAnthropic, generateText, streamText } from "@lesto/ai";

const model = createAnthropic({ apiKey: env.ANTHROPIC_API_KEY }); // default claude-opus-4-8

const { text } = await generateText({
  model,
  messages: [{ role: "user", content: "Summarize this changelog." }],
});

for await (const chunk of streamText({ model, messages })) {
  process.stdout.write(chunk);
}
```

## Agents, retrieval, evals

The same package carries the next layers up:

- `runAgent` — a tool/agent loop over a `ToolSet`.
- `MemoryVectorStore` + `retrieve` — a retrieval seam for RAG.
- `createLlmJudge` + `guard` — evals and guardrails.

```ts
import { runAgent } from "@lesto/ai";

const result = await runAgent({ model, tools, messages });
```

Because the transport is injected, every layer is unit-testable without a live
API — point it at a fake and assert the conversation.

---
title: AI
description: Provider-agnostic AI primitives — text generation, streaming, an agent/tool loop, retrieval, and evals. Preview.
section: Batteries
order: 9
---

# AI

`@lesto/ai` is the developer-facing half of Lesto's AI story. The MCP control
plane lets agents *operate* Lesto; this package lets you *build* AI features into
a Lesto app — text generation, streaming, a bounded agent/tool loop, retrieval,
and evals.

It is provider-agnostic and dependency-free. The whole package is the Anthropic
Messages API behind a `LanguageModel` interface, sent over an **injected `fetch`
transport** — the same call `@lesto/auth` makes doing TOTP over `node:crypto`
instead of a library. Because the transport is a parameter, every layer is
unit-testable with a fake response and no network.

> [!IMPORTANT]
> **Preview.** `@lesto/ai` is experimental and exempt from the 100%-coverage gate
> (it declares no `test:cov` script). The surface will move before 1.0. Its pure
> core is still fully tested; just don't pin a release on these signatures yet.

## Generate text

`createAnthropic` returns a `LanguageModel`. The default model id is
`claude-opus-4-8`; pass `defaultModelId` to change it, or override per-call with
`modelId`. The model is always an explicit field — never a hidden global — so you
pick Haiku for cheap classification and Opus for hard reasoning at the call site.

```ts
import { createAnthropic, generateText } from "@lesto/ai";

const model = createAnthropic({ apiKey: env.ANTHROPIC_API_KEY }); // default claude-opus-4-8

const { text, usage, stopReason } = await generateText({
  model,
  system: "You are a terse release-notes writer.",
  messages: [{ role: "user", content: "Summarize this changelog." }],
});
```

`generateText` resolves to `{ text, toolCalls, stopReason, usage }`. A non-2xx
from the provider throws an `AiError` coded `AI_HTTP_ERROR` with the status in
`details`, so the boundary branches on the code, never on a message string.

`streamText` yields `StreamDelta` objects — destructure `text` off each frame:

```ts
import { streamText } from "@lesto/ai";

for await (const { text } of streamText({ model, messages })) {
  process.stdout.write(text);
}
```

On Workers the underlying `ReadableStream` pipes straight to the client response
(`waitUntil` keeps the generation alive past the first byte). A frame whose data
is unparseable throws `AI_STREAM_MALFORMED` rather than silently dropping tokens.

## Agents

`runAgent` drives a bounded tool-use loop: the model emits a tool call, the loop
runs the matching tool, feeds the result back, and repeats until the model stops
asking for tools. A `ToolSet` is a name→spec map; each `ToolSpec` carries a
`description` and `inputSchema` (sent to the model) plus an `execute` function
(your code).

```ts
import { runAgent } from "@lesto/ai";
import type { ToolSet } from "@lesto/ai";

const tools: ToolSet = {
  getWeather: {
    description: "Look up the current weather for a city.",
    inputSchema: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
    execute: async ({ city }) => JSON.stringify(await weather(city as string)),
  },
};

const { text, steps, usage } = await runAgent({
  model,
  tools,
  messages: [{ role: "user", content: "What should I wear in Oslo today?" }],
  maxSteps: 6, // defaults to 8
});
```

The loop is bounded by construction: an agent that never stops surfaces loudly as
`AI_MAX_STEPS_EXCEEDED`, never a hang. A model that asks for an unregistered tool
is refused with `AI_TOOL_NOT_FOUND` rather than silently skipped. The returned
`steps` are the audit trail — each step's `toolCalls` and the `toolResults` they
produced. Validating a tool's `input` against its schema before acting is your
boundary concern (the same Zod-at-the-edge story as the rest of Lesto); the loop
passes the model's arguments through untouched.

## Retrieval

Lesto owns the *seam*, not a vector database. `VectorStore` is an interface; the
two real backends — pgvector on the Postgres leg and Cloudflare Vectorize on the
edge — are deferred behind the same parity gate `@lesto/db` lives under.
`MemoryVectorStore` is the in-memory, brute-force stand-in that proves the RAG
flow with no database.

`retrieve` is the *retrieve* half of retrieve-then-generate. It takes an
**already-computed** query embedding (from `@lesto/content-embeddings` or your own
embedder — this layer never embeds), returns the nearest matches, and assembles
their text into one context block to prepend to a prompt.

```ts
import { MemoryVectorStore, retrieve } from "@lesto/ai";

const store = new MemoryVectorStore();
await store.upsert([
  { id: "doc-1", embedding: embedOf(doc1), text: doc1 },
  { id: "doc-2", embedding: embedOf(doc2), text: doc2 },
]);

const { matches, context } = await retrieve({ store, embedding: queryVector, topK: 3 });

const { text } = await generateText({
  model,
  system: `Use this context:\n\n${context}`,
  messages: [{ role: "user", content: question }],
});
```

`MemoryVectorStore` does an O(n) cosine scan — correct and dependency-free, fine
for tests and demos, not for production scale. A real backend does the
nearest-neighbour search in the database behind the same interface.

## Evals and guardrails

An `Eval` is a pure function `(input, output) => Promise<EvalResult>`. That is
the whole abstraction. An LLM-judge eval is just an `Eval` that itself calls
`generateText`, so it composes with the model layer with zero new machinery —
and is testable with the same fake transport.

```ts
import { createLlmJudge, guard } from "@lesto/ai";

const helpful = createLlmJudge({
  model,
  rubric: "Score how directly the answer addresses the question, 0 to 1.",
  threshold: 0.6, // defaults to 0.5
}); // judge model defaults to claude-sonnet-4-6

// `guard` returns the output if it passes, or throws AI_GUARDRAIL_BLOCKED.
const safe = await guard(answer, question, helpful);
```

The judge is prompted for a bare number and tolerates prose around it; an
unparseable verdict scores 0 (failed) rather than crashing the request. `guard`
runs an eval as a gate before you return: a failed check throws `AiError` coded
`AI_GUARDRAIL_BLOCKED`, carrying the eval's score and code in `details`, so the
boundary maps a blocked output to a deliberate HTTP response instead of leaking
it.

## Notes and gotchas

- **Preview means movement.** Signatures here can change before 1.0. Build with
  it, but don't depend on the exact shapes in a release you ship.
- **`streamText` yields `{ text }`, not strings.** Destructure the delta; writing
  the frame object directly is a common slip.
- **The injected transport is the testing story.** Pass a fake `Transport` to
  `createAnthropic` that returns canned `Response`s and you exercise message
  assembly, response parsing, the agent loop, and SSE parsing with no network —
  no live API key, no flakiness.
- **The model is always explicit.** Default is `claude-opus-4-8`; the LLM judge
  defaults to `claude-sonnet-4-6`. Override either with `modelId` per call.
- **Errors carry codes.** Branch on `AI_HTTP_ERROR`, `AI_STREAM_MALFORMED`,
  `AI_TOOL_NOT_FOUND`, `AI_MAX_STEPS_EXCEEDED`, `AI_GUARDRAIL_BLOCKED`, or
  `AI_INVALID_OPTION` — never on the message string.

For how this layer sits on top of Lesto's durable stores, queue, and data layer,
see [Concepts](/concepts).

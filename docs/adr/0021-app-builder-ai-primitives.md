# ADR 0021 — App-builder AI primitives: a provider-agnostic model layer, agent loop, retrieval seam, and evals

- **Status:** Proposed
- **Date:** 2026-06-18
- **Deciders:** tech lead + owner
- **Supersedes nothing. Extends ADR 0005 (validation at the boundary), ADR 0006 (async seam), ADR 0013 (durable stores), ADR 0018 (relational data layer / pgvector-adjacent substrate). Distinct from ADR 0014 (plugin system) and the MCP control plane.**
- **Decision in one line:** **IN.** Lesto enters the app-builder-AI lane with a new PREVIEW package `@lesto/ai`, scoped as four increments and built dependency-free over `fetch`, exactly as the framework does TOTP over `node:crypto` rather than a library.

## Context

Lesto already says "AI-native," but the phrase means **two different things** and Lesto only does one of them:

1. **Agents operate the framework** — the MCP control plane (`packages/mcp/`, ATTACK-PLAN Bet IV): Claude Desktop adds a content type, generates a UI block, migrates, deploys. This is genuinely novel and it is built.
2. **Developers build AI features *into their app*** — `generateText` / `streamText` over a provider, a tool/agent loop, conversation memory, RAG/vector retrieval, evals/guardrails. **Lesto offers nothing here.**

Sense (2) is what the 2026 mainstream means by "AI-native framework," and the field has consolidated around it:

- **Vercel AI SDK** — `generateText`/`streamText` + `generateObject` over a provider registry, a tool loop, framework-bound UI streaming hooks.
- **Mastra** — agents, workflows, memory, RAG, evals as one batteries-included TS package.
- **Cloudflare Agents SDK** — stateful agents on Durable Objects, scheduling, WebSockets, the same `generateText` ergonomics bound to Workers.

A developer who picks Lesto today to build a support bot, a RAG search box, or a "summarize this" endpoint **leaves immediately** — there is no model call, no streaming primitive, no retrieval seam. Lesto has a queue, durable stores, auth, a relational data layer with a Postgres leg, and a Cloudflare edge target — i.e. *the entire substrate an AI feature needs* — and then stops one layer short of the feature itself. That is the gap this ADR closes.

### Why this is the right gap to take, and why it is small

This is **not** speculative scope-chasing. Three facts make it a tight, on-thesis move:

1. **The substrate is already ours.** Memory is a `SessionStore`-shaped durable store (ADR 0013). Background generation is a `@lesto/queue` job. Validation of a model's structured output is the *exact* boundary-Zod story ADR 0005 already mandates. The vector index is a pgvector column on the Postgres leg (ADR 0018) or Cloudflare Vectorize on the edge leg — the same dialect/edge-parity split `@lesto/db` already lives. We are not inventing primitives; we are **threading the model call through primitives we already ship.**
2. **The hard, opinion-heavy part is a thin transport seam, not an SDK.** The Anthropic Messages API is a single `POST /v1/messages` (plus an SSE variant for streaming). Wrapping it is ~a screen of `fetch`. The framework already refuses dependencies for exactly this shape: **`@lesto/auth` implements TOTP/HOTP with `node:crypto`, not `otplib`** (ADR 0020). The same call applies — **prefer `fetch` to the Anthropic API over `@anthropic-ai/sdk`.** A vendored SDK would also fight ADR 0006's "inject what varies": the transport must be injectable so the pure logic is testable without a network and the package stays edge-portable (the SDK assumes Node globals the Workers runtime narrows).
3. **It is the missing half of the AI story we already advertise.** The MCP control plane (agents operate Lesto) and `@lesto/ai` (developers build AI into a Lesto app) are the two sides of one pitch. Shipping only the first is the credibility gap.

### Default model — current Claude, no guessing

The spike and every default in this ADR target the **current Claude family** (Fable 5 and the Claude 4.x line). The model IDs are:

| Model | ID |
|---|---|
| Opus 4.8 | `claude-opus-4-8` |
| Sonnet 4.6 | `claude-sonnet-4-6` |
| Haiku 4.5 | `claude-haiku-4-5-20251001` |
| Fable 5 | `claude-fable-5` |

`@lesto/ai`'s default model is **`claude-opus-4-8`**. The model is always an explicit field on the call — never a hidden global — so a caller picks Haiku for cheap classification and Opus for hard reasoning at the call-site.

### Non-negotiable constraints inherited from the house style

1. **Minimize dependencies.** Zero runtime dependencies beyond `@lesto/errors` (and `@lesto/db`/`@lesto/queue` *interfaces* where a seam genuinely needs them). No `@anthropic-ai/sdk`, no `ai`, no `zod` *inside* the model core — structured-output validation is the **caller's** boundary Zod (ADR 0005), passed in as a `parse` function, never a Zod dependency baked into `@lesto/ai`.
2. **Inject what varies (ADR 0006 / CONVENTIONS "Testability").** The HTTP transport is a parameter (`Transport = (req) => Promise<Response>`), defaulting to global `fetch`. The pure logic — message assembly, the agent/tool loop, SSE stream parsing — is driven in tests by a fake transport, exactly as `@lesto/bench` injects a `SampleSource` + `clock`. No real network in a unit test, ever.
3. **Validation at the boundary (ADR 0005).** The model layer never *semantically* validates a model's output against an app schema; it returns the assembled text/tool-calls, and the **caller** runs its boundary Zod. `generateObject`-style helpers take a caller-supplied `parse`; `@lesto/ai` owns transport + protocol, not the app's domain schema.
4. **Dialect / edge parity (ADR 0018).** The retrieval seam is a `VectorStore` *interface*. Its two real backends — **pgvector** on the Postgres leg and **Cloudflare Vectorize** on the Workers leg — are the same "SQLite-local → Postgres-prod, same API" split `@lesto/db` already enforces. The seam ships; a concrete pgvector store is a later increment behind the parity gate, not part of the spike.
5. **Errors carry codes.** Every refusal is an `AiError` with a stable `code` (`AI_HTTP_ERROR`, `AI_STREAM_MALFORMED`, `AI_TOOL_NOT_FOUND`, `AI_MAX_STEPS_EXCEEDED`, …). The MCP surface and logs branch on the code, never the message.
6. **PREVIEW, gate-excluded.** Like `@lesto/content-embeddings`, `@lesto/ai` enters below the 100%-coverage bar as an experimental seam. **It must not declare a `test:cov` script** — that, not the directory name, is what `scripts/coverage-gate.ts` keys on (line 35: a package is gated *iff* it declares `test:cov`). The `content-` prefix is a *second* exclusion path that does not apply to a package named `ai`, so the spike relies on the `test:cov` lever, documented in the package.json description as PREVIEW. The pure core is still expected to be fully tested; it is simply not wired into the central gate while the surface is volatile.

### The Cloudflare tier

On Workers, global `fetch` is the runtime's native HTTP — the injected-transport default works unchanged with zero Node assumptions, which is precisely why a vendored Node-shaped SDK is the wrong call. Streaming is a `ReadableStream` the Worker can pipe straight to the client response (`waitUntil` keeps the generation alive past the first byte). Memory is a Durable Object or the SQL `SessionStore`; the vector backend on the edge is **Vectorize** behind the same `VectorStore` interface. The Cloudflare Agents SDK is the *stateful-orchestration* layer above this — `@lesto/ai` deliberately stops at the model + tool-loop primitive so it composes under either Lesto's own queue/DO story or CF's, rather than competing with the substrate.

## Decision

Ship app-builder AI as a new **PREVIEW package `@lesto/ai`**, in **four increments**, in strict dependency order, mirroring ADR 0018's discipline: each increment is independently shippable, each honors the constraints above, and the headline (Increments 1–2) closes the credibility gap on its own.

### 1 · Provider-agnostic model layer — `generateText` / `streamText` over an injected transport

The keystone. A thin, pure core over the Anthropic Messages API via injected HTTP:

```ts
import { createAnthropic } from "@lesto/ai";

const model = createAnthropic({ apiKey: env.ANTHROPIC_API_KEY }); // transport defaults to fetch

const { text } = await generateText({
  model,
  system: "You are terse.",
  messages: [{ role: "user", content: "Name three planets." }],
  // model id defaults to claude-opus-4-8; pass `model: "claude-haiku-4-5-20251001"` to switch
});

for await (const delta of streamText({ model, messages })) {
  process.stdout.write(delta.text);
}
```

- **`Transport` is injected** (`type Transport = (request: Request) => Promise<Response>`), defaulting to global `fetch`. The Anthropic request builder (model id, `max_tokens`, system, messages, tools) is **pure** — message assembly is a unit-tested function returning a `Request`, never a function that *performs* one.
- **`generateText`** assembles the request, sends it through the transport, parses the JSON `content` blocks into `{ text, toolCalls, stopReason, usage }`. A non-2xx becomes `AiError("AI_HTTP_ERROR", …, { status })` — the status is in `details`, never parsed out of the message.
- **`streamText`** parses the SSE event stream (`event: content_block_delta` → `text_delta`) into an async iterator of `{ text }` deltas. The SSE parser is a **pure transform over a `ReadableStream<Uint8Array>`** — fed a canned stream in tests, asserting exact deltas and a malformed-frame `AI_STREAM_MALFORMED` refusal, with no network.
- **Provider-agnostic by interface, Anthropic-first by implementation.** The public surface is a `LanguageModel` interface; `createAnthropic` is the one concrete implementation. Adding OpenAI later is a second implementation, not a refactor — but we do not build it speculatively (ADR 0018's "no abstraction without a second consumer" discipline; the interface exists because edge-vs-node transport *is* the second axis of variation, not because a second provider is imminent).

*Acceptance:* `generateText`/`streamText` round-trip against a fake transport; message assembly, response parsing, and SSE parsing are unit-tested to completion; no real network in any test.

### 2 · The tool / agent loop — bounded, deciding-separate-from-calling

The multi-step loop that turns a model into an agent: the model emits a tool call, we run the tool, feed the result back, repeat until it stops or a step budget is hit.

```ts
const result = await runAgent({
  model,
  messages,
  tools: {
    getWeather: {
      description: "Current weather for a city.",
      inputSchema: { /* JSON Schema */ },
      execute: async ({ city }) => fetchWeather(city),
    },
  },
  maxSteps: 8,
});
```

- **The loop is pure orchestration over the injected transport.** Each step: assemble request (Increment 1) → transport → if `stop_reason === "tool_use"`, dispatch the named tool, append the `tool_result`, loop; else return. Deciding (which tool, when to stop) is separated from calling (the transport) so the whole loop is tested with a scripted fake transport returning canned tool-use turns — exactly ADR 0018 / CONVENTIONS "separate deciding from timing."
- **Bounded by `maxSteps`.** Exceeding it throws `AiError("AI_MAX_STEPS_EXCEEDED", …)` — an agent that loops forever is a bug that must surface loudly, never a hang (mirrors `BENCH_EMPTY_RUN`'s loud-refusal posture).
- **An unknown tool name is `AI_TOOL_NOT_FOUND`**, coded, not a silent skip.
- **Tool input is the boundary.** The tool's `inputSchema` is JSON Schema sent to the model; the `execute` function is the caller's, and validating the model-supplied args before `execute` is the caller's boundary concern (ADR 0005) — `@lesto/ai` passes the parsed args through and lets the tool's own guard reject.

*Acceptance:* the loop drives a scripted multi-turn tool exchange to completion via the fake transport; budget-exceeded and unknown-tool refusals are coded and tested.

### 3 · The retrieval seam — `VectorStore` interface, RAG through a Lesto-owned boundary

RAG is *retrieve-then-generate*. Lesto owns the *seam*, not a vector database:

```ts
interface VectorStore {
  upsert(records: VectorRecord[]): Promise<void>;
  query(embedding: number[], opts: { topK: number }): Promise<VectorMatch[]>;
}

const context = await retrieve({ store, embedding, topK: 5 });
const { text } = await generateText({ model, messages: withContext(context, messages) });
```

- **`VectorStore` is an interface (ADR 0006 / CONVENTIONS "depend on interfaces, not drivers").** Two real backends, same parity split as `@lesto/db`: **pgvector** on Postgres, **Cloudflare Vectorize** on the edge. Embeddings reuse the existing `@lesto/content-embeddings` PREVIEW work (the all-MiniLM build-time embedder), so RAG indexing is *already half-built* in the tree.
- **`retrieve()` is pure** given a store: embed-query is the caller's (or content-embeddings'), `retrieve` queries the store and assembles the context block. The spike demonstrates this end-to-end against a **stub in-memory store** behind the interface, proving the seam without a database.
- **A concrete pgvector store + the Vectorize store are deferred** behind the dialect/edge-parity gate, exactly as ADR 0018 defers concrete drivers behind the parity CI leg. The seam and the RAG flow ship in the spike; the production stores follow.

*Acceptance (spike):* one RAG retrieval flows through `VectorStore` → `retrieve` → `generateText` (fake transport), with a stub store, fully unit-tested.

### 4 · Evals / guardrails hook — a scored, pluggable check seam

The thing that separates a toy from a shippable AI feature: a way to *score* output and *guard* it.

- **An `Eval` is a pure function** `(input, output) => Promise<EvalResult>` returning `{ score, passed, code? }` — an LLM-judge eval is just an `Eval` that itself calls `generateText` (the judge model defaults to a current Claude, e.g. `claude-sonnet-4-6`), so the pattern composes with Increment 1 with zero new machinery.
- **A guardrail is an `Eval` run *before return*** that can refuse: a failed guard throws `AiError("AI_GUARDRAIL_BLOCKED", …, { evalCode })`, coded so the boundary can map it to an HTTP response.
- **No eval framework, no dataset runner, no dashboard** — that is a later, possibly out-of-package concern. This increment ships the *hook* (a typed seam + the LLM-judge composition), not a harness, on ADR 0018's "name the seam, defer the convenience layer" principle.

*Acceptance:* an `Eval` and an LLM-judge eval (using the fake transport for the judge) run and score; a guardrail refuses with a coded error.

## The spike (built with this ADR)

Because the decision is **IN**, this ADR lands with a minimal spike that proves Increments 1–3's pure core:

- `packages/ai/` as a **PREVIEW, gate-excluded** package — **no `test:cov` script**, PREVIEW noted in `package.json` `description`, mirroring `@lesto/content-embeddings`'s exclusion (the gate keys on the missing `test:cov`, line 35 of `scripts/coverage-gate.ts`).
- **Zero runtime dependencies** beyond `@lesto/errors` (workspace). The transport is injected; the default is global `fetch`. No Anthropic SDK, no `zod`, no `ai`.
- `generateText` + `streamText` over the Anthropic Messages API through an injected transport; a bounded `runAgent` tool loop; a `VectorStore` interface with an in-memory stub demonstrating one RAG retrieval; an `Eval`/guardrail hook.
- vitest tests for the pure core (message assembly, response parsing, SSE stream parsing, the agent/tool loop, the RAG flow, the guardrail refusal) driven entirely by a fake transport — no network.

## What this is explicitly NOT

- **Not a re-skin of the Vercel AI SDK or a vendored `@anthropic-ai/sdk`.** Zero AI-vendor dependencies; the transport is `fetch`, injected. We own the protocol the same way `@lesto/auth` owns TOTP via `node:crypto`.
- **Not the MCP control plane.** That is "agents operate Lesto." This is "developers build AI into a Lesto app." Two sides of one pitch; separate packages.
- **Not a multi-provider matrix.** Anthropic-first, behind a `LanguageModel` interface so a second provider is additive — but OpenAI/Gemini/etc. are not built speculatively (ADR 0018's no-second-consumer discipline).
- **Not a vector database.** `@lesto/ai` ships the `VectorStore` *interface* and the RAG flow; pgvector and Vectorize stores are deferred behind the dialect/edge-parity gate.
- **Not an evals harness / dataset runner / observability dashboard.** Increment 4 ships the *hook* (a typed `Eval` seam + LLM-judge composition + guardrail refusal), not a framework.
- **Not a UI-streaming layer.** Server-Sent-Events streaming to the browser, React `useChat`-style hooks, and Loom integration are a follow-on once the model core is proven — the spike proves the server-side primitive (`streamText` over a `ReadableStream`) that such a layer would sit on.
- **Not validation-owning.** `@lesto/ai` never validates app-domain output; structured output is the caller's boundary Zod (ADR 0005), passed in.

## Sequencing

Strict dependency order; each independently shippable and non-breaking (PREVIEW, off the central gate):

1. **Model layer** — `generateText`/`streamText` over the injected `Transport`, default `fetch`, default model `claude-opus-4-8`. Message assembly + response parsing + SSE parsing, pure and unit-tested. **(Spike builds this.)**
2. **Tool / agent loop** — bounded `runAgent`, deciding-separate-from-transport, coded budget/unknown-tool refusals. **(Spike builds this.)**
3. **Retrieval seam** — `VectorStore` interface + pure `retrieve`; one RAG flow on a stub store in the spike; pgvector + Vectorize stores deferred behind the parity gate, reusing `@lesto/content-embeddings`.
4. **Evals / guardrails hook** — `Eval` seam + LLM-judge composition + guardrail coded refusal.

The chain is **1 → 2 → 4** (the loop and the LLM-judge eval both stand on the model layer); **3 forks off 1** (RAG needs `generateText` but not the loop). Production vector stores and the browser UI-streaming layer are named follow-ons, deliberately not pulled into this ADR against a toy example.

## Consequences

- A Lesto developer can build a model-backed feature — text, streaming, an agent with tools, RAG over the existing embeddings work, a guardrailed/evaluated endpoint — without leaving the framework or adding an AI-vendor SDK.
- The "AI-native" claim becomes true in *both* senses: agents operate Lesto (MCP) **and** Lesto builds AI features (`@lesto/ai`).
- The cost is bounded and on-thesis: a `fetch`-thin transport seam over a substrate (queue, durable stores, db, edge) Lesto already ships. No new vendor lock-in, edge-portable by construction.
- The dialect/edge-parity discipline extends to the vector backend exactly as it does to SQL — pgvector local-to-prod, Vectorize on the edge, one interface — so "AI feature works the same on SQLite/Node and Postgres/Workers" stays literally true.
- PREVIEW keeps the central gate honest: `@lesto/ai` ships experimental, off the 100%-coverage gate (no `test:cov`), with its pure core fully tested anyway — the same posture `@lesto/content-embeddings` holds.

## Open questions (resolve during the Increment 1 spike / follow-ons)

- **Structured output (`generateObject`):** caller-supplied `parse` returning the validated object vs. a thin `tool`-forced-JSON helper. Lean: a `parse: (raw) => T` parameter so the boundary Zod stays the caller's (ADR 0005), settled against the first real consumer.
- **Streaming-to-browser:** the SSE-to-client + `useChat`-style hook layer — own it in `@lesto/ai`, or in Loom/`@lesto/web`? Decide when the first example streams to a page.
- **Memory shape:** reuse `SessionStore` (ADR 0013) verbatim for conversation history, or a purpose-built `ConversationStore` with summarization/windowing? Decide against a real multi-turn consumer, not a toy.
- **Prompt-injection guardrails:** the Increment-4 hook is the mechanism; the *default* guard policy (if any) is deployment-specific, like ADR 0016's CSRF call — ship the seam, don't force a policy.

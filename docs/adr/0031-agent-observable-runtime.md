# ADR 0031 — Agent-observable runtime (LLM / tool / MCP calls as spans on the one request trace)

- **Status:** Proposed — pending owner ratification. The committed **build-now** is a single
  shippable seam: **Phase 1** adds an INJECTED tracer seam to `@lesto/mcp`'s `dispatch` so
  every governed agent action becomes a `mcp.tool` span in the same collector (the
  shippable/covered piece), plus a small shared AI/agent **span vocabulary** in
  `@lesto/observability`. Honest scope: because `dispatch` runs from the **stdio** MCP server
  **outside** any Lesto HTTP request (`mcp/src/server.ts:72-83`), that `mcp.tool` span is a
  **standalone (unparented) span** — it is NOT a child of an `http.request`, and Phase 1 does
  **not** join it to one. **Phase 2** (the `ai.generate` + per-tool spans inside `@lesto/ai`'s
  `runAgent`/`generateText`) is designed here and lands on the **PREVIEW** `@lesto/ai` package
  — it stays preview (below the 100%-coverage gate), is gated on the Phase 1 vocabulary, and
  parents on the in-flight request span **once a route is wired to call `@lesto/ai`** (the
  in-request child-span path, unlike the stdio MCP path). **Phase 3** (a single `examples/estate`
  dogfood wiring the AI-path spans onto one trace as the QA gate) is gated on Phase 2; it also
  **builds the first real route consumer** of `@lesto/ai`, since none exists in the repo today.
  The MCP↔request-trace **join** — once asserted as committed "Phase 1b" — is **CUT from
  committed scope and moved to Deferred**: the independent 2026-06-22 review proved it
  unbuildable as framed (`app.handle`/`lesto().handle` never mint `http.request` and never parse
  `traceparent`; that lives only in the transport layer and `handle_request` bypasses it). It
  needs a NEW span-minting seam inside `handle_request`/the kernel (a real multi-package change),
  not a header thread. Realtime/metrics/eval-grading surfaces are **deferred**, each on a real
  consumer. **0031 only EMITS spans** to OTLP — it builds NO queryable per-`requestId` span
  store, so the wave's `explain_request` (0032) / activity panel (0033) surfaces have **no
  producer here**. Revised 2026-06-22 by an independent red-team + chief-architect pass (after
  two internal adversarial passes); see *Reviews*.
- **Date:** 2026-06-22
- **Deciders:** tech lead + owner (ratification pending)
- **Builds on / touches:** ADR 0021 (app-builder AI primitives — the `runAgent` loop,
  `generateText`, the `ToolCall`/`StopReason`/`Usage` vocabulary — `ai/src/types.ts:48-65`;
  **PREVIEW**); the `@lesto/observability` tracing core (the `CurrentSpan` seam,
  `Tracer.startSpan` parent/child, W3C `traceparent` / the inbound-trace seam, and the
  browser→server RUM join — `traces.ts:89-101`, `tracer.ts:114`, `tracer.ts:26-44`,
  `index.ts:89-95`/`rum.ts`); the **shipped** `@lesto/mcp` audit dispatch — the `McpAuditSink` /
  `McpAuditRecord` that already record every governed dispatch — `McpAuditRecord` =
  `mcp/src/tools.ts:77-93`, `McpAuditSink` = `tools.ts:96`. (That audit record is the
  **pre-0028**, binary-`requireOperator` mechanism — `tools.ts:254` — *not* ADR 0028's
  principal-aware audit: ADR 0028's governance Phase (principal model,
  `requirePermission`/`MCP_FORBIDDEN`, actor-in-audit) is **Accepted but unbuilt**, and this ADR
  does **not** lean on that unshipped surface.) This ADR contributes a **shared `ai.*`/`mcp.*`
  span vocabulary** — the small value-level artifact ADRs 0032/0033/0034/0035 can group agent
  activity on. It is **not a keystone the wave is gated on**: it is *"the shared span vocabulary
  the later trace-attachment phases agree on,"* and **0034-P1 and 0035-P1 do NOT depend on this
  ADR** at all (only the later trace-attachment phases of 0032/0033 reference the span names).

## Context

Lesto already ships the single hard part of observability that no JS meta-framework ships:
**one trace that spans browser → API → DB**. The browser RUM half adopts the SSR-injected
server trace id and POSTs its spans back under it (`packages/observability/src/index.ts:89-95`,
`rum.ts`); the **transport layer** mints one `http.request` root span per request — wrapping the
network request in `runWithContext`, parsing the inbound `traceparent`, and calling
`tracer.startSpan("http.request", inbound)` (`runtime/src/server.ts:1344-1361`,
`cloudflare/src/fetch-handler.ts:742-746`) — and publishes that span on the request context
(`packages/web/src/context.ts:142`, `currentRequestSpan`); and every
battery's `on*` seam terminates in `createTraces`, which opens a **child span parented on the
in-flight request span** and ends it (`traces.ts:267-368`). That is why a `db.query` shows up
*under* the `http.request` that caused it: `onQuery` calls `record("db.query", …)`, which reads
the parent through the injected `CurrentSpan` seam (`traces.ts:101,270,290-291`). The exporter
is one OTLP/HTTP exporter; the on-switch is one env var (`LESTO_OTLP_URL`); tracing absent
costs zero (`traces.ts:416-419`).

What is **missing** is the AI/agent tier. Two real call paths produce no spans today:

- **`@lesto/ai`'s agent loop is invisible — and has no route consumer yet.** `runAgent` drives a
  bounded tool-use loop — each iteration calls `generateText`, sums `Usage`, dispatches any
  `ToolCall` by name, loops until the model stops or `maxSteps` is hit
  (`packages/ai/src/agent.ts:60-114`). It records a rich in-memory `AgentResult` (`steps`,
  `usage` — `agent.ts:39-46`) and `generateText` already returns `stopReason` + `usage` per call
  (`generate.ts:21-26`, `types.ts:62-75`), but **none of it becomes a span.** **Crucially, no
  route anywhere in the repo calls `runAgent`/`generateText`** — grep across `packages/`,
  `examples/`, and `site/` finds only docs prose; `examples/estate` does not even depend on
  `@lesto/ai`. So "a request that calls an LLM" is **not a present fact** — it becomes real only
  once a route is wired (which Phase 3 builds). `@lesto/ai` has **no** `@lesto/observability`
  dependency (`packages/ai/package.json:32-34` — only `@lesto/errors`), and it is **PREVIEW**:
  coverage-gate-exempt because it **declares no `test:cov`** (`package.json:14-20`, confirmed by
  `scripts/coverage-gate.ts:35` — the exemption is the *absence of a `test:cov` script*, not a
  "preview" label).

- **`@lesto/mcp`'s governed dispatch is audited but not traced.** Every agent action through
  `dispatch` already lands one `McpAuditRecord` carrying `tool` / `inputHash` / `outcome` /
  `durationMs` (`packages/mcp/src/tools.ts:77-93,608-650`) — there is no un-audited path. But
  the audit sink is a *log line*, not a *span*. And the dispatch runs from the **stdio** MCP
  server's `CallToolRequestSchema` handler (`mcp/src/server.ts:72-83`), its own process
  **outside** any Lesto HTTP request — so even once we open a span there, `currentRequestSpan()`
  (`web/src/context.ts:142`) is `undefined` at dispatch time and the span roots a fresh,
  standalone trace. Worse, an agent that drives the live app through `handle_request`
  (`tools.ts:354-394`) calls `context.app.handle(...)` (`tools.ts:393`) — but `app.handle`
  (`lesto().handle`, `web/src/lesto.ts:507`; the kernel `App.handle`, `kernel.ts:218`) is the
  **pure dispatch**: it neither mints an `http.request` span nor parses `traceparent`. Span-mint
  + `traceparent`-parse live **only in the transport layer** (`runtime/src/server.ts:1344-1361`,
  `cloudflare/src/fetch-handler.ts:742-746`), which `handle_request` bypasses entirely. So an
  MCP-driven `app.handle` produces **no `http.request` span at all**, and `currentRequestSpan()`
  is `undefined` throughout. There is **no trace-id continuity** between an MCP tool call and the
  request it triggers, and **no header thread can create one** — joining them requires a NEW
  span-minting seam inside `handle_request`/the kernel (a real multi-package change). Phase 1
  gives the dispatch a standalone span; the join is **Deferred** (see below).

So the materials are all here — a child-span mechanism keyed on a `CurrentSpan` seam, a loop
that already knows model id / tokens / stop reason / tool name, and an audit dispatch that
already times every governed action — but the AI/agent activity is not bound onto the trace.

This is **not** an attempt to be an LLM-observability *product* (no eval-grading dashboards, no
token-cost metrics pipeline, no prompt-replay UI). `@lesto/observability` is **traces only**,
said out loud (`observability/src/index.ts:37-46`); this ADR keeps that line. It adds spans to
the one trace, nothing more.

## The core idea: agent activity is just another child span

Every existing battery turns a finished event into a child span by funnelling through one
helper — open a span parented on `currentSpan()`, stamp attributes, set status, end it
(`traces.ts:273-287`). The sound core of this ADR is that **an LLM call, a model tool call, and
an MCP dispatch are the same shape of event** — they each have a name, a few attributes, an
outcome, and a duration — so they each become a child span by the *identical mechanism*. No new
pipeline, no new exporter, no parallel telemetry path. The only genuinely new artifact is a
**shared vocabulary** so a collector can group them.

| Concern | Resolution via the existing child-span mechanism |
|---|---|
| **One LLM call** | `ai.generate` span: attributes `ai.model`, `ai.usage.input_tokens`, `ai.usage.output_tokens`, `ai.stop_reason`; status `error` on a coded `AiError`. |
| **One model tool call** | `ai.tool` child span (of the `ai.generate` that requested it): attribute `ai.tool.name`; status from whether the tool threw. |
| **One MCP governed action** | `mcp.tool` span built from the data the `McpAuditRecord` already carries: `mcp.tool`, `mcp.input_hash`, `mcp.outcome`, `mcp.duration_ms`. |

The vocabulary (the `ai.*` / `mcp.*` span names + attribute keys) is the *minimal* sound
addition: it is the one thing a parallel-built `@lesto/ai` span and `@lesto/mcp` span must
agree on for a collector to group "agent activity" across both packages — *the shared span
vocabulary the later trace-attachment phases agree on*, not a keystone the wave is gated on
(0034-P1 and 0035-P1 use none of it). Everything else reuses `Tracer.startSpan({ parent })`
(`tracer.ts:114`) verbatim.

**Scope boundary — what this ADR does NOT build.** 0031 only **emits** spans onto the existing
OTLP exporter. It builds **no queryable, per-`requestId` span store** and **no dev span feed**.
So the wave surfaces that need to *read back* spans by request — ADR 0032's `explain_request`
and ADR 0033's activity panel — have **no producer in this ADR**; they need a span store that no
committed phase of any wave ADR builds (called out in *Deferred*).

## Decision

Make AI/agent activity first-class spans on Lesto's existing browser→API→DB trace, in the same
collector and tooling as user requests. For the **in-request AI path** this becomes a true child
join **once a route is wired to call `@lesto/ai`** (Phase 2 emits the spans; Phase 3 builds the
route): such a request produces ONE trace, `http.request → ai.generate → ai.tool → db.query`,
because `runAgent`/`generateText` then run *inside* an HTTP handler where `currentRequestSpan()`
is set. For the **MCP** path: Phase 1 emits a **standalone `mcp.tool` span** (the stdio dispatch
has no in-flight `http.request` to parent on, and `handle_request → app.handle` mints **no**
`http.request` span at all). The MCP↔request-trace **join is not in committed scope** — it is
**Deferred**, because it is not a header thread but a NEW span-minting seam inside
`handle_request`/the kernel (a real multi-package change). Build in phases; commit Phase 1 now.

### Phase 1 — build now: the MCP dispatch tracer seam + the shared vocabulary

Two integration points, each on the right side of the layering, each 100%-testable as pure
functions / a handler over an injected seam:

1. **A shared AI/agent span vocabulary (observability layer).** Add a small, exported,
   value-level module to `@lesto/observability` naming the `ai.generate` / `ai.tool` /
   `mcp.tool` span names and their attribute keys as `const` strings, with a pure
   `mcpAuditToSpanAttributes(record)` helper that maps an `McpAuditRecord`-shaped value onto the
   `mcp.*` attribute bag. This is additive, dependency-free, and is what lets the (preview)
   `@lesto/ai` spans and the (covered) `@lesto/mcp` spans use the *same* names without either
   package importing the other. **No `@lesto/observability → @lesto/mcp` edge:** the helper
   takes a **structural** record shape (`{ tool; inputHash; outcome; durationMs }`), not an
   imported `McpAuditRecord` type (`tools.ts:77-93`) — the same structural-marker discipline ADR
   0028 uses so neither side imports the other (grep-asserted).

2. **An injected tracer seam on `@lesto/mcp`'s `dispatch` (mcp layer).** `dispatch` already
   builds the audit record and awaits the sink for **both** success and failure before the
   result/error surfaces (`tools.ts:626-649`). Add an **optional injected** `onSpan?` seam to
   `DispatchOptions` (alongside the existing `now` seam — `tools.ts:588-596`) of type
   `(record: McpAuditRecord) => void`. After the audit is written, `dispatch` calls `onSpan`
   with the same record, on the same success and error paths, so every governed action becomes
   one span. **No new runtime dependency:** `@lesto/mcp` does **not** gain a `@lesto/observability`
   import — the *app* (which already constructs `Traces`) wires `onSpan` to a **bespoke thunk**
   that opens a `mcp.tool` span by calling `traces.tracer.startSpan(...)` directly with the
   observability vocabulary. Note: unlike `db.onQuery`, this is **not** a `traces.seams.*`
   member — `TraceSeams` (`traces.ts:174-231`) is a fixed, closed set with no `mcp.tool`/`ai.*`
   entry, and this phase deliberately keeps it closed (no new `TraceSeams` member), so the app
   constructs the span thunk over `tracer.startSpan` rather than going through `traces.seams`.
   The seam is injected; the span vocabulary is the only shared contract.
   - **Fail-safe, not fail-closed:** `onSpan` is *observability*, not *governance* — it is
     optional and absent by default (tracing off → no span, zero cost, mirroring
     `LESTO_OTLP_URL` absent). An `onSpan` that throws must **never** break a dispatch (an
     observability fault is not an agent-action fault); `dispatch` calls it defensively and a
     throw is swallowed to a coded-noop, the same way the tracer's seam hooks never throw into
     the battery that raised them. The audit sink remains the mandatory, awaited governance
     record (`tools.ts:96,626-646`); `onSpan` is the additive observability shadow of it.

Scope discipline: Phase 1 is additive, introduces **no** new package edge in either direction,
adds **no** new runtime, and is fully testable — the vocabulary helper as a pure function, the
`dispatch` seam by passing a fake `onSpan` and asserting it fires once per dispatch (ok and
error) with the audit record. `@lesto/mcp` stays at the **100% coverage** bar.

> **What Phase 1 does and does not deliver.** Phase 1 makes the `mcp.tool` event a span in the
> same OTLP collector — but, run from the stdio server (`server.ts:72-83`) outside any HTTP
> request, that span is **standalone (unparented)**: it is NOT a child of `http.request`. The
> `app.handle` that `handle_request` triggers (`tools.ts:393`) mints **no `http.request` span at
> all** (span-mint lives only in the transport layer, which `handle_request` bypasses). Phase 1
> is the seam + the standalone span. The MCP↔request-trace **join is Deferred** — it is a new
> span-minting seam, not a header thread (see *Deferred*). Do not assert MCP activity lands "on
> the request trace" from this ADR's committed scope.

### ~~Phase 1b~~ — CUT from committed scope (the MCP↔request-trace join). See *Deferred*.

> An earlier revision committed a "Phase 1b" that would *"thread a `traceparent` from the MCP
> dispatch through `handle_request` into `app.handle`"* so the `mcp.tool` span and the
> `http.request` it triggers share a trace id. **The independent 2026-06-22 review proved this
> unbuildable as framed** (blocker, confidence high): `app.handle` / `lesto().handle`
> (`web/src/lesto.ts:507`) and the kernel `App.handle` (`kernel.ts:218`) are the **pure
> dispatch** — they neither mint an `http.request` span nor parse `traceparent`. Span-mint +
> `traceparent`-parse live **only** in the transport layer (`runtime/src/server.ts:1344-1361`,
> `cloudflare/src/fetch-handler.ts:742-746`), and `handle_request` calls `context.app.handle(...)`
> (`tools.ts:393`) **directly**, bypassing the transport. So forwarding a `traceparent` header
> into `app.handle` is **inert**: nothing on that path reads it, no `http.request` span is
> created, and the old acceptance (*"app.handle's root span adopts the dispatch trace id"*) can
> never pass — there is no root span to adopt it. The header-allowlist variant was also a
> trace-poisoning surface (an agent could spoof a trace id; `ALLOWED_REQUEST_HEADERS` at
> `tools.ts:275-283` deliberately excludes trust-sensitive propagation headers). **The MCP join
> is therefore moved to *Deferred*** — it requires a NEW span-minting seam inside
> `handle_request`/the kernel (wrap the inner dispatch in `runWithContext` + `tracer.startSpan`
> with the `mcp.tool` span as the adopted `inbound` trace), a real multi-package change
> (web/kernel/runtime), not a one-line header thread.

### Phase 2 — designed here, gated on the Phase 1 vocabulary: `ai.generate` + `ai.tool` spans (PREVIEW)

This lands on `@lesto/ai`, which is **PREVIEW** — so these spans are preview too (coverage-gate
exempt because `@lesto/ai` declares no `test:cov`, `ai/package.json:14-20`; the pure core is
still fully tested). It cannot land before Phase 1 because it must emit the *same* `ai.*` names
the vocabulary defines. **Note: there is no route consumer of `@lesto/ai` in the repo today, so
Phase 2 emits spans that only land *on a request trace* once Phase 3 wires a route** — the
mechanism is sound, but "joins correctly" is true only once wired, not today.

1. **An injected `tracer` seam on `runAgent` / `generateText`.** `@lesto/ai` is dependency-free
   by design (`package.json:32-34`, ADR 0021). It must stay that way: add an **optional injected**
   span seam to `RunAgentOptions` (`agent.ts:19-30`) and `GenerateOptions` (`types.ts:94-107`) —
   a minimal `{ startSpan(name, attrs) → { setStatus; end } }` shape the *app* **adapts** the
   observability `Tracer` to (the `Tracer.startSpan(name, options)` second arg is a
   `StartSpanOptions` `{parent?, inbound?, attributes?}` — `tracer.ts:114,32-47` — NOT a flat
   attr bag, so the adapter must place the bag under `attributes` and the parent under `parent`;
   passing it raw would silently drop every attribute). The package never imports
   `@lesto/observability`; the app injects the binding, identical to how the model's `transport`
   is injected (`types.ts:84-92`).

2. **`generateText` opens one `ai.generate` span per model call** — attributes from the data it
   already returns (`ai.model` from `modelId ?? model.defaultModelId`, `ai.usage.*` from the
   `Usage` it parses, `ai.stop_reason` from `StopReason`); status `error` (and the `AiError`
   code in the span) when the provider call throws the coded `AI_HTTP_ERROR` it raises
   (`generate.ts:19-26`, `errors.ts:13-25`). (`AI_STREAM_MALFORMED` cannot arise here — it is
   thrown only by `streamText`/`parseStream` (`generate.ts:36-43`), which Phase 2 does not
   instrument; it belongs to the deferred streaming span.) Because the seam parents on the
   in-flight request span — and `runAgent`/`generateText` run inside an HTTP route handler **once
   a route is wired to call them** (where `currentRequestSpan()` is set) — an `ai.generate`
   becomes a child of `http.request`. This is the path that **will** join correctly once wired
   (Phase 3 builds the first such route; none exists today), unlike the stdio MCP path which
   cannot join even when wired.

3. **`runAgent` makes each tool call an `ai.tool` child of the `ai.generate` that requested it**
   — `runAgent` already iterates `result.toolCalls` and runs each (`agent.ts:100,122-140`); each
   becomes an `ai.tool` span named by `ToolCall.name`, status from whether the executor threw (a
   hallucinated tool surfaces as the existing coded `AI_TOOL_NOT_FOUND` on the span —
   `agent.ts:130-134`). The result: `http.request → ai.generate → ai.tool` on one trace.

This phase claims, precisely: *"agent and LLM calls appear on the same trace as your request."*
It does **not** claim a metrics product, a cost dashboard, or eval grading (see Non-goals).

### Phase 3 — gated on Phase 2: the estate dogfood (the QA gate) — **builds the first AI route consumer**

This is **not a thin thunk-through-existing-seams dogfood**: `examples/estate` today depends on
**neither** `@lesto/ai` **nor** `@lesto/mcp` (verified — `examples/estate/package.json`) and
wires no AI route. So Phase 3 is the increment that **first makes the in-request AI join real**:
it adds the `@lesto/ai` dep, builds a `runAgent`/`generateText` **route**, and wires the injected
`tracer` adapter onto it. estate already constructs `Traces` from the env and threads `seams`
through `buildApp` (`examples/estate/src/app.ts:54-90`, `production.ts:74-92`); the AI spans
parent on `currentRequestSpan` (`web/src/context.ts:142` — the in-request path, the *same*
`currentSpan` `db.onQuery` reads), emitted via a bespoke thunk over `traces.tracer.startSpan`
(not `traces.seams`, which has no `ai.*`/`mcp.*` member). The feature is not done until estate
shows `http.request → ai.generate → ai.tool → db.query` for an in-request LLM call, both locally
and on a real deploy (per gallery-as-QA-gate). The **MCP** half is **out of scope for committed
Phase 3** (it depends on the Deferred MCP-join seam); optionally estate may add the standalone
`mcp.tool` span (Phase 1's `onSpan` thunk) to demonstrate the span exists, but **without
asserting any `mcp.tool → http.request` join**.

## Non-goals

- **Not an LLM-observability product.** No eval-grading dashboard, no prompt-replay UI, no
  cost-attribution rollups — `@lesto/observability` is **traces only** by deliberate scope
  (`observability/src/index.ts:37-46`); we add spans, not a metrics/logs pipeline.
- **No token-cost *metrics*.** Token counts ride as span **attributes** (`ai.usage.*`), the
  honest per-span record — not a counter/histogram pipeline, which v1 explicitly does not have.
- **No new exporter or telemetry path.** AI/agent spans go through the *existing* tracer and the
  one OTLP exporter, attached to the *existing* `http.request` span via the *existing*
  `currentSpan` seam — not a parallel pipeline (a layering invariant, §observability).
- **No `@lesto/ai → @lesto/observability` runtime dependency, and no `@lesto/mcp →
  @lesto/observability` runtime dependency.** Both stay dependency-light; the tracer is an
  **injected seam**, the app wires it.
- **No coverage promotion for `@lesto/ai`.** Phase 2 spans live on the PREVIEW package and stay
  PREVIEW; the gate is not changed to cover it.
- **No silent fail.** `onSpan`/`tracer` absent is the loud, greppable, zero-cost off state
  (mirrors `LESTO_OTLP_URL` absent); a throwing observability seam is swallowed *and* coded so it
  never corrupts the agent action it observes — but it is never silently *dropped data* when wired.

## Deferred — recorded, not scheduled; each gated on a real consumer

- **The MCP↔request-trace join (`mcp.tool → http.request`)** — *was* a committed "Phase 1b";
  **cut** by the 2026-06-22 review as unbuildable-as-framed (see Phase 1b note + *Reviews*).
  `app.handle` is the pure dispatch and mints no `http.request` span (`web/src/lesto.ts:507`,
  `kernel.ts:218`); the span-mint lives only in the transport layer
  (`runtime/src/server.ts:1344-1361`, `cloudflare/src/fetch-handler.ts:742-746`), which
  `handle_request` (`tools.ts:393`) bypasses. The real fix is a **NEW span-minting seam** inside
  `handle_request`/the kernel: wrap the inner dispatch in `runWithContext` and call
  `tracer.startSpan("http.request", inbound)` with the `mcp.tool` span's `{traceId, spanId}` as
  the adopted `inbound` trace — a multi-package change (web/kernel/runtime + the app wiring), not
  a header thread. **The trust-sensitive `traceparent` must be injected by the trusted app seam,
  never carried through the agent-supplied `headers` input** (`ALLOWED_REQUEST_HEADERS` at
  `tools.ts:275-283` excludes trust headers by design). Gate: a real demand for MCP-driven
  requests to share a trace id, plus the new seam designed.
- **A queryable per-`requestId` span store / dev span feed** — 0031 only *emits* spans to OTLP; it
  builds no store you can read spans back from by request. The wave surfaces that need this — ADR
  0032's `explain_request` and ADR 0033's activity panel — have **no producer in this ADR** and no
  committed phase of any wave ADR builds one. Gate: whichever ADR commits a bounded dev-only span
  ring (the natural home is 0032's access-log ring), at which point those surfaces get a producer.
- **`ai.embed` / retrieval spans** — `@lesto/ai`'s `VectorStore`/`retrieve` seam
  (`ai/src/index.ts:32-41`) could emit spans, but there is no consumer wiring retrieval into a
  request path yet (RAG is preview-of-preview). Gate: a real estate retrieval route.
- **Streaming-span lifecycle.** `streamText` yields deltas over time (`generate.ts:38-43`); a
  span that stays open across an SSE stream (first-byte vs. last-byte) is a richer model than the
  point-in-time `ai.generate` Phase 2 ships. This is also where `AI_STREAM_MALFORMED` becomes a
  real span status — it is thrown only on the streaming path (`generate.ts:36-43`,
  `errors.ts:16-17`), so it belongs to this deferred streaming span, not to Phase 2's
  point-in-time `ai.generate`. Gate: a real streaming agent surface that needs the open-window
  timing (ADR 0033's in-preview chat is the likely first consumer).
- **Eval/guardrail spans.** `@lesto/ai`'s `guard`/`createLlmJudge` (`ai/src/index.ts:43-45`)
  could emit `ai.eval` spans, but eval grading belongs to ADR 0035's evals-in-CI, not the
  request trace. Gate: ADR 0035's eval harness deciding it wants per-eval spans.
- **Correction recorded so it is not re-derived:** the audit sink (`McpAuditSink`, `tools.ts:96`)
  and the span seam (`onSpan`) are **two records of the same dispatch**, not one. The audit is
  mandatory, awaited, and the governance record (the shipped pre-0028 `requireOperator`
  mechanism — `tools.ts:254`; ADR 0028's principal-aware audit is Accepted-but-unbuilt); the span
  is optional, fail-safe, and the observability record. Do not collapse them — making the audit
  emit spans would couple `@lesto/mcp` to the tracer and make a tracing fault a governance fault.

## Reviews

- **Internal adversarial pass — 3 lenses (correctness/security · simplicity/scope ·
  sequencing/coupling).**
  - *Correctness/security:* **changed Phase 1 from fail-closed to fail-safe** — an early draft
    treated `onSpan` like the mandatory audit sink; corrected, because observability is not
    governance, so a throwing/absent tracer must never break a governed agent action (the audit
    sink stays the mandatory, awaited record). **Surfaced** that token counts are span
    *attributes*, not a metrics pipeline — withdrawn any implication of cost dashboards.
  - *Simplicity/scope:* **cut** an initial design that added a `@lesto/observability` dependency
    to both `@lesto/ai` and `@lesto/mcp`; replaced with **injected seams + a shared value-level
    vocabulary**, so neither package gains a runtime edge (the same injected-seam discipline
    `db.onQuery` already uses). **Cut** streaming-span lifecycle, embed spans, and eval spans to
    Deferred, each gated on a real consumer. **Corrected** the vocabulary helper to take a
    *structural* record, not an imported `McpAuditRecord` type, to avoid a
    `observability → mcp` type edge.
  - *Sequencing/coupling:* **flagged** that Phase 2's `ai.*` spans must not predate the Phase 1
    vocabulary or they would name spans independently and the collector could not group them —
    so the vocabulary lands first. **Confirmed** AI/agent spans route through the *existing*
    `currentSpan` → child-span path, not a new pipeline, preserving the one-trace invariant.
  - What survived as already-minimal: the keystone (agent activity *is* just another child span
    via the existing mechanism) and the Phase 1 MCP-dispatch seam.
- **Internal adversarial pass #2 — correctness (2026-06-22).** A second, code-grounded pass
  caught that the committed-Phase-1 trace-join claim was **false** for the only path Phase 1
  ships: `dispatch` runs from the **stdio** MCP server (`server.ts:43-54`) **outside** any HTTP
  request, so `currentRequestSpan()` is `undefined` and the `mcp.tool` span roots a standalone
  trace — and `handle_request` → `app.handle` (`tools.ts:327`) mints a *fresh* `http.request`
  root on a different trace id because no `traceparent` propagates. **Fix:** demoted the Phase 1
  claim to "a standalone `mcp.tool` span in the same collector," removed `→ mcp.tool →
  http.request` from the Decision/Consequences as a Phase-1 deliverable, and **split out a
  committed Phase 1b** that threads a `traceparent` from the dispatch through `handle_request`
  into `app.handle` via the existing inbound-trace seam (`tracer.ts:26-44`) — the increment that
  actually earns "MCP activity is on the request trace." Also: **softened the keystone** framing
  (the *vocabulary* is what the wave agrees on; the agent-tier trace *join* lands with Phase 1b +
  Phase 2). **Corrected** that the AI path *does* parent correctly today (it runs inside HTTP
  handlers). **Spelled the `Tracer` → `AgentTracer` adapter** (the `Tracer.startSpan` 2nd arg is
  `StartSpanOptions`, not a flat attr bag — `tracer.ts:114,32-47` — so a raw pass would silently
  drop attributes; the app adapts, with a test guarding the attribute landing). **Dropped
  `AI_STREAM_MALFORMED`** from Phase 2's `ai.generate` status (it is streaming-only,
  `generate.ts:36-43`; `AI_HTTP_ERROR` is the sole code on the non-streamed path) and moved it to
  the deferred streaming-span entry. **Clarified** the mcp/ai spans are a bespoke thunk over
  `traces.tracer.startSpan` — NOT a `traces.seams.*` member (`TraceSeams` is closed,
  `traces.ts:174-231`). **Tightened** the `McpAuditRecord` (`tools.ts:35-51`) / `McpAuditSink`
  (`tools.ts:53-54`) and AI-vocabulary (`types.ts:48-65`) line citations. The keystone (agent
  activity = a child span via the existing mechanism) and the phasing survived.
  - *Note (superseded below):* this pass's "split out a committed Phase 1b" verdict was itself
    **overturned** by the independent 2026-06-22 review — Phase 1b is not buildable as a header
    thread; see the next entry. (The MCP-citation tighten it claimed was also still off by
    ~40-80 lines and is re-anchored below.)
- **Independent red-team + chief-architect pass (2026-06-22).** A 9-report red-team plus a
  chief-architect verdict reviewed this ADR against the current tree. Verdict: **revise**; the
  sound core (agent activity = a child span via the existing `tracer.startSpan`, no new
  pipeline/exporter; the injected-seam layering; the fail-safe `onSpan`; the `Tracer`→`AgentTracer`
  attribute-drop adapter; the PREVIEW-via-no-`test:cov` reasoning; dropping `AI_STREAM_MALFORMED`)
  was confirmed correct and kept. Concrete changes made in this revision:
  - **BLOCKER — cut Phase 1b.** The review proved (high confidence) that *"app.handle adopts a
    forwarded `traceparent`"* is **impossible**: `app.handle` / `lesto().handle`
    (`web/src/lesto.ts:507`) and the kernel `App.handle` (`kernel.ts:218`) are the pure dispatch —
    they never mint `http.request` and never parse `traceparent`; that lives **only** in the
    transport layer (`runtime/src/server.ts:1344-1361`, `cloudflare/src/fetch-handler.ts:742-746`),
    which `handle_request` (`tools.ts:393`) bypasses. Forwarding a header is inert and the old
    acceptance can never pass. **Removed Phase 1b from committed scope; moved the MCP↔request-trace
    join to *Deferred*** as a NEW span-minting seam inside `handle_request`/the kernel (a real
    web/kernel/runtime change), not a header thread. Committed scope is now **Phase 1 only** (plus
    designed Phase 2 / dogfood Phase 3 on the AI path).
  - **Demoted the "keystone" framing** to *"the shared span vocabulary the later trace-attachment
    phases agree on,"* and stated plainly that **0034-P1 and 0035-P1 do not depend on this ADR**.
  - **Honesty: removed "joins correctly today."** There is **no route consumer** of `@lesto/ai`
    `runAgent`/`generateText` anywhere (grep-verified; `examples/estate` lacks the dep), so the
    in-request join is **aspirational until a route is wired** — said so in Status, Context,
    Decision, Phase 2, and Phase 3 (which is re-scoped to *build* that first route + add the dep,
    not a thin dogfood).
  - **Stated the no-span-store boundary:** 0031 only EMITS spans to OTLP and builds **no queryable
    per-`requestId` span store** — so 0032 `explain_request` / 0033 activity panel have **no
    producer here** (new Deferred entry + scope-boundary note).
  - **Trace-poisoning guard:** ruled out the *"extend `ALLOWED_REQUEST_HEADERS` with
    `traceparent`"* option entirely — trace context must be injected by the trusted app seam, never
    carried through agent-supplied headers (`tools.ts:275-283` excludes trust headers by design).
  - **Attribution drift:** re-attributed the existing `McpAuditRecord`/`McpAuditSink`/audit to the
    **shipped pre-0028 `requireOperator`** mechanism (`tools.ts:254`), not ADR 0028's
    Accepted-but-unbuilt principal-aware audit.
  - **Re-anchored all stale MCP/runtime citations** to the current tree (every MCP `tools.ts`/
    `server.ts` ref was off by ~40-80 lines): `McpAuditRecord` 77-93 (was 35-51), `McpAuditSink`
    96 (was 53-54), `DispatchOptions`/`now` 588-596 (was 506-513), the audit closure + try/catch
    626-649 (was 543-566), `MCP_UNKNOWN_TOOL` 636, `handle_request` 354-394 / `app.handle` call 393
    (was 287-329/327), the stdio `CallToolRequestSchema` handler `server.ts:72-83` (was 43-54),
    `requireOperator` 254, `ALLOWED_REQUEST_HEADERS` 275-283; plus the transport span-mint
    (`runtime/src/server.ts:1344-1361`, `cloudflare/src/fetch-handler.ts:742-746`), the RUM export
    block (`index.ts:89-95`), and `currentRequestSpan` (`web/src/context.ts:142`). The `@lesto/ai`
    and `@lesto/observability` `tracer.ts`/`traces.ts` citations were confirmed correct and
    unchanged.

## Consequences

- An in-request LLM call produces **one trace** in the same collector and tooling as a user
  request — `http.request → ai.generate → ai.tool → db.query` — because `runAgent`/`generateText`
  run inside the HTTP handler where the request span is live (Phase 2's spans, **once Phase 3
  wires the route** — no such route exists today). An MCP tool call becomes a **standalone
  `mcp.tool` span** in the same collector (Phase 1); it is **not** a child of `http.request`, and
  joining it to the request it triggers is **Deferred** (a new span-minting seam, not a header
  thread). No JS meta-framework ships LLM/agent spans stitched into the request trace; this
  extends Lesto's already-real browser→API→DB trace to the agent tier — and the *shared
  `ai.*`/`mcp.*` vocabulary* is the small artifact the later trace-attachment phases of the
  agent-native wave can group their activity on (it is **not** a gate 0034-P1/0035-P1 depend on).
- The committed **Phase 1** (the MCP dispatch `onSpan` seam + the shared vocabulary) is
  **shippable and 100%-covered** — it lands on `@lesto/mcp` and `@lesto/observability`, both above
  the gate, with no new package edges. It delivers the span and the seam; it does **not** deliver
  the MCP request-trace join (Deferred) and builds **no** queryable per-`requestId` span store
  (so 0032 `explain_request` / 0033 activity panel have no producer here).
- The `ai.generate`/`ai.tool` spans are **PREVIEW**, honestly: they live on the preview
  `@lesto/ai` package and are labelled preview in any public copy, exactly as `@lesto/ai` itself
  is — the claim is "agent and LLM calls appear on the same trace," not a metrics/eval product.
- Slow iteration upheld: the smallest sound primitive (one injected dispatch seam + one shared
  vocabulary) is committed; the preview AI spans and the richer streaming/embed/eval spans are
  designed-or-deferred behind their real consumers, not scheduled.

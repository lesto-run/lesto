# Agent-observable runtime — implementation plan

Derived from **ADR 0031** (agent-observable runtime — the shared `ai.*`/`mcp.*` span
vocabulary is *the shared vocabulary the later trace-attachment phases agree on*, NOT a wave
keystone; 0034-P1 and 0035-P1 do not depend on it). The committed scope is **Phase 1 only**:
an injected `onSpan` tracer seam on `@lesto/mcp`'s `dispatch` so every governed agent action
becomes a **standalone** `mcp.tool` span in the same collector, plus a small shared AI/agent
**span vocabulary** in `@lesto/observability`. **Honest scope:** `dispatch` runs from the
**stdio** MCP server (`mcp/src/server.ts:72-83`) **outside** any HTTP request, so the Phase 1
`mcp.tool` span is **standalone (unparented)** — and the MCP↔request-trace join is **CUT** (the
2026-06-22 review proved `app.handle`/`lesto().handle` mint no `http.request` span and parse no
`traceparent` — span-mint lives only in the transport layer, which `handle_request` bypasses).
The join is **Deferred** as a NEW span-minting seam inside `handle_request`/the kernel, not a
header thread. Phase 1 alone is the span + the seam, NOT "MCP activity on the request trace."
**Phase 2** (the `ai.generate` + `ai.tool` spans inside `@lesto/ai`'s `runAgent`/`generateText`)
lands on the **PREVIEW** `@lesto/ai` package and stays preview (coverage-gate-exempt because it
declares **no `test:cov`**; pure core still tested), is gated on the Phase 1 vocabulary, and
parents on the in-flight request span **only once a route is wired to call `@lesto/ai`** — there
is **no such route consumer anywhere in the repo today** (`examples/estate` lacks the dep), so
"joins correctly" is aspirational until wired. **Phase 3** is the `examples/estate` dogfood QA
gate, gated on Phase 2; it **builds that first AI route consumer** (adds the `@lesto/ai` dep + an
AI route — not a thin dogfood). 0031 only EMITS spans to OTLP — it builds **no queryable
per-`requestId` span store**, so 0032 `explain_request` / 0033 activity panel have no producer
here. Streaming-span lifecycle, embed/retrieval spans, eval spans, **and the MCP↔request-trace
join** are **deferred**, each on a real consumer/seam.

**Packages:**
- `@lesto/observability` — the tracing core; gains the additive `ai.*`/`mcp.*` span vocabulary
  (value-level constants + a pure structural mapping helper). No new dependency.
- `@lesto/mcp` — the governed control plane; `dispatch` gains an optional injected `onSpan` seam
  fired on every audited dispatch (Phase 1). **The MCP↔request-trace join is CUT** (see header) —
  no `traceparent` forward, no `handle_request` change. No `@lesto/observability` dependency added
  (the app supplies the standalone `mcp.tool` span via the `onSpan` thunk).
- `@lesto/ai` (**PREVIEW**) — the model/agent layer; `generateText`/`runAgent` gain an optional
  injected `tracer` seam (the app adapts the observability `Tracer` to it). No
  `@lesto/observability` dependency added.
- `examples/estate` — the dogfood / QA gate: **adds the `@lesto/ai` dep and a new AI route** (none
  exists today), then wires the `Tracer`-to-`AgentTracer` adapter (parented on
  `currentRequestSpan`) so the AI path lands on one trace, locally and on a real deploy. (The MCP
  path's join is Deferred; estate may show the standalone `mcp.tool` span but asserts no join.)

> **The bar, every increment:** TS/ESM/Bun; oxlint/oxfmt clean; 100% vitest coverage on touched
> packages; `bun run ws:typecheck` + the serial coverage gate green; coded errors; truthful doc
> comments; one conventional commit on `main`. Layering invariants, grep-asserted:
> `@lesto/observability` gains **no** `@lesto/mcp` and **no** `@lesto/ai` import (the vocabulary
> helper takes a **structural** record, not an imported type); `@lesto/mcp` gains **no**
> `@lesto/observability` import (inject the `onSpan` seam instead); `@lesto/ai` gains **no**
> `@lesto/observability` import and stays dependency-light (inject the `tracer` seam instead);
> AI/agent spans route through the **existing** `currentSpan`/`inbound` → child-span path
> (`tracer.ts:114,26-44`) and the one OTLP exporter, **never** a new telemetry pipeline.
>
> **PREVIEW exemption (mechanism, not label):** the coverage gate skips a package iff it declares
> **no `test:cov` script** (`scripts/coverage-gate.ts:35`). `@lesto/ai` declares none
> (`package.json:14-20`), so it is exempt — the exemption is the *absence of `test:cov`*, NOT a
> "preview" marker (e.g. `@lesto/ui-generate` DECLARES `test:cov` → it IS gated at 100% despite
> being preview). Phase 2's spans inherit `@lesto/ai`'s exemption; its pure core is still fully
> tested (loop + span emission via a fake `tracer`); the gate is **not** changed to cover
> `@lesto/ai`. Were a `test:cov` ever added to `@lesto/ai`, Phase 2 would owe 100% there too.
>
> (No Co-Authored-By / "Generated with Claude" / 🤖 trailer on commits — conventional single-line
> `type(scope): summary` on `main`.)

## Increments

1. **Add the shared AI/agent span vocabulary to `@lesto/observability`** — `[shared vocabulary]`
   Files: `packages/observability/src/agent-vocabulary.ts` (new),
   `packages/observability/src/index.ts`, `packages/observability/test/agent-vocabulary.test.ts` (new).
   Export value-level `const` span names (`AI_GENERATE_SPAN = "ai.generate"`, `AI_TOOL_SPAN`,
   `MCP_TOOL_SPAN`) and attribute keys (`ai.model`, `ai.usage.input_tokens`,
   `ai.usage.output_tokens`, `ai.stop_reason`, `ai.streaming` (added later, L-1cbabfc0),
   `ai.tool.name`, `mcp.tool`, `mcp.input_hash`,
   `mcp.outcome`, `mcp.duration_ms`), plus a pure `mcpAuditToSpanAttributes(record)` that maps a
   **structural** `{ tool; inputHash; outcome; durationMs }` value onto the `mcp.*` attribute bag.
   It takes the structural shape — NOT an imported `McpAuditRecord` — so `@lesto/observability`
   gains no `@lesto/mcp` edge (the same structural-marker discipline ADR 0028 uses). This is the
   one contract the (covered) MCP span and the (preview) AI span must agree on — *the shared
   vocabulary the later trace-attachment phases agree on*, NOT a wave keystone (0034-P1/0035-P1
   import none of it).
   Acceptance: every exported name + the helper are unit-tested for exact values and the full
   attribute mapping; `grep` shows no `@lesto/mcp`/`@lesto/ai` import in `@lesto/observability`;
   `ws:typecheck` + serial coverage gate green; coverage 100%.

2. **Add an injected `onSpan` seam to `@lesto/mcp`'s `dispatch`** — `[the binding]`
   Files: `packages/mcp/src/tools.ts`, `packages/mcp/test/tools.test.ts`.
   Extend `DispatchOptions` (`tools.ts:588-596`, alongside `now`) with an optional
   `onSpan?: (record: McpAuditRecord) => void`. After the existing audit write — on **both** the
   `ok` and `error` paths (`tools.ts:626-649`) — call `onSpan` with the same `McpAuditRecord`,
   so every governed action that is audited is also offered as a span. `onSpan` is observability,
   not governance: it is optional (absent → no-op, zero cost, mirroring `LESTO_OTLP_URL` absent),
   and a throw from it must **never** break the dispatch — wrap the call so a fault is swallowed to
   a coded-noop, the audit (mandatory, awaited) stays the governance record. `@lesto/mcp` gains
   **no** `@lesto/observability` import — the seam is injected; the app supplies it (Inc 4).
   **Scope honesty:** this increment ships the span + the seam, NOT the request-trace join —
   `dispatch` runs from the stdio server (`server.ts:72-83`) outside any HTTP request, so the
   `mcp.tool` span the app opens here is **standalone (unparented)**. The join is **CUT** (former
   Inc 3 — see Deferred): `app.handle` mints no `http.request` span, so no header can join it.
   Acceptance: tests assert `onSpan` fires exactly once per dispatch on success, on handler
   error, AND on `MCP_UNKNOWN_TOOL` (`tools.ts:634`), carrying the same record the audit got;
   a test injects a throwing `onSpan` and asserts the dispatch result/error is unaffected (the
   throw is swallowed); `grep` shows no `@lesto/observability` import in `@lesto/mcp`;
   `ws:typecheck` + serial coverage gate green; coverage 100%.

> **~~3. Thread a `traceparent` from the MCP dispatch into `app.handle`~~ — CUT (was "Phase 1b").**
> The 2026-06-22 independent review proved this **unbuildable as framed** (blocker, high
> confidence): `app.handle` / `lesto().handle` (`web/src/lesto.ts:507`) and the kernel
> `App.handle` (`kernel.ts:218`) are the **pure dispatch** — they never mint an `http.request`
> span and never parse `traceparent`. Span-mint + `traceparent`-parse live **only** in the
> transport layer (`runtime/src/server.ts:1344-1361`, `cloudflare/src/fetch-handler.ts:742-746`),
> and `handle_request` calls `context.app.handle(...)` (`tools.ts:393`) **directly**, bypassing
> it. Forwarding a `traceparent` header into `app.handle` is **inert** — nothing reads it, no
> root span exists to adopt it, so the old acceptance can never pass. (Extending
> `ALLOWED_REQUEST_HEADERS` with `traceparent` was also a trace-poisoning surface and is ruled
> out.) **Moved to Deferred** as a NEW span-minting seam inside `handle_request`/the kernel: wrap
> the inner dispatch in `runWithContext` + `tracer.startSpan("http.request", inbound)` with the
> `mcp.tool` span's `{traceId, spanId}` as the adopted `inbound` — a real web/kernel/runtime
> change, not a header thread. **Committed scope is Phase 1 only (Inc 1–2) plus the AI-path
> Phase 2/3 (Inc 3–4) and docs (Inc 5).**

3. **Emit `ai.generate` + `ai.tool` spans from `@lesto/ai` via an injected `tracer` seam** — `[reuses Inc 1]` `[preview]`
   Files: `packages/ai/src/agent.ts`, `packages/ai/src/generate.ts`, `packages/ai/src/types.ts`,
   `packages/ai/test/agent.test.ts`, `packages/ai/test/generate.test.ts`.
   Add an optional injected `tracer?: AgentTracer` to `RunAgentOptions` (`agent.ts:19-30`) and
   `GenerateOptions` (`types.ts:94-107`), where `AgentTracer` is the minimal structural shape
   `{ startSpan(name, attrs): { setStatus(s): void; end(): void } }`. **The observability `Tracer`
   does NOT satisfy this shape directly** — `Tracer.startSpan(name, options)` takes a
   `StartSpanOptions` `{parent?, inbound?, attributes?}` as its 2nd arg (`tracer.ts:114,32-47`),
   not a flat attr bag, so passing the bag raw would be read as `StartSpanOptions` and **silently
   drop every attribute** (and never thread the parent). So the **app ADAPTS** the `Tracer` to
   `AgentTracer` (Inc 4), e.g.:
   `startSpan: (name, attrs) => { const s = tracer.startSpan(name, { ...(currentSpan() ? { parent: currentSpan() } : {}), attributes: attrs }); return { setStatus: (st) => s.setStatus(st), end: () => s.end() }; }`.
   `generateText` opens one `ai.generate` span per model call with attributes from the data it
   already has (`modelId ?? model.defaultModelId`, the parsed `Usage`, the `StopReason`), status
   `error` (the `AiError` code in attrs) when the provider call throws the coded `AI_HTTP_ERROR`
   it raises (`generate.ts:19-26`, `errors.ts:13-25`). **Do NOT cite `AI_STREAM_MALFORMED` here —
   it is thrown only on the streaming path (`generate.ts:36-43`), which Phase 2 does not
   instrument; it belongs to the deferred streaming span.** `runAgent` opens an `ai.tool` span per
   `ToolCall` it runs (`agent.ts:100,122-140`), named by `ToolCall.name`, status from whether the
   executor threw (a hallucinated tool surfaces the existing `AI_TOOL_NOT_FOUND` on the span). Span
   NAMES come from Inc 1's vocabulary (use the structural shape; do NOT import
   `@lesto/observability` — the constants are re-stated or the test asserts they match).
   `@lesto/ai` gains no `@lesto/observability` dependency and stays dependency-light
   (`package.json:32-34`); the seam is injected exactly like `transport` (`types.ts:84-92`).
   **PREVIEW:** these spans inherit `@lesto/ai`'s coverage-gate exemption (it declares **no
   `test:cov`** — the exemption mechanism, not a preview label); the pure core (the loop, the span
   emission) is still fully tested via a fake `tracer`. **No request-trace join exists yet:** no
   route calls `runAgent`/`generateText` in the repo today, so these spans only land *on a request
   trace* once Inc 4 wires the estate route — the mechanism is sound, "joins" is true once wired.
   Acceptance: tests drive `runAgent`/`generateText` with a fake `tracer` and assert one
   `ai.generate` per model turn **with the attribute bag actually landing on the emitted span**
   (a test that injects the real `Tracer`-adapter and asserts attributes land under the
   `SpanData.attributes` — guarding the attribute-drop trap above), one `ai.tool` per tool call,
   error status + `AI_HTTP_ERROR`/`AI_TOOL_NOT_FOUND` code on a thrown provider/tool call;
   tracer-absent path asserted as a clean no-op; `grep` shows no `@lesto/observability` import in
   `@lesto/ai`; `ws:typecheck` green; the package
   is preview (coverage-gate-exempt) so the serial gate stays green by skipping it.

4. **Build the first AI route consumer in `examples/estate` + dogfood the trace** — `[per gallery-as-QA-gate]` `[reuses Inc 1, 3]`
   Files: `examples/estate/package.json` (add `@lesto/ai` dep), `examples/estate/src/app.ts`,
   `examples/estate/src/controllers.ts` (or a new AI route), `examples/estate/test/*` as needed.
   **This is NOT a thin thunk-through dogfood:** estate today depends on **neither** `@lesto/ai`
   **nor** `@lesto/mcp` (verified — `examples/estate/package.json`) and wires no AI route. So this
   increment **first makes the in-request AI join real**: add the `@lesto/ai` dep, build a
   `runAgent`/`generateText` **route**, and wire the **`Tracer`-to-`AgentTracer` adapter** (Inc 3,
   parented on `currentRequestSpan` (`web/src/context.ts:142`)) onto it. estate already builds
   `Traces` from the env and threads `seams` through `buildApp` (`app.ts:54-90`,
   `production.ts:74-92`). The span thunk calls `traces.tracer.startSpan({ parent:
   currentRequestSpan(), attributes })` directly with Inc 1's vocabulary — NOT `traces.seams.*`, a
   closed `TraceSeams` set with no `mcp.tool`/`ai.*` member (`traces.ts:174-231`); keep it closed.
   The result: one HTTP request that calls an LLM produces `http.request → ai.generate → ai.tool →
   db.query` on one trace, in the OTLP collector estate already exports to. **The MCP join is out
   of scope** (Deferred); estate MAY add the Inc 2 `onSpan` thunk to show the standalone `mcp.tool`
   span exists, but **asserts no `mcp.tool → http.request` join**. Feature is not done until the AI
   trace shows up locally AND on a real deploy (gallery-as-QA-gate).
   > **Reconciled at build (2026-07-01, L-fbe9cbda → L-a3700b06):** the AI-span *join* is a **node /
   > local-OTLP** story — `serve.ts` wires the `AgentTracer` adapter and the join is asserted in
   > `examples/estate/test/ai-trace.dogfood.test.ts`. estate's only *deploy* target is the
   > Cloudflare Worker (`worker.ts` → `buildEdgeApp`), which is **transport-spans-only by design**
   > (no seams wired into the app — the edge emits no `db.query` child spans either), so the deployed
   > concierge **answers but is untraced**. The honest bar is therefore "the agent trace is
   > demonstrated locally; the edge deploy answers the same route untraced" — not "the AI trace shows
   > up on a real deploy." The docs (ARCHITECTURE.md §7, `site/content/docs/batteries/observability.md`)
   > state it this way. Wiring edge AI tracing is possible (`worker.ts` already builds `Traces` +
   > `currentRequestSpan`) but contradicts the deliberate edge posture, so it is intentionally not done.
   Acceptance: an estate test (or integration leg) asserts the `ai.generate`/`ai.tool` spans carry
   the in-flight `http.request` span as parent (the in-request join, now real because the route
   exists); estate builds, typechecks, and deploys; `ws:typecheck` + serial coverage gate green;
   estate's own coverage bar held. **No assertion of any MCP request-trace join** (it is Deferred).

5. **Document the agent-observable trace** — `[docs]`
   Files: `ARCHITECTURE.md` (§7 observability — extend the browser→API→DB trace to the agent
   tier), `site/content/docs/*` as appropriate.
   State precisely: "agent and LLM calls appear on the same trace as your request" — true for the
   in-request LLM path **once a route is wired** (Inc 4 builds the first such route in estate). Do
   NOT claim the **MCP** span is on the request trace at all — it is **standalone**, and the MCP
   join is **Deferred** (a new span-minting seam, not shipped). Mark the `ai.generate`/`ai.tool`
   spans **PREVIEW** (they ride the preview `@lesto/ai`). Do NOT imply a metrics/cost/eval product
   — token counts are span attributes, not a pipeline (claims guardrail §5). Do NOT imply a
   queryable span store (0031 only emits to OTLP). Keep the "traces only" scope line intact.
   Acceptance: doc copy matches shipped reality (Phase 1 covered on `@lesto/mcp`/
   `@lesto/observability`; AI spans PREVIEW-labelled and parented only once a route is wired; the
   MCP join Deferred, not claimed); no banned register; no metrics/eval/span-store claim;
   `ws:typecheck` + serial coverage gate green (docs touch no covered source).

## Layering invariants

Folded into the bar block above; restated at the increment where each is load-bearing:
- Inc 1: `@lesto/observability` gains no `@lesto/mcp`/`@lesto/ai` import — the helper takes a
  structural record, not an imported type.
- Inc 2: `@lesto/mcp` gains no `@lesto/observability` import — `onSpan` is injected; the app
  supplies the standalone `mcp.tool` span thunk. (The MCP join is CUT/Deferred, no serializer.)
- Inc 3: `@lesto/ai` gains no `@lesto/observability` import and stays dependency-light — `tracer`
  is injected like `transport` (the app adapts the `Tracer` to `AgentTracer`).
- Inc 4: the `ai.*` (and any optional standalone `mcp.tool`) spans are emitted via a bespoke thunk
  over `traces.tracer.startSpan` — NOT via `traces.seams.*`, which is a closed `TraceSeams` set
  (`traces.ts:174-231`) with no `mcp.tool`/`ai.*` member; this phase keeps it closed.
- All: AI/agent spans route through the existing `currentSpan`/`inbound` → child-span path and the
  one OTLP exporter, never a new telemetry pipeline.

## Owned elsewhere (do not duplicate)

- **The child-span parenting mechanism** lives in `@lesto/observability`'s `createTraces`
  (`traces.ts:267-368`) and `Tracer.startSpan({ parent })` (`tracer.ts:114`). The increments
  *inject* a tracer that opens spans through it; they do not reimplement parenting.
- **The in-flight request span** is published by `@lesto/web`'s `currentRequestSpan`
  (`web/src/context.ts:142`). estate (Inc 4) passes it as the tracer's `currentSpan` for the AI
  path — the *app* owns the binding, not `@lesto/mcp`/`@lesto/ai`. (The MCP path can't read it —
  stdio dispatch is outside a request, AND `app.handle` mints no span — so the MCP join is
  Deferred to a new span-minting seam, not in this plan.)
- **The mandatory audit record** is owned by `@lesto/mcp`'s `dispatch`/`McpAuditSink` (the shipped
  pre-0028 `requireOperator` mechanism — `tools.ts:96,254,608-650`; ADR 0028's principal-aware
  audit is Accepted-but-unbuilt). `onSpan` is the additive observability shadow; it never replaces
  the awaited governance audit and the increments must not collapse the two.
- **The OTLP exporter + flush lifecycle** is owned by `tracesFromEnv`/`createTraces`
  (`traces.ts:408-442`). The increments emit spans onto the existing tracer; they add no
  exporter.

## Deferred (per ADR 0031 — not in this plan)

- **The MCP↔request-trace join (`mcp.tool → http.request`)** — *was* committed Inc 3 ("Phase 1b");
  **CUT** as unbuildable-as-framed (see Inc 3 note). Needs a NEW span-minting seam inside
  `handle_request`/the kernel (wrap the inner dispatch in `runWithContext` +
  `tracer.startSpan("http.request", inbound)` with the `mcp.tool` span as the adopted `inbound`) —
  a multi-package web/kernel/runtime change. The `traceparent` must be injected by the trusted app
  seam, never via agent-supplied headers. Gate: a real demand + the new seam designed.
- **A queryable per-`requestId` span store / dev span feed** — 0031 only EMITS spans to OTLP; it
  builds no store you can read spans back from by request. 0032's `explain_request` and 0033's
  activity panel need this and have **no producer in this plan**. Gate: whichever ADR commits a
  bounded dev-only span ring (natural home: 0032's access-log ring).
- **`ai.embed` / retrieval spans** — gated on a real estate retrieval (RAG) route.
- **~~Streaming-span lifecycle~~ (open-window for `streamText`) — SHIPPED 2026-07-01
  (L-1013f457), with the window drawn SLIGHTLY wider than the original "first-byte→last-byte"
  framing: the `AgentSpan` seam gained an optional `setAttributes` (open-before / populate-after),
  so `generateText`'s `ai.generate` span now carries the call's real duration (opened before the
  request, usage/stop-reason populated after) and `streamText` brackets the whole stream with one
  `ai.generate` span — opened on the **first pull** (before `buildStreamRequest`/`transport` even
  run, not literally at the first response byte) and closed once the generator terminates (last
  frame, an error, or an early `for-await` `break`, always via a `finally`). The streamed span
  carries the model id + duration + outcome (`"unset"` on an early break, not a fabricated `"ok"`),
  not tokens (the delta stream yields text only — a future increment could recover this from
  Anthropic's `message_delta` SSE frame, currently unparsed). `@lesto/ai` stays observability-free;
  the estate `Tracer`→`AgentTracer` adapter maps `setAttributes` → `setAttribute`. Every telemetry
  call is wrapped in a swallow-on-throw helper (`safely`) so a broken tracer can never mask a
  call's real result or crash an otherwise-successful generation.
- **Eval / guardrail spans** (`ai.eval`) — gated on ADR 0035's evals-in-CI wanting per-eval spans.

# Plan 029: The bounded dev-only trace ring + `get_trace`

> **Executor instructions**: This is ADR 0048 **Phase 0.2**. It commits the
> queryable span store ADR 0031 and ADR 0032 both declined to ship, so ADR 0048
> Phase 1.4 ("a failed invariant arrives with its trace") stops being a phantom.
> Land it increment by increment, gate green after each. Update `plans/README.md`
> when done.
>
> **Drift check (run first)**: `git log --oneline -5 -- packages/cli/src/dev-state.ts packages/observability/src/traces.ts packages/mcp/src/tools.ts`

## Status

- **Priority**: P2 (substrate; unblocks a gated Phase-1 capability)
- **Effort**: coarse M
- **Risk**: MEDIUM — one increment turns request tracing ON for `lesto dev` when
  no collector is configured. Dev-only, in-process, no network. See the STOP
  condition.
- **Depends on**: none (independent of plan 028)
- **Category**: observability substrate / agent control plane
- **Source**: ADR 0048 Phase 0.2 (Proposed, 2026-08-17)
- **Planned at**: commit `7b11787`, 2026-08-18

## Why this matters

ARCHITECTURE.md §7 states it plainly: "there is no queryable span store — spans
go to your OTLP collector like every other." ADR 0032's committed ring
(`cli/src/dev-state.ts`) holds `AccessEntry`s and says so: "this plan mints no
spans of its own beyond the access-log entries the seam fills."

So today an agent driving `lesto dev` can ask what was SERVED
(`get_recent_requests`) but not what HAPPENED inside — no db child spans, no
browser RUM spans, nothing. Every trace-shaped question needs a collector the
developer is not running.

## Current state (verified)

- `packages/cli/src/dev-state.ts` — the bounded `AccessEntry` ring. `AccessEntry`
  (`runtime/src/server.ts:128`) carries `requestId` and **no** `traceId`.
- `packages/runtime/src/server.ts` — `logRequest` and the request span settle in
  the SAME `finally`, so the runtime already holds both halves of the correlation.
- `packages/observability/src/traces.ts:439` — `tracesFromEnv` returns
  `undefined` unless `LESTO_OTLP_URL` is set: **with no collector configured, no
  span is ever minted**. Both server spans (via `Tracer` → exporter) and browser
  spans (via `seams.onBrowserSpan` → `TracesOptions.exportSpan` → the same
  exporter) funnel through ONE `SpanExporter`, which is the natural tee point.
- `packages/web/src/browser-spans.ts` — the receiver normalizes client-supplied
  spans and hands them to an injected `BrowserSpanSink`, defaulting to a
  console line. An app opts into the trace join with `.browserSpans(sink)`
  (`examples/estate/src/app.ts:95` does, when seams are present).
- `packages/mcp/src/tools.ts:459` — `buildDevTools(reader)` builds the three dev
  tools ONLY when `context.devState` is present; `DEV_TOOL_NAMES` (`:665`)
  reserves their names even off-dev.
- `packages/cli/src/bin.ts:1562` — `createDevState()` is constructed only for
  `command === "dev"`.

### Conventions to follow

- CONVENTIONS.md: strict TS, ESM, 100% coverage on every touched non-preview
  package (`@lesto/cli`, `@lesto/mcp`, `@lesto/observability` are all gated),
  coded errors, inject what varies, comments name the invariant.
- **No silent truncation.** A bounded ring that drops spans must SAY it dropped
  them, or a partial trace reads as a complete one.
- ADR 0032's posture is inherited verbatim: the tool is built only when a
  `devState` reader is present, so it cannot exist — let alone be advertised — on
  any non-dev or remote server. PREVIEW.

## The design

**One ring, keyed by traceId, fed from the one place every span already passes.**

- `packages/cli/src/trace-ring.ts` — a pure bounded store, a sibling of
  `dev-state.ts` (same shape: writer half, reader half, no I/O).
  - Bounded **twice**: `traceCapacity` retained traces (LRU by last write) and
    `spanCapacity` spans per trace. Over either bound the oldest goes, and the
    retained trace reports `truncated: true`.
  - Reader: `retainedTrace({ traceId?, requestId? })` — the trace for an explicit
    id, or (with neither) the most recently written trace. A `requestId` is
    resolved to a `traceId` by `createDevState`, the one place holding BOTH rings,
    through the `traceId` the runtime stamps on the access entry. **Never** by
    scanning span attributes: `lesto.request_id` is a field any caller of the
    public unauthenticated browser-spans receiver can set, so a scan would let a
    forged span point a developer's `get_trace` wherever it liked. (The first
    implementation scanned; the review caught it.)
  - Composed into `createDevState`, so `@lesto/mcp` keeps taking exactly ONE
    reader and the tool's gate stays "a devState reader is present".
- `@lesto/observability`: `tracesFromEnv` gains an optional `spanSink:
  SpanExporter`. It is a TEE, never a replacement — with a collector configured
  every span still goes to OTLP AND to the sink. With NO collector configured but
  a sink supplied, tracing runs **local-only**: spans are minted and land in the
  sink, `flush()` is a no-op, nothing leaves the process.
- `packages/cli/src/run.ts`: `buildServeTracing(deps, spanSink?)`. `runDev` passes
  the ring; `runServe` passes nothing, so **`lesto serve` is byte-for-byte
  unchanged**.
- `@lesto/mcp`: `McpDevStateReader` gains `retainedTrace`, and `buildDevTools`
  adds a fourth read-only tool, `get_trace`.

**⚠️ The one real behavior change**: with the ring wired, `lesto dev` mints
request spans even when `LESTO_OTLP_URL` is unset. That means dev pages start
carrying the `<meta name="lesto-traceparent">` the runtime stamps when a request
span exists, and a project that wires `seams` gets its db-query child spans in
dev. All of it stays in-process. This is deliberate: a ring that fills only when
the developer happens to be running an OTLP collector does not make ADR 0048's
"the claim is one ring-read" true. It is isolated in increment 3 so it can be
dropped without losing the ring or the tool.

## Increments

### Increment 1 — the ring (`@lesto/cli`)

New `packages/cli/src/trace-ring.ts`; `createDevState` composes it; both are
re-exported from `packages/cli/src/index.ts`.

**Acceptance tests** (`packages/cli/test/trace-ring.test.ts`):

- Spans of one traceId group under it, oldest-first, across interleaved traces.
- `retainedTrace({ traceId })` for an unknown/aged-out id reports not retained.
- `retainedTrace({ requestId })` resolves through the access entry's `traceId`; an
  unknown requestId, and a request served UNTRACED, both report not retained.
- A forged span claiming a `lesto.request_id` cannot redirect the lookup.
- `retainedTrace({})` returns the most recently written trace.
- The trace bound evicts the LEAST-RECENTLY-WRITTEN trace, not the oldest-created
  one (a long-running trace must survive a burst of short ones).
- The per-trace span bound drops the oldest spans and flips `truncated`.
- `createDevState` exposes the ring's reads and its `recordSpan` writer.

**Verify**: `cd packages/cli && bun run typecheck && bun run lint && bun run format:check && bun run test:cov` → exit 0, 100%.

### Increment 2 — `get_trace`, the fourth dev tool (`@lesto/mcp`)

`McpDevStateReader` gains `retainedTrace(selector): unknown`; `buildDevTools`
adds `get_trace` (description carries the PREVIEW label); `DEV_TOOL_NAMES` gains
the name so a domain tool can never shadow it.

**Acceptance tests** (`packages/mcp/test/tools.test.ts`):

- `get_trace` passes `traceId` / `requestId` / an empty selector through and
  returns the reader's answer.
- It is NOT built on a server with no `devState` (the existing "dev tools absent"
  test grows the name), and it IS listed on one that has it.
- The name is reserved against a colliding domain tool even off-dev.

**Verify**: `cd packages/mcp && bun run typecheck && bun run lint && bun run format:check && bun run test:cov` → exit 0, 100%.

### Increment 3 — fill it under `lesto dev`

`@lesto/observability`: `tracesFromEnv(env, { …, spanSink })`.
`@lesto/cli`: `buildServeTracing(deps, spanSink?)`; `runDev` passes the ring; the
flush interval is started only when a collector is actually configured.

**Acceptance tests**:

- `packages/observability/test/traces.test.ts`: with a collector URL, a span
  reaches BOTH the exporter and the sink; with no URL but a sink, tracing is ON
  and spans reach only the sink and `flush()` resolves; with neither, `undefined`
  (unchanged).
- `packages/cli/test/run.test.ts`: `lesto dev` records a served request's span in
  the ring, and `get_trace` over the dev MCP plane returns it correlated by the
  `requestId` `get_recent_requests` reported — the end-to-end claim.
- `lesto serve` still gets no span sink (the unchanged path).

**Verify**: `cd packages/observability && bun run test:cov` and `cd packages/cli && bun run test:cov` → exit 0, 100%.

### Increment 4 — estate + docs

- `examples/estate/test/dev-mcp.dogfood.test.ts` (the existing dev-MCP dogfood):
  drive a request through `lesto dev` and read its trace back through `get_trace`.
- **ARCHITECTURE.md §7** currently states "there is no queryable span store".
  That becomes false the moment this lands — amend it to name the dev-only,
  bounded, PREVIEW ring and keep the production claim (OTLP-only) intact.
- `packages/create-lesto/src/templates.ts` — the scaffolded `AGENTS.md` lists the
  read-only dev tools; add `get_trace`.
- `docs/adr/0032-dev-loop-control-plane.md` — record the fourth tool as an ADR
  0048 Phase 0.2 amendment.
- `plans/README.md` — add the 029 row.

**Verify**: `cd examples/estate && bun run test` → exit 0; `cd packages/create-lesto && bun run test:cov` → exit 0, 100%.

## Done criteria

- [ ] A bounded, doubly-capped, truncation-honest trace ring beside `dev-state.ts`
- [ ] `get_trace` exists ONLY when a `devState` reader is present, and its name is reserved
- [ ] Under `lesto dev`, a served request's spans are readable by `requestId`
- [ ] `lesto serve` behavior unchanged (no span sink, no local-only tracer)
- [ ] `@lesto/cli`, `@lesto/mcp`, `@lesto/observability` at 100% coverage
- [ ] ARCHITECTURE.md §7's "no queryable span store" claim corrected
- [ ] `plans/README.md` row for 029 updated

## STOP conditions

- Increment 3's local-only tracer changes `lesto dev` in a way an existing test
  pins as contractual (e.g. a dev page asserted to carry NO traceparent meta) —
  ship increments 1, 2, and the OTLP tee only, and report the local-only tracer
  as a separate decision for the owner.
- Carrying a `traceId` on `AccessEntry` turns out to break a consumer of that
  published type — fall back to a CLI-private map fed from the access-log seam, and
  say which consumer forced it.

## Maintenance notes

- The ring is the producer ADR 0048 Phase 1.4 (verify's trace attachment) reads.
  A trace that aged out is the `retained: false` answer, not an error.
- The spans are UNTRUSTED where they came from the browser receiver — the same
  posture `browser-spans.ts` documents. The ring stores them beside server spans
  and keys NOTHING off them: the `requestId` bridge is a map the SERVER writes
  from the in-flight request span, because the obvious alternative (scanning spans
  for a `lesto.request_id` attribute) reads a field any caller of the public
  receiver can set. Found in review; the first implementation scanned.
- Two further review corrections landed: a trace the cap evicted and later rebuilt
  now reports `truncated` (it was silently reading as complete), and the trace
  window defaults to the request window so the advertised
  `get_recent_requests` → `get_trace` hop resolves for everything the first tool
  reports.

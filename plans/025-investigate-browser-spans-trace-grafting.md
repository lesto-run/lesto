# Plan 025: Investigate — unauthenticated browser-telemetry can graft onto server traces

> **Executor instructions**: INVESTIGATE plan — the deliverable is a decision
> (accept-with-mitigation vs. fix) plus, if the decision is "mitigate," a small
> built-in rate cap. Do the investigation first and STOP for the decision before
> any redesign. Update `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat 164bcaa..HEAD -- packages/web/src/browser-spans.ts packages/web/src/lesto.ts packages/web/src/client-errors.ts`

## Status

- **Priority**: P3 (investigate)
- **Effort**: S–M
- **Risk**: LOW
- **Depends on**: none
- **Category**: security (observability integrity)
- **Planned at**: commit `164bcaa`, 2026-07-11

## Why this matters

The built-in RUM/telemetry receivers accept a fully client-supplied `traceId`
(any 32-hex) and forward each span to the OTLP/log sink **with no
authentication**. Because the join key is client-chosen, an unauthenticated
caller can inject fabricated spans and graft them onto a known/guessed **server**
trace — corrupting the "UI→API→DB, one trace" record an operator relies on and
inflating OTLP ingestion cost. This is close to an inherent property of
client-side RUM stitching (the browser MUST echo the server trace id to join), so
the right answer may be an accepted-tradeoff note plus a built-in per-route rate
cap rather than a redesign — hence: investigate, don't fix blind.

## Current state

- `packages/web/src/browser-spans.ts:135` — `normalizeBrowserSpan` accepts a
  client `traceId` / `parentSpanId` / `name` / string attributes (size/length
  capped, PII-free), then `:254` forwards to the sink unauthenticated.
- `packages/web/src/lesto.ts:871` registers `POST /__lesto/browser-spans` (and
  `:858` the client-error beacon) as **unauthenticated built-ins**. They ride
  `useChain`, so an app that wires `secureStack({ rateLimit })` gets a rate cap —
  but it is not built-in.
- `packages/web/src/client-errors.ts:105` — the analogous beacon path.

## What to produce

A short decision record (append here or `plans/notes/025-browser-spans.md`):
1. Is trace-id echo genuinely required for RUM stitching here, or can acceptance
   be bound to a per-request nonce/signed trace token stamped in the SSR `<meta>`
   (so only the page the server actually served can contribute to that trace id)?
2. What is the ingestion-cost exposure without a built-in rate cap on the
   reserved `/__lesto/*` telemetry routes?
3. Decision: (a) bind acceptance to a signed/nonce trace token, (b) ship a tight
   **built-in** rate limit on `/__lesto/*` telemetry independent of app
   middleware, and/or (c) document the integrity tradeoff alongside the existing
   PII/byte-bound notes.

## Steps

### Step 1: Assess the stitching requirement

Read how the server trace id reaches the browser (SSR injection) and whether a
signed/nonce token could replace the raw echo without breaking legitimate RUM.

### Step 2: Assess the built-in rate story

Determine whether `/__lesto/browser-spans` and the error beacon can carry a
built-in rate cap independent of `secureStack` (so the mitigation holds even when
an app forgets to wire rate limiting).

### Step 3: Decide + (if chosen) implement the rate cap only

**Pre-steer (do not re-derive):** trace ids are 128-bit and unguessable, so the
realistic exposure is NOT targeted grafting onto a *known* server trace — it is
(a) self-grafting (low value) and (b) **unauthenticated ingestion-cost DoS**
(real). That points at outcome (b)+(c): a built-in rate cap + a documented
tradeoff. Also price option (a) (signed SSR trace token) against **ADR 0024 soft
navigation** — client-side route changes emit spans under a document whose token
has gone stale, which likely kills the signed-token design on its own.

If "mitigate," implement the built-in cap with tests. **Two hard constraints:**
- The cap's store **must be bounded** (fixed-size / evicting). A naive per-key
  `Map` grows monotonically under attacker-varied keys — that would trade span
  forgery for the exact unbounded-limiter-store memory-DoS the repo already
  tracks (`L-976b4302`). Do not reintroduce it.
- Decide and name where the limiter primitive comes from (a
  `@lesto/web`→`@lesto/ratelimit` dependency edge is a real coupling decision),
  since the done-criteria requires `web` `test:cov` at 100%.

If "bind to a signed token," scope it as a follow-up build plan. **STOP** for the
decision before any acceptance-model redesign.

## Done criteria

- [ ] A decision record answering the three questions exists
- [ ] If "mitigate": a built-in rate cap on `/__lesto/*` telemetry routes is
      implemented with tests, and `web`'s gate stays green (`test:cov` 100%)
- [ ] If "document only": the integrity tradeoff is written alongside the
      existing PII/byte-bound docs in `browser-spans.ts`
- [ ] `plans/README.md` status row for 025 updated (with the decision)

## STOP conditions

- The signed-token acceptance model turns out to require render-pipeline changes
  — record it as a follow-up build plan, don't attempt it in this investigate
  scope.

## Maintenance notes

- Whatever the decision, note it where the byte/PII bounds are documented so a
  future reader knows the trace-id-forgery angle was considered.
- Reviewer should confirm any rate cap is genuinely built-in (not dependent on
  the app wiring `secureStack`).

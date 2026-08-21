# Plan 030: Honest web vitals — real INP, session-windowed CLS, and the two doc drifts

> **Executor instructions**: This is ADR 0048 **Phase 0.3**. It exists because
> vitals BUDGETS are gated on it (ADR 0048 Phase 1.5): thresholding the numbers
> RUM emits today would false-green INP and false-red CLS. Land it increment by
> increment, gate green after each. Update `plans/README.md` when done.
>
> **Drift check (run first)**: `git log --oneline -5 -- packages/observability/src/rum.ts`

## Status

- **Priority**: P2 (correctness of a shipped measurement; unblocks a gated Phase-1 sub-item)
- **Effort**: coarse M
- **Risk**: LOW–MEDIUM (the wire gains spans and one attribute; one existing span
  is RENAMED, which is the point)
- **Depends on**: none
- **Category**: observability correctness / claims accuracy
- **Source**: ADR 0048 Phase 0.3 (Proposed, 2026-08-17), validated by its adversarial pass
- **Planned at**: commit `7b11787`, 2026-08-18

## Why this matters

Three verified facts, each a measurement that is not what its label says:

1. **The "INP" span is not INP.** `spanForEntry` (`rum.ts`) maps a `first-input`
   entry to `tracer.vitalSpan("INP", entry.duration, entry.startTime)`. That is
   ONE event — the page's first — not the Interaction to Next Paint over the page
   lifetime. `OBSERVED_TYPES` does not include `"event"` at all, so the entries
   INP is actually computed from are never observed. A budget over this span is
   green on a page whose every later interaction janks.
2. **CLS is never computed.** `layout-shift` entries are emitted RAW, one span per
   eligible shift, valued `shift.value * 1000`. There is no session window and no
   sum. A consumer that reads a `browser.web_vital` value as CLS reads a single
   shift, ×1000 — three orders of magnitude off the 0.1 "good" threshold.
3. **Two docs claim what the code does not.** `web/src/browser-spans.ts` says the
   receiver takes "`browser.web_vital` spans for LCP/INP/CLS" — no CLS span has
   ever existed. ARCHITECTURE.md §7 and the launch blog post both claim "INP".

There is also no page-hide flush anywhere. `startBrowserRum` returns a disposer
documented as "called on page hide", and **no call site calls it**
(`assets/src/synthesize.ts` and `examples/estate/client.tsx` both discard it). A
lifetime metric that is only computed at page hide therefore has nowhere to be
computed — which is why this plan has to wire the hide seam, not just the math.

## Current state (verified)

- `packages/observability/src/rum.ts`
  - `OBSERVED_TYPES` = navigation · resource · largest-contentful-paint ·
    layout-shift · first-input. No `event`.
  - `vitalSpan(name, value, at)` writes `browser.vital` + `Math.round(value)` into
    `browser.value`. Nothing on the wire says which unit that number is in — ms
    for LCP/first-input, a ×1000 layout-shift score for a shift.
  - `startBrowserRum` returns `() => { flush(); observer.disconnect(); }`.
  - `RumEnvironment` has no page-hide seam.
- `packages/assets/src/synthesize.ts` emits `startBrowserRum();` — return dropped.
- `examples/estate/client.tsx` — same.
- `packages/web/src/browser-spans.ts:8` — the false CLS doc claim.
- `ARCHITECTURE.md:134` — "web vitals (LCP, INP, and raw per-shift `layout-shift`
  scores — not a summed CLS)".
- `www/content/blog/one-trace-from-the-browser-to-the-database.md:28,36` — same claim.

### Conventions to follow

- CONVENTIONS.md: strict TS, ESM, **100% coverage** on `@lesto/observability`,
  inject what varies (the page-hide seam joins `random` / `createObserver` /
  `send` as an injected capability, so every path stays testable with no browser).
- AGENTS.md trap — **vacuous tests**: assert the computed NUMBER against a
  hand-worked example, not merely that a span appeared.
- **bfcache discipline** (ADR 0009 / `ui/src/bfcache.ts`): the page-hide seam must
  listen on `visibilitychange` + `pagehide` and NEVER `unload`/`beforeunload`,
  which disqualify a page from the back/forward cache.
- **No unqualified claims** (ADR 0048 Non-goals): where the computation diverges
  from the spec's, the divergence and its DIRECTION get written down.

## The design

**Two lifetime metrics, O(1) state each, finalized once at page hide.**

- **INP = the longest interaction over the page lifetime.** Observe `event`
  entries (`durationThreshold: 40`, the web-vitals convention) plus `first-input`,
  and keep the maximum duration among entries carrying an `interactionId`. Since
  every event entry of one interaction shares that id and INP takes the max
  duration within an interaction, the global max across entries IS the worst
  interaction — no grouping, no unbounded map.

  *The divergence, stated:* the spec reports a high percentile (the 98th,
  approximated as the Nth-worst for a page with ≥50 interactions). For a page
  with fewer than 50 interactions — nearly all of them — the two are identical.
  Above that, the worst interaction is ≥ the percentile, so this **never reads
  better than the spec's number**. A budget built on it can false-RED, never
  false-green; that is the correct direction for the thing budgets exist to catch,
  and it is what makes the metric bounded to one number instead of a retained
  interaction list. The one floor: an interaction faster than the browser's
  `durationThreshold` is never reported at all, so a page whose every interaction
  is under 40 ms reports no INP rather than a small one.

- **CLS = the maximum session-windowed sum**, per the spec's own windowing: a
  shift joins the current session if it is within 1s of the previous shift and 5s
  of the session's first; otherwise it starts a new session. CLS is the largest
  session sum. Shifts with `hadRecentInput` are excluded, exactly as today. O(1)
  state (four numbers).

- **The scaling is on the wire, not just in a comment.** `vitalSpan` gains a
  `unit` and writes `browser.value_unit`: `"ms"` for LCP / INP / first-input,
  `"score_x1000"` for CLS and each raw layout-shift. `browser.value` stays
  `Math.round`ed, so a sub-unit score still needs the ×1000 — now a consumer can
  see that from the span instead of having to know it.

- **A page-hide seam.** `RumEnvironment.onPageHide(cb)` registers and returns an
  unregister; the browser default listens on `visibilitychange` (hidden) at the
  **document** and `pagehide` at the **window** — the targets that actually
  dispatch them — and never on `unload`. The returned disposer finalizes too, so a
  caller that wires it and one that does not both get the vitals.

  *Corrected in review (2026-08-18), twice:* the first implementation registered
  `pagehide` on the document, where it can never fire (its test dispatched at the
  same wrong target, so it passed); and it latched finalization to the FIRST hide,
  which froze both metrics at the first tab switch. Emission is now per-hide, gated
  on the value having changed — one span per vital on the common page, still
  correct for a page the user leaves and returns to.

**Not in scope** (recorded so it is not re-derived): removing the raw per-shift
`layout-shift` spans. They are the only per-event detail a debugger has, they
cost nothing extra, and the new `CLS` span is unambiguous beside them.

## Increments

### Increment 1 — the vitals accumulator (pure)

New exported `BrowserVitals` in `rum.ts`: `recordInteraction(durationMs, at)`,
`recordLayoutShift(value, at)`, `inp()`, `cls()` — each returning
`{ value, at } | undefined`. No DOM, no timers, O(1) state.

**Acceptance tests** (`packages/observability/test/rum.test.ts`):

- INP is the LONGEST interaction, not the first and not the last.
- INP is `undefined` before any interaction.
- CLS sums shifts inside one session window.
- A shift more than 1s after the previous one starts a NEW session; CLS is the
  MAX of the sessions, not the total (hand-worked numbers, both orders).
- A shift more than 5s after the session's FIRST starts a new session even when it
  is within 1s of the previous one (the second window rule, which a naive
  implementation drops).
- CLS is `undefined` before any shift.

**Verify**: `cd packages/observability && bun run typecheck && bun run lint && bun run format:check && bun run test:cov` → exit 0, 100%.

### Increment 2 — observe `event`, wire the units, finalize at page hide

- `OBSERVED_TYPES` becomes a list of observe-option objects so `event` can carry
  its `durationThreshold`; `PerfObserverLike.observe` accepts it.
- `spanForEntry` takes the accumulator: an `event` entry feeds it and emits NO
  span (one span per event would flood the wire); `first-input` feeds it AND emits
  its own honestly-named `first-input` vital; `layout-shift` feeds it and still
  emits the raw per-shift span.
- `vitalSpan` gains `unit`, emitted as `browser.value_unit`.
- `RumEnvironment.onPageHide`; `startBrowserRum` finalizes once (INP + CLS spans,
  then flush) on hide AND on dispose.

**Acceptance tests**:

- A page with several `event` entries emits ONE `INP` vital at page hide, valued
  by the worst interaction, and no vital per event.
- A page with shifts emits ONE `CLS` vital at page hide, valued by the max session
  sum ×1000, alongside the existing raw per-shift spans.
- Finalization is once-only: a hide followed by dispose emits one INP and one CLS.
- A page with no interactions and no shifts emits neither (and posts nothing).
- The renamed first-input span: the vital is `first-input`, and `INP` no longer
  appears until page hide. *(This is the RED-on-purpose rename — the existing
  assertion that pinned `"INP"` on a first-input entry is updated to pin the fix.)*
- `browser.value_unit` is `ms` on LCP/INP/first-input and `score_x1000` on
  CLS/layout-shift.
- The default `onPageHide` fires on `visibilitychange` → hidden and on `pagehide`,
  does NOT fire on `visibilitychange` → visible, and unregisters cleanly; it is a
  no-op with no `document`.

**Verify**: same package gate → exit 0, 100%.

### Increment 3 — wire the flush at the call sites, and estate

The disposer was documented as page-hide-driven and is discarded everywhere. With
increment 2 the seam is INSIDE `startBrowserRum`, so no call site change is
required for correctness.

**Decided, not skipped:** the synthesized entry and `examples/estate/client.tsx`
keep dropping the handle. Assigning it to an otherwise-unused const would be
noise, not safety — the vitals no longer depend on it. What DID change is the
documentation: `startBrowserRum`'s own doc block and the docs-site snippet used to
tell callers to wire `pagehide` themselves, which was the false half.

- `examples/estate/test/tracing.test.ts`: a RUM batch's `INP` and `CLS` vitals
  reach estate's own `browserSpans` seam with their units intact.

**Verify**: `cd packages/assets && bun run test:cov` → 100%; `cd examples/estate && bun run typecheck && bun run test && LESTO_DEMO=1 bun run build` → exit 0.

### Increment 4 — the doc drifts

- `packages/web/src/browser-spans.ts` — the receiver's doc claims LCP/INP/CLS.
  Make it name what actually arrives.
- `ARCHITECTURE.md:134` — "not a summed CLS" is now false; state the real set.
- `www/content/blog/one-trace-from-the-browser-to-the-database.md` — same claim in
  public copy, plus the sample trace tree.
- `site/content/docs/batteries/observability.md` — name the vitals and the
  page-hide finalization; its snippet already models `pagehide`.
- `plans/README.md` — add the 030 row.

**Verify**: `cd packages/web && bun run test:cov` → 100%; `cd site && bun run test` → exit 0; `cd www && bun run test` → exit 0.

## Done criteria

- [ ] `event` entries are observed; INP is the worst interaction over the page lifetime
- [ ] CLS is the max session-windowed sum, with BOTH window rules
- [ ] Both are emitted at a real page-hide finalization, exactly once
- [ ] The scaling is on the wire (`browser.value_unit`) and in the docs
- [ ] The first-input span is named `first-input`, not `INP`
- [ ] `@lesto/observability` and `@lesto/web` at 100% coverage
- [ ] The `browser-spans.ts` CLS claim, ARCHITECTURE.md §7, and the blog copy are true
- [ ] `plans/README.md` row for 030 updated

## STOP conditions

- The `event` entry type turns out to need a `buffered` + `durationThreshold`
  combination jsdom cannot express even through the injected observer — keep the
  seam injected and report which browser path is only covered by the integration
  suite rather than faking a capability.
- Renaming the first-input span breaks a downstream consumer that branches on
  `browser.vital === "INP"` — report it; the rename is the fix, but a consumer
  needs to move in the same change.

## Maintenance notes

- INP here is the worst interaction, not the spec's 98th percentile. That is
  written in the code and in the docs — **not** on the wire: the span carries
  `browser.vital: "INP"` and `browser.value_unit: "ms"`, neither of which says
  "max". A consumer cannot tell this from a p98 by reading one span. It is left
  that way because the divergence only ever reads WORSE than the spec's number
  (above the browser's 40 ms reporting floor), so a budget over it can false-red
  and never false-green. If a percentile is ever wanted, it needs a retained
  interaction list and an interaction count — bounded state this deliberately
  avoids.
- ADR 0048 Phase 1.5 (vitals budgets) is the consumer. It runs at `sampleRate: 1`
  and reads these spans from the Phase-0.2 trace ring.

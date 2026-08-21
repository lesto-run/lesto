---
"@lesto/observability": minor
---

Browser RUM now reports a real INP and a real CLS.

The span labelled `INP` was the page's single `first-input` entry — `event`-timing entries were never observed at all — so a budget over it read green on a page whose every later interaction janked. And CLS was never computed: `layout-shift` entries shipped raw, one span per shift, so anything reading one as CLS was three orders of magnitude off the 0.1 threshold.

Both are lifetime metrics now, accumulated in O(1) state and emitted at page hide (which RUM registers itself, on `visibilitychange` and `pagehide` — never `unload`, which would cost the back/forward cache). INP is the worst interaction over the page; CLS is the largest session-windowed shift sum, with both of the spec's window rules. A vital that moves after a tab switch is re-reported, so the last value is authoritative.

Every vital span now carries `browser.value_unit` (`ms`, or `score_x1000` for a layout score, which is unitless and below 1 and so rides the wire scaled).

**Wire rename:** the first-input span's `browser.vital` changes from `"INP"` to `"first-input"` — it was never INP. A dashboard or alert branching on `browser.vital === "INP"` now reads the real page-lifetime metric instead of the first tap.

`RumEnvironment` gains an optional `onPageHide` seam, and `BrowserTracer.vitalSpan` an optional `unit` argument defaulting to `"ms"`; both are additive.

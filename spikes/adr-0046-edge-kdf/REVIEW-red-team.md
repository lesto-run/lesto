# ADR 0046 Phase-0 spike — opus red-team verdict

Delegated per the owner's instruction ("use opus red team to review"). The
red-team independently re-hit the live Worker with `wrangler tail`, cross-checked
hashes against local noble, and re-ran the driver. **Bottom line: the decision
(fall to A-wasm) is correct and survives every correction — but two first-draft
headline numbers were wrong and one was framed on a Free-plan artifact.** All
corrections are folded into `FINDINGS.md`; `driver.mjs` is fixed.

## P1 — A-js "~1.2–1.8 s / ~25×" was NOT reproducible → corrected to ~0.5–0.8 s / ~10–16×
The only A-js variant that completes on Free is `js-async`; red-team reproduced a
tight **778 ms** cpuTime (n=4, cold+warm). The original 1228/1787 ms were n=2
throttle-contended sync outliers. A follow-up conc=1 re-run measured 493/499/536
ms (uncontended floor). Local Node noble = 265 ms (so it wasn't a leaked local
number — local is *faster*). Enrollment corrected 12 s → ~5–8 s. **Decision
unaffected:** even the floor busts R4 and loses ~10–16× to wasm.

## P1 — driver folded fast-failing 503s into the percentiles → fixed
A 503 fails at the edge in ~RTT with no compute, so failures were the *fastest*
samples and **deflated** the reported e2e p95 (old "160/290 ms" were computed over
>50%-failing distributions — a soft false oracle). `driver.mjs` now computes
percentiles **ok-only** and reports `failRate`. Server `perDeriveMs`/`totalMs` are
confirmed frozen at 0 (workerd clock freeze) and correctly discarded — trusting
them would have been a "0 ms derive" false oracle.

## P2 — "A-js can't complete (exceededCpu)" leans on the Free burst-throttle → re-framed
On Workers Paid, A-js-async would complete at ~0.78 s (paid raises the CPU ceiling
to 30 s but does not change per-derive speed or the ~7.8 s enrollment). So the
rejection is re-framed onto the plan-independent CPU gap + R4 enrollment, not the
Free 503.

## CONFIRMED-SOUND (independently reproduced)
- **Equal work / not a cheaper param, no-op, or cache:** worker-wasm =
  worker-js-async = local-noble hash `799f12b9…` at m=19456/t=2/p=1; a cheaper
  m=8/t=1 diverges. An identical 32-byte argon2id tag cannot come from a cheaper
  parametrization; cpuMs≈45 rules out a cache/short-circuit. A genuine oracle.
- **Memory ceiling ~256 MiB > 128 MB:** `/alloc` 12 (228 MiB) ok, 14 (266 MiB)
  `exceededMemory`; page-touch forces commit, no lazy elision; `exceededMemory` is
  a distinct OOM signal from `exceededCpu`. Caveat: throttle-contaminated on hot
  isolates — only the cool-isolate tail outcome disambiguates → paid re-run right.
- **B1 sync fan-out is sequential-in-memory** (peak 1×19 MiB) for the chosen sync
  backend; the 190 MiB stack is async-only. IT1 still justified on CPU/DoS grounds.
- **IT4:** 4 probes / 4 isolates — module-import instantiates; compile/Module from
  bytes both blocked with catchable `CompileError`. No transient contamination
  (the probe catches `CompileError`, so a throttle 503 fails the request rather
  than faking an "ok"). Robust.

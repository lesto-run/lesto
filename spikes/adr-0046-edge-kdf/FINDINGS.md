# ADR 0046 Phase-0 spike — deployed-Worker argon2id benchmark: FINDINGS

**Task:** `L-557c95dd`. **Gate:** ADR 0046's hard Phase-0 gate — benchmark both
argon2id routes on a **deployed** Cloudflare Worker (not miniflare, not Node —
the `b932aa1` lesson) before any facade code, and decide the backend.

**Environment (be explicit — it matters for the caveats):**
- Deployed Worker `lesto-adr0046-kdf-spike` on `*.workers.dev`, compat date
  `2026-06-01`, wrangler 4.101, colo **EWR** (Newark), client ~100 ms RTT.
- Account is **Cloudflare Free**. `limits.cpu_ms` is rejected on Free (code
  100328). This confounds the *sustained-load* dimension (see §Free-plan
  confound) but **not** the per-derive CPU numbers, which are plan-independent.
- Params throughout: **m=19456 KiB (19 MiB), t=2, p=1, 16-byte salt, 32-byte
  tag, argon2id v0x13** — the ADR's pinned point.
- Backends: **A-js** = `@noble/hashes@2.2.0` pure-JS `argon2id` (sync + async);
  **A-wasm** = `@phi-ag/argon2@0.5.24` (MIT), wasm consumed as a **deploy-time
  module import** (`import mod from "@phi-ag/argon2/argon2.wasm"`).
- Timing sources: **`wrangler tail` `cpuTime`/`wallTime`** (authoritative
  server CPU — workerd freezes `Date.now()` during sync compute, so in-isolate
  timers read ~0 and are useless) + **client-side end-to-end** (user-facing
  login latency; the A6 metric). Outcomes (`ok`/`exceededCpu`/`exceededMemory`)
  are workerd's own, from tail.

---

## Headline result

> **Numbers corrected after the opus red-team pass** — see §Measurement rounds &
> variance. The original draft over-stated the A-js penalty (25×) from n=2
> throttle-contended outliers; the honest figure is **~10–16×**. The decision is
> unchanged and robust to the correction. PBKDF2-100k, recovery, and the ok-only
> e2e p95 numbers were also added/recomputed after the review.

| Metric (deployed Worker, `wrangler tail` cpuTime = authoritative) | **A-js** (noble pure-JS) | **A-wasm** (phi-ag) | PBKDF2-100k (incumbent) |
|---|---|---|---|
| CPU / derive (ok samples) | **~0.5–0.8 s** (floor 493, typ. 778, contended ≤1787) | **~40–50 ms** (37–76 ms) | **~25 ms** (22–27 ms) |
| Gap vs A-wasm | **~10–16×** | 1× | ~0.5× |
| Recovery enrollment (10 serialized) | **~5–8 s** (10 × per-derive) | **~0.47 s CPU / ~0.75 s e2e** | — |
| Login e2e p95, **ok-only** (conc=1) | ~0.6 s (503-heavy on free) | **~139 ms** (~42 ms derive + ~97 ms RTT) | ~120 ms |
| Cross-runtime hash byte-identical? | yes (`799f12b9…`) | yes (`799f12b9…`) — matches A-js & local | n/a |
| Bundle add | few KiB minified | 28 KiB raw / 11 KiB gzip (separate wasm module) | 0 |

**A-js is ~10–16× slower per derive on workerd** (≈0.5–0.8 s vs ≈40–50 ms). The
ADR's estimates were **A-js 200–500 ms** (still 1.5–4× too optimistic vs the
uncontended floor — the class of surprise a deployed-Worker gate exists to catch)
and **A-wasm 50–150 ms** (confirmed; measured 37–76 ms). **argon2id-wasm at ~45 ms
is only ~1.6–2× the incumbent PBKDF2-100k (~25 ms)** — near-parity, which
materially narrows the mixed-corpus timing-enumeration residual (ADR R2/M6).

## DECISION (per the ADR's ratified decision procedure)

> "prefer A-js if it clears the p95 budget under combined load with memory
> headroom; fall to A-wasm only if A-js busts the budget; fall to Option C
> (noble-scrypt) only if BOTH argon2 routes fail on workerd."

- **A-js BUSTS** any reasonable interactive login-timeout budget — and the
  rejection rests on **plan-independent** facts, not the Free-plan 503s (which are
  a burst-throttle artifact both reviews flagged): **~0.5–0.8 s of blocking,
  single-threaded CPU per login** (× concurrency — neither backend parallelizes
  CPU on the one JS thread; the sync shape blocks the isolate event loop, the
  async shape holds its ~19 MiB buffer across yields), and a **~5–8 s** recovery
  enrollment — at/over the ADR's R4 "2–5 s" budget even at the uncontended floor.
- **A-wasm CLEARS it**: ~45 ms/derive (ok-only e2e p95 ~139 ms at conc=1),
  enrollment ~0.75 s, with memory headroom (see below).
- **→ Fall to A-wasm. Option C (noble-scrypt) is NOT triggered** — an argon2
  route passes on workerd. (Chief-architect: Option C stays closed — noble-scrypt
  is the same pure-JS memory-hard class the spike just clocked ~10–16× slower.)

This **inverts the ADR's stated default preference (A-js)** — which is precisely
what the hard gate is for. It also re-opens the binary-asset-through-the-publish-
pipeline risk the ADR picked A-js to dodge (0.1.6→0.1.7 saga). See §Implications.

---

## IT4 — workerd wasm code-generation restriction: **CONFIRMED on current workerd**

`/probe/wasm-codegen` on the deployed Worker (compat 2026-06-01):

| Operation | Result |
|---|---|
| `new WebAssembly.Instance(moduleImport, {})` (deploy-time module import) | **ok** — instantiates, has exports |
| `new WebAssembly.Module(bytes)` (compile from bytes at runtime) | **BLOCKED** — `CompileError: WebAssembly.Module(): Wasm code generation disallowed by embedder` |
| `WebAssembly.compile(bytes)` (async compile from bytes) | **BLOCKED** — `CompileError: WebAssembly.compile(): Wasm code generation disallowed by embedder` |

The ADR's "high confidence, verify at spike" claim holds. Both blocks are
**catchable** `CompileError`s (so a base64-inline-and-compile library fails
loudly, not by isolate kill). A-wasm **must** consume wasm as a deploy-time
module import — which `@phi-ag/argon2`'s `.wasm` export does, and which wrangler's
`CompiledWasm` rule bundles with no extra config (no `nodejs_compat` needed).

## Memory ceiling — **~256 MiB, NOT the 128 MB the ADR assumes** (authoritative `exceededMemory`)

Swept N × 19 MiB held simultaneously, two independent ways (raw ArrayBuffers via
`/alloc`; N live wasm `Instance`s via `/derive?hold=1`). Both agree:

| N × 19 MiB | resident | outcome |
|---|---|---|
| 12 | 228 MiB | **ok** |
| 14 | 266 MiB | **exceededMemory** |

Real isolate ceiling ≈ **250 MiB** → concurrent headroom ≈ **13** single-derive
working sets, roughly **double** the ADR's "~6.7× single / ~1.2–1.5× concurrent"
(which is built on 128 MB). **Caveat:** measured on Free/workers.dev; the
*documented* limit is 128 MB, so this discrepancy must be **re-confirmed on the
production plan** before it's banked. Either way, the ADR's semaphore concurrency
**2–3** (38–57 MiB) is safe with wide margin.

## Fan-out OOM (ADR B1) — the magnitude is **wrong for a sync backend** (code-grounded)

The ADR's B1 blocker says `hashRecoveryCodes`' `Promise.all(codes.map(hashPassword))`
allocates "10 × 19 MiB ≈ 190 MiB **simultaneously** → uncatchable OOM on the
ordinary `confirmTotp` happy path." That is true only for an **async/chunked**
derive that holds its buffer across a yield (noble's `argon2idAsync` does). For a
**synchronous** derive (phi-ag wasm `hash()` is sync; noble sync is sync), each
`hashPassword` runs to completion **before** the next allocates, so the fan-out is
**sequential in memory — peak 1 × 19 MiB, not 190 MiB.** Measured: `/derive?hold=1`
(which *forces* N live instances) is the only way I could stack N × 19 MiB with
wasm; a natural sync fan-out cannot. **IT1 (serialize the fan-out) is still worth
doing** — for CPU/throughput fairness vs concurrent logins and to bound the
semaphore — but its **OOM justification does not hold for the chosen A-wasm-sync
backend.** The design's risk model should be restated around CPU + the decoy-DoS,
not a 190 MiB happy-path OOM.

## Free-plan confound (honesty note; the red-team will and should hammer this)

The Free tier throttles sustained/bursty CPU per isolate: A-js hits `exceededCpu`
on ~every derive; **even A-wasm** hit `exceededCpu` on 24 requests under concurrent
bursts **despite each derive being only ~50 ms** — i.e. a free-tier *aggregate/
burst* throttle on one low-traffic isolate, not a per-request cap and not a KDF
property (78 A-wasm derives succeeded at ~50 ms median). Consequence: I could not
get a **clean** sustained-combined-load p95 free of 503 noise. **The decision does
not depend on it** — the ~10–16× per-derive CPU gap is plan-independent and decisive —
but the *clean A6 p95 under the semaphore* and the *memory ceiling* should be
re-run on **Workers Paid** to formally close the gate. That is a **confirm, not
decide** follow-up.

## Measurement rounds & variance (why the A-js number is a range, not a point)

A-js cpuTime on workerd is **contention-sensitive** — the dispersion is Free-plan
throttle/accounting noise, not the algorithm. Three independent rounds, all
`ok`-outcome tail `cpuTime`, all m=19456/t=2/p=1:

| Round | variant | n | cpuTime (ms) |
|---|---|---|---|
| initial | js-sync | 2 | 1228, 1787 (during 11 concurrent throttle-kills) |
| opus red-team | js-async | 4 | 778, 778, 778, 779 (cold+warm, tight) |
| clean re-run | js-async | 3 | 493, 499, 536 (conc=1, least contended) |

The **uncontended floor is ~0.5 s**; typical ~0.78 s; contention inflates to
~1.8 s. Local Node noble = 265–427 ms, so ~0.5 s on edge hardware is the honest
uncontended cost. A-wasm by contrast is tight (37–76 ms across all rounds) — short
derives rarely get throttle-inflated. **Every A-js figure, including the floor,
busts the gate** (≥5 s enrollment, ≥10× wasm, event-loop blocking).

## Review corrections applied (opus red-team + fable chief-architect)

- **Driver bug (fixed).** `driver.mjs` originally folded fast-failing 503s into
  the percentiles; a 503 fails at the edge in ~RTT with no compute, so failures
  were the *fastest* samples and **deflated** the reported e2e p95 (the old
  "160/290 ms" were computed over >50%-failing distributions — a soft false
  oracle). Now percentiles are **ok-only** with `failRate` reported alongside.
- **A-js penalty corrected** 25× → **~10–16×**, "1.2–1.8 s" → **~0.5–0.8 s**,
  enrollment "12 s" → **~5–8 s** (per the rounds table).
- **"A-js busts" re-framed** off the Free `exceededCpu` (a burst-throttle; A-js
  *async* completes at ~0.78 s, and paid removes the throttle) and onto the
  plan-independent **CPU gap + R4 enrollment** — both reviews' explicit advice.
- **Confirmed sound by the red-team** (independently reproduced): equal-work hash
  identity (a cheaper param diverges; cpuMs≈45 rules out a cache/short-circuit),
  the ~256 MiB ceiling with `exceededMemory` as the distinct OOM signal, the B1
  sync-fan-out restatement, and IT4 (4 probes / 4 isolates, no transient).

## Implications for the ship path (for the chief-architect call)

1. **A-wasm re-opens the binary-asset pipeline risk** the ADR chose A-js to avoid.
   IT3 wants a **vendored first-party** wasm build (from the CC0/Apache-2.0
   reference) over a third-party npm dep. This sandbox has **no emscripten** (only
   `clang`), so I used `@phi-ag/argon2` (MIT, Workers-targeted, module-import wasm)
   as the **measurement proxy**. The *ship* decision must still choose: vendor
   first-party (needs a wasm toolchain + provenance record) vs pin `@phi-ag/argon2`
   (supply-chain actor in the most security-sensitive package) — and thread a
   `.wasm` through tsup + `rewriteManifestForPublish` + wrangler/Vite consumers.
2. The **two-stage rollout, derive semaphore, decoy-DoS control, and `describeHashCost`
   argon2id arm** are unaffected by js-vs-wasm and proceed as ADR'd (with B1's OOM
   rationale restated per above).

## Reproduce

`spikes/adr-0046-edge-kdf/` (standalone, not in the @lesto workspace):
`npm i` → `npx wrangler deploy` → `node driver.mjs <url> load "/derive?backend=wasm&count=1" 2 30`
and `… combined wasm 4 40`; `curl <url>/probe/wasm-codegen`; sweep
`/alloc?count=N` and `/derive?backend=wasm&hold=1&count=N`. Worker deleted after
the spike (`wrangler delete`).

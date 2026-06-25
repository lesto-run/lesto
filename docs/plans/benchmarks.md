# Cross-framework benchmarks — proving the perf claim, honestly

**Origin:** "this framework needs to be the fastest on the market — add benchmark
tests against other JS frameworks." Perf is part of the Lesto pitch, so the claim
needs reproducible numbers behind it. Lesto already had `@lesto/bench` (a
self-vs-self trend harness); what was missing is a _cross-framework_ comparison.

**The headline tension, stated up front:** a benchmark engineered to win is a
reputational liability the day someone re-runs it. `@lesto/bench`'s own README is
scrupulous about noise ("never compare across machines", "tens of percent run to
run"). This work keeps that ethos: a defensible suite that shows where Lesto
genuinely stands beats a rigged headline. Lesto's actual wedge is _agent-native /
batteries-included_, not "fastest" — so the credible story is "competitive on raw
throughput, with the integration nobody else has," not a doctored bar chart.

## The bar (non-negotiable)

- TypeScript / ESM / Bun; `oxlint` + `oxfmt` clean on any `@lesto/*` code touched.
- The benchmarks live in a top-level `benchmarks/` dir that is **deliberately not**
  an `@lesto/*` package, so it stays out of the publish + 100%-coverage gates and
  no competitor dep ever ships with Lesto. Its own pure logic is still unit-tested
  (`bun test`), just not gated at 100%.
- `@lesto/bench` is **not modified** — the cross-framework code _consumes_ its
  measurement core (`runBench`, percentile math) rather than polluting the careful
  self-trend package.
- Every published number cites its version matrix + hardware (`benchmarks/README.md`).

## Two suites, two honest answers

| Suite | Measures | Runs | Output |
| --- | --- | --- | --- |
| `compare/` (in-process) | one code path — SSR render, route match — vs the libs Lesto builds on | anywhere (`bun`) | `COMPARISON.md` |
| `driver/` (real server) | end-to-end request throughput over a real socket | CI / local (binds ports) | `RESULTS.md` |

The split matters: the in-process suite isolates **render/route-match cost**; the
real-server suite measures **HTTP-layer throughput**. Conflating them is how
benchmarks lie.

## The honesty charter (enforced, not promised)

1. **Identical work** — every app emits byte-identical bodies (`workloads.md`); the
   driver re-verifies parity against each live server before recording a number.
2. **Same machine, same run** — never compared across machines or runs.
3. **Median of N**, after warmup — never the best run.
4. **Production mode, pinned versions.**
5. **Lesto doesn't cheat either** — no response caching, no hand-rolled HTTP.

## Methodology notes / fairness calls

- **`/ssr` on the server tier** (lesto/hono/fastify/express/elysia) delivers a
  server-built HTML page (the contract document). That makes it a clean HTTP-layer
  comparison; the **render engine** is compared separately in `compare/`. This is
  the call that keeps Lesto from being unfairly penalized for doing real React SSR
  while a bare server framework concatenates a string — and from unfairly winning.
- **Meta-framework `/ssr`** uses each framework's native SSR; compare within the
  meta tier. `/json` + `/plaintext` are comparable across all tiers.
- **In-process SSR** measures Lesto's representative `.page` path (a React
  component through `reactServerRenderer`) AND, transparently, the validated
  registry-tree path (`renderPage`) so its validation cost is visible, not hidden.

## Lessons folded in from prior art (Platformatic SSR benchmarks)

Two posts the owner pointed to — the [SSR framework benchmark](https://blog.platformatic.dev/react-ssr-framework-benchmark-tanstack-start-react-router-nextjs)
and its [corrected-results follow-up](https://blog.platformatic.dev/ssr-framework-benchmarks-v2-corrected-results) —
are the cautionary tale this suite is built around:

- **Compression parity.** Their first cut was wrong because one framework gzipped
  and another didn't → incomparable wire bytes and req/s. **Now enforced:** the
  driver asserts `Content-Encoding` parity (uncompressed) alongside body parity.
- **Success rate is a first-class metric.** Their Next.js "result" dropped ~40% of
  requests at 1k req/s — a non-result dressed as throughput. **Now measured:** the
  driver parses success rate (oha `successRate`; autocannon 2xx/attempts) and flags
  any rank posted at <100% success with ⚠️.
- **Realistic workload > hello-world.** Their CardMarket e-commerce app (full SSR,
  1–5 ms DB latency, no caching) is far more credible than plaintext/JSON. **Now
  shipped** as the `/realistic` workload (see the 2026-06-24 update below) — a 24-card
  catalog page re-rendered per request behind a simulated 1–5 ms DB round-trip with no
  caching, alongside the simpler TechEmpower set.

## What shipped this session

- `benchmarks/compare/` — in-process, **runs today**, `bun test compare` green:
  - **SSR render** (React vs Preact vs Lesto's validated `renderPage` registry path;
    no bare-`lesto` row — see findings for why that would be a tautology).
  - **Route match** (Lesto `RouteTable` vs `find-my-way`), with a parity test
    asserting both resolve every request to the same hit/miss.
  - **Request dispatch** (`lesto-bare` vs Hono/Elysia/Fastify, each framework's
    socket-less dispatch) — loud ⚠️ that the paths aren't identical work; no
    secure-on `lesto` row (in-process it only measures rate-limit 429s).
  - Competitor libs install into an **isolated `benchmarks/node_modules`** (dynamic
    import + graceful skip), so the root `bun.lock` is untouched.
- `benchmarks/driver/` — real-server orchestrator + **pure, unit-tested** core
  (parse oha/autocannon → req/s + p99 + **success rate**, median-run selection, rank;
  `bun test driver` green). Live **body + Content-Type + compression** parity check
  before recording. **Run with `bun`, not node** (it imports TS). Default generator =
  pinned `autocannon`.
- `benchmarks/apps/` — server apps for **Lesto (+ `lesto-bare`), Hono, Fastify,
  Express, Elysia** to one byte-for-byte contract (`_contract.mjs`); the Lesto app
  serves **uncompressed** with access logging off (fair vs the bare competitors) and
  is verified serving exact bytes.
- `workloads.md` contract (single-line exact bodies), `README.md` methodology +
  matrix + findings, `.github/workflows/benchmarks.yml` (manual + weekly, never a
  blocking gate; dispatch inputs through env, not shell-interpolated).

### Honest findings so far (illustrative, one machine, in-process)

Read the ranking and the gap, not absolutes — these are volatile micro-benchmarks
(close contenders swap run to run), so no hard multipliers are quoted.

- **SSR render:** Preact's renderer is ~10× React (a known property). Lesto's
  validated `renderPage` registry path costs a modest, transparent margin over the
  raw renderer it sits on. No separate "lesto" render row exists: Lesto's
  plain-component renderer IS `react-dom/server`, so it renders at React's speed by
  construction (an earlier "lesto ≈ React, no overhead" finding was retracted — it
  was timing the same function twice, a tautology).
- **Route match:** Lesto `RouteTable` and `find-my-way` are in the same ballpark
  (lead varies run to run); not strictly equal work (Lesto decodes every param,
  find-my-way decodes lazily), so read it as "close," not a podium.
- **Request dispatch:** `lesto-bare` (secure stack OFF) is at the front with Elysia
  and Hono — Lesto's core dispatch is genuinely quick. The earlier "default `lesto`
  ~14× slower → rate limiter is the #1 lever" finding was **an artifact and is
  retracted**: in-process every `app.handle()` shares one rate-limit bucket and
  drains it into 429s, so it measured the rejection path, not request handling. The
  default secure stack's per-request cost is real but can only be measured fairly by
  the real-server suite (distinct clients per connection) — see remaining work.
- **None of this proves "fastest."** The in-process dispatch caveat (not
  apples-to-apples) means it can't; the credible verdict is the real-server suite.

## Update 2026-06-24 — saturation curve + statistical rigor shipped (task `L-7847fc40`)

The driver no longer hits a single `(connections, duration)` point. It now **sweeps
a connection ladder** (`--connections 16,32,64,128,256`) and reports the real
headline metric — **max sustainable req/s**, the highest throughput a framework
holds at ≥99.9% success (the Platformatic 1k-rps framing), with `↑` when the curve
is still climbing at the top rung and `⚠️ none` when a framework drops requests at
every rung. Added statistical rigor, all in the pure (unit-tested) `parse.ts`:
N-trial **mean/stddev/coefficient-of-variation** with a **stability gate** that
flags any rung whose CV exceeds `--cv-threshold` (default 5%); **seeded-random run
order** (app + trial, `--seed`, stamped) to defeat thermal/ordering bias; the full
latency spread **p50/p75/p90/p99/p99.9/max**; and **coordinated-omission-aware**
constant-rate load via `--rate` (autocannon `--overallRate` / oha `-q`). `RESULTS.md`
now renders a per-workload max-sustainable ranking plus the per-framework saturation
curve. `bun test driver` green (48 tests). Still CI/local-only (binds ports); the
**first published run** below remains the un-done piece.

## Update 2026-06-24 — realistic-page workload shipped (task `L-2d2c4b86`)

Added `/realistic` as a fourth workload (`workloads.md`): a credible e-commerce
catalog page (a 24-card product grid in a full `<head>`/header/footer document,
~5 KB) **re-rendered on every request** (no response caching, mirroring a
personalized page) behind a **simulated 1–5 ms DB round-trip**. The page body and
the latency model both live in `apps/_contract.mjs` (`realisticBody()`,
`realisticProduct/Card`, `simulateDbLatency()`) so all apps incur the identical I/O
wait and emit byte-identical bytes — the comparison is then framework overhead +
async handling under real I/O, the gap the hello-world routes hide. Wired into all
five server-tier apps (lesto/hono/fastify/express/elysia), the driver
(`WORKLOADS` + the parity `CONTRACT`), and the scaffold READMEs. New
`driver/contract.test.ts` pins the body's byte-stability/structure AND dispatches
`/realistic` through the **real Lesto pipeline in-process** (no socket). Deliberately
NOT dogfooding the examples gallery — byte-identity across five frameworks is far
simpler from a fixed contract function. `bun test` green (74 tests). Competitor apps'
live parity is gated by the driver at run time (CI/local — can't boot here).

## Update 2026-06-25 — edge/Workers tier (task `L-ca067176`)

Added Lesto's **primary target — Cloudflare Workers** — to the suite. `apps/lesto`
now has an edge entry (`worker.ts` via `@lesto/cloudflare`'s `toFetchHandler`)
fronting the SAME four routes as the node server: the routes were extracted to a
shared, edge-safe `app.ts` (imports only `@lesto/web` — no `node:http`/`openSqlite`),
so one dispatch powers both transports. **Verified live** (`wrangler deploy`): the
Worker builds, deploys, and serves byte-identical bytes on all four routes
(`lesto-bench-edge.<account>.workers.dev`); footprint **636 KiB / 121.6 KiB gzip**,
**16 ms** startup. The local-workerd load path is wired as the `lesto-workers` app
(`start-edge.mjs` → `wrangler dev --local`, honoring the driver's PORT), marked
`scaffold` — the deploy is proven, but booting workerd as a benchmark target is
unvalidated in a sandbox that blocks server starts.

**Honesty line held:** no edge req/s number. Hitting a deployed Worker over the
internet measures the network + CF's multi-tenant edge, not Lesto, and breaks the
"same machine, never cross-machine" charter. The only honest edge throughput is
local workerd (same machine, same load path) — deferred to a real-machine run, like
the rest of the driver suite. `bun test` green (76).

## Remaining work (tracked as Studio tasks)

- **⭐ Measure + investigate the default secure-stack hot-path cost** on the
  real-server suite (`lesto` vs `lesto-bare`, now both in the matrix): the default
  per-client rate limiter does a store op per request. Quantify it over a socket
  (in-process can't — shared bucket → 429s), then explore an in-memory/edge-KV
  fast-path limiter. Likely the biggest available throughput win.
- **Meta-framework apps** — Next.js, SvelteKit, Astro, React Router 7. Each is a
  scaffold (`apps/<fw>/README.md` has the exact routes + build/start, already wired
  in `driver/apps.ts` as `status: "scaffold"`). Flip to `"ready"` when built.
- **First published run** — execute `driver/run.ts` on a quiet, pinned machine,
  fill the version/hardware matrix, and link results from the marketing site
  (`www/`) per the DevRel GTM program. THIS is what turns the suite into an actual
  published cross-framework eval — until then we have the harness + in-process
  signal, not the headline.
- ~~**Realistic-page workload**~~ — ✅ DONE (task `L-2d2c4b86`, the `/realistic`
  workload; see the 2026-06-24 update above).
- **Optional:** a `.page`-pipeline SSR workload (full Lesto streaming document) as a
  separate, clearly-labeled real-server row vs the meta-framework tier.

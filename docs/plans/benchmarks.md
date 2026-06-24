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
  1–5 ms DB latency, no caching) is far more credible than plaintext/JSON. Our
  current workloads are the simpler TechEmpower set; a realistic-page workload is
  the next upgrade (see remaining work) and dovetails with the examples gallery.

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
- **Realistic-page workload** — a CardMarket-style SSR page (per the Platformatic
  prior art) instead of plaintext/JSON, ideally dogfooding the examples gallery.
- **Optional:** a `.page`-pipeline SSR workload (full Lesto streaming document) as a
  separate, clearly-labeled real-server row vs the meta-framework tier.

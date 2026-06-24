# Lesto benchmarks — cross-framework

Two suites, because "how fast is Lesto?" has two honest answers and they need
different rigs:

| Suite                       | What it measures                                                                                                                                   | Where it runs                                                                         | Output          |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | --------------- |
| **`compare/`** (in-process) | A single code path — SSR render, route match — head-to-head with the libraries Lesto builds on (React, Preact, find-my-way). No socket, no server. | Anywhere, instantly (`bun`).                                                          | `COMPARISON.md` |
| **`driver/`** (real server) | End-to-end request throughput: each framework serves the identical workload from its own pinned app, hit by a load generator over a real socket.   | CI or locally (needs to start servers — **not** a sandbox that blocks server starts). | `RESULTS.md`    |

> **This is not `@lesto/bench`.** That package is Lesto's self-vs-self trend
> harness (does this commit regress the last). This directory is the
> _cross-framework_ comparison. It reuses `@lesto/bench`'s measurement core
> (`runBench`, the percentile math) but is **not** an `@lesto/*` package — so it
> stays out of the publish + 100%-coverage gates, and no competitor dependency
> ever ships with Lesto.

## The honesty charter

Benchmarks are a reputational liability the moment they're rigged. The rules,
enforced by the harness and the parity check, not by good intentions:

1. **Identical work.** Every app emits **byte-identical, uncompressed** bodies
   (`workloads.md`); the driver re-verifies body **and `Content-Encoding`** parity
   against each live server before recording a number, and fails the app loudly on
   any mismatch. (Mismatched compression is exactly the bug that invalidated the
   Platformatic SSR benchmark's first cut — gzip on one app, none on another, makes
   the wire bytes and the req/s incomparable.)
2. **Success rate first.** A huge req/s at <100% success is a framework dropping
   requests under load, not sustained throughput — the report flags it ⚠️ and you
   read it before the rank. Then read **p99** (tail latency), the number users feel.
3. **Same machine, same run.** Numbers are compared only within one invocation —
   never across machines, never across runs. (In-process noise alone runs tens of
   percent run to run.)
4. **Median, not best.** The driver records the median of N repetitions after a
   warmup. The best run flatters; the median is what the framework sustains.
5. **Production mode, pinned versions.** Apps run their production build with
   `NODE_ENV=production`. Each pins its framework version; **every published
   number must cite the version matrix and hardware below.**
6. **Lesto doesn't get to cheat either.** No response caching, no hand-rolled
   HTTP, nothing Lesto wouldn't do for a real user. Where Lesto's default pipeline
   does MORE than a competitor (its default-on rate limiter), the comparison shows
   that explicitly (e.g. `lesto` vs `lesto-bare`) rather than quietly disabling it.

If a result flatters Lesto and you can't explain _why_ from the methodology, it's
a bug in the benchmark, not a win.

## What the in-process numbers say so far

Run `compare/run.ts` to regenerate `COMPARISON.md`; **read the ranking and the gap,
not the absolutes** — these are volatile micro-benchmarks and close contenders can
swap places run to run, so this section deliberately avoids hard multipliers. The
qualitative picture that holds across runs:

- **SSR render:** Preact's renderer is in a class of its own (≈10× React — a known
  property of `preact-render-to-string`). Lesto's validated `renderPage` registry
  path costs a modest, transparent margin over the raw renderer it sits on. There's
  no separate "lesto" render row: Lesto's plain-component renderer _is_
  `react-dom/server`, so it renders at React's speed by construction (timing it would
  just re-time the `react` row).
- **Route match:** Lesto's compiled-RegExp `RouteTable` and `find-my-way`'s radix
  tree are in the same ballpark (lead varies run to run). Not strictly equal work —
  Lesto URL-decodes every param, find-my-way decodes lazily — so read it as "close,"
  not a podium.
- **Request dispatch (NOT apples-to-apples — see the ⚠️ in the report):**
  `lesto-bare` (Lesto routing/dispatch with the secure stack off) is at the front of
  the pack with Elysia and Hono — Lesto's core dispatch is genuinely quick. The cost
  of the **default secure stack** (a per-request rate-limit store op) is real but
  **cannot be measured in-process** — every `app.handle()` shares one rate-limit
  bucket and drains it into 429s — so it's deferred to the real-server suite.

None of this proves "fastest on the market," and the in-process dispatch caveat
means it can't. The credible verdict needs the real-server suite below.

## Run it

### In-process comparison (anywhere)

```sh
cd benchmarks && bun install   # once: competitor libs (hono/elysia/fastify/find-my-way) into an isolated node_modules
bun run benchmarks/compare/run.ts
bun run benchmarks/compare/run.ts --iterations 5000 --warmup 500 --rows 100
```

### Real-server load test (CI / local; needs to bind ports)

Run the driver with **bun** (it's TypeScript and boots TS apps); `node` cannot.

```sh
bun benchmarks/driver/run.ts
bun benchmarks/driver/run.ts --duration 10 --connections 50 --runs 3
bun benchmarks/driver/run.ts --only lesto,lesto-bare,hono,fastify
bun benchmarks/driver/run.ts --generator oha      # if oha is installed (default: pinned autocannon)
```

The driver installs/builds each app once, boots it on a fresh port, verifies
parity, warms it, runs the load generator `--runs` times per workload, keeps the
median, and writes `RESULTS.md`.

## Framework matrix

| Tier   | Framework              | Status      | App              |
| ------ | ---------------------- | ----------- | ---------------- |
| Server | **Lesto**              | ✅ ready    | `apps/lesto`     |
| Server | Hono                   | ✅ ready    | `apps/hono`      |
| Server | Fastify                | ✅ ready    | `apps/fastify`   |
| Server | Express                | ✅ ready    | `apps/express`   |
| Server | Elysia                 | ✅ ready    | `apps/elysia`    |
| Meta   | Next.js                | 🚧 scaffold | `apps/next`      |
| Meta   | SvelteKit              | 🚧 scaffold | `apps/sveltekit` |
| Meta   | Astro                  | 🚧 scaffold | `apps/astro`     |
| Meta   | React Router 7 (Remix) | 🚧 scaffold | `apps/remix`     |

Server-tier apps deliver a server-built HTML page on `/ssr` (a clean HTTP-layer
comparison — the render engine is compared separately in `compare/`).
Meta-framework apps use their **native SSR** on `/ssr`; compare those within the
meta tier. `/json` and `/plaintext` are directly comparable across all tiers.

### Versions + hardware (fill in per published run)

```
date:        <UTC>
machine:     <CPU, cores, RAM, OS>
node:        <version>      bun: <version>
generator:   <autocannon|oha> <version>   (-c <conn>, -d <dur>s, <runs> runs, median)
lesto:       <version>
hono:        <version>      fastify: <version>   express: <version>   elysia: <version>
next:        <version>      sveltekit: <version> astro: <version>     react-router: <version>
```

## Layout

```
benchmarks/
  compare/        in-process render + router + dispatch comparison (runs anywhere)
    rank.ts       pure ranking + markdown renderer  (+ .test.ts)
    ssr.ts        Lesto / React / Preact render samples  (+ .test.ts)
    router.ts     Lesto RouteTable vs find-my-way  (+ .test.ts)
    dispatch.ts   Lesto vs Hono/Elysia/Fastify in-process dispatch  (+ .test.ts)
    run.ts        bin → COMPARISON.md
  driver/         real-server load harness (CI / local)
    parse.ts      pure: parse oha/autocannon JSON (req/s, p99, success), median, rank  (+ .test.ts)
    apps.ts       the framework matrix (data)
    run.ts        orchestrator: prepare → boot → parity(+compression) → load → median
  node_modules/   competitor libs (hono/elysia/fastify/find-my-way) — isolated, gitignored
  apps/
    _contract.mjs the canonical workload bodies (single source of truth)
    lesto/ hono/ fastify/ express/ elysia/    ready apps
    next/ sveltekit/ astro/ remix/            scaffolds (READMEs)
  workloads.md    the byte-for-byte response contract
```

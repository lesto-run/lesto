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
   requests under load, not sustained throughput — so the headline is **max
   sustainable req/s** (the best throughput held at ≥99.9% success), the report
   flags any sub-100%-success rung ⚠️, and you read it before the rank. Then read
   **p99/p99.9** (tail latency), the number users feel.
3. **Same machine, same run.** Numbers are compared only within one invocation —
   never across machines, never across runs. (In-process noise alone runs tens of
   percent run to run.)
4. **Median, not best — and the spread is shown.** The driver records the median of
   N repetitions after a warmup, in a seeded-random order, and reports the
   run-to-run **coefficient of variation** per rung. The best run flatters; the
   median is what the framework sustains; a rung whose CV exceeds the gate (default
   5%) is flagged ⚠️ as too noisy to trust rather than quietly published.
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
bun benchmarks/driver/run.ts --duration 10 --connections 16,64,256 --runs 5   # sweep a connection ladder
bun benchmarks/driver/run.ts --only lesto,lesto-bare,hono,fastify
bun benchmarks/driver/run.ts --rate 50000          # constant-rate (coordinated-omission-aware) load
bun benchmarks/driver/run.ts --generator oha --seed 1234   # oha if installed (default: pinned autocannon)
```

The driver installs/builds each app once, boots it on a fresh port, verifies
parity, warms it, then **sweeps a ladder of connection levels** (`--connections`,
default `16,32,64,128,256`), running the load generator `--runs` times per
(workload, rung). The headline per workload is **max sustainable req/s** — the
highest throughput a framework holds at ≥99.9% success, not the biggest number it
posts while shedding load (the Platformatic 1k-rps framing). It keeps the median of
each rung and writes the full saturation curve to `RESULTS.md`.

**Statistical rigor.** Trials run in a **seeded-random order** (`--seed`; stamped
into the report) so no rung is systematically measured cold-first or hot-last; each
rung reports its **coefficient of variation** across trials and is flagged ⚠️ when
the CV exceeds the stability gate (`--cv-threshold`, default 5%) — a noisy,
non-reproducible number. Latency is reported across the full spread
(p50/p75/p90/p99/p99.9/max). `--rate <req/s>` switches to constant-rate open-loop
load (autocannon `--overallRate` / oha `-q`), which is **coordinated-omission-aware**
— latency is measured against the intended send schedule, not whenever a busy
server freed a connection (autocannon additionally corrects its histogram).

Every `RESULTS.md` ends with an auto-stamped **Run provenance** block (git SHA, real
CPU/RAM/OS, resolved tool + framework versions, and the observed
governor/turbo/core-pinning) — and a loud ⚠️ if the host wasn't publication-grade.
**Don't hand-publish raw `run.ts` output; use the runner below.**

## Reproduce it yourself

Publication-grade numbers come from a **controlled host**, not a laptop or a shared
CI runner. The runner pins cores and stamps the conditions; it never silently
changes your CPU governor (that's a documented root step).

**TL;DR** — on the canonical rig:

```sh
cd benchmarks && bun install            # once
bun benchmarks/driver/reproduce.ts --strict --duration 30 --connections 100 --runs 5
```

`--strict` refuses to produce numbers unless the host is canonical (Linux,
performance governor, turbo off, taskset present, ≥4 cores). Drop `--strict` for an
indicative dev run (it'll be stamped NON-CANONICAL).

**The canonical rig.** A dedicated/bare-metal box or a dedicated cloud instance —
**not** a shared VM (oversubscription = noise) and **not** Docker (virtualization
adds scheduler noise and can't control clocks). Document the exact instance type
alongside any published result.

**Host setup (one-time, root — exact commands; the runner verifies, never sets them):**

```sh
# Performance governor on every core
sudo cpupower frequency-set -g performance        # pkg: linux-tools-common / cpupower
# Disable turbo/boost (pick the one your CPU exposes)
echo 1 | sudo tee /sys/devices/system/cpu/intel_pstate/no_turbo      # Intel
echo 0 | sudo tee /sys/devices/system/cpu/cpufreq/boost              # AMD / acpi-cpufreq
# (Advanced, max isolation) reserve cores at boot via the kernel cmdline, then reboot:
#   isolcpus=2-5 nohz_full=2-5 rcu_nocbs=2-5    (grub GRUB_CMDLINE_LINUX)
```

The runner then puts the server and the load generator on **disjoint** core sets
so they never contend. Defaults scale with core count: on a ≥6-core box, server
`2,3` and generator `4,5` (cores `0,1` left for the OS); on a 4–5-core box, server
`2` and generator `3`. Override either with `--server-cpus` / `--gen-cpus`.

**Docker path (lower fidelity).** Pins the software stack only — no governor/turbo/
isolation control, so results are stamped NON-CANONICAL. Use it to re-run the
methodology on your own hardware without fighting installs:

```sh
docker build -f benchmarks/Dockerfile -t lesto-bench .   # build context = repo root
docker run --rm lesto-bench                               # in-process comparison
```

**Before publishing any comparison:** (1) generate charts from `RESULTS.md`,
(2) keep the prior run for a version-over-version trend, (3) attach the raw
per-run output, and (4) get an **external methodology review** (a competing-
framework maintainer or the community) — see task `L-97e1bca5`.

## Framework matrix

| Tier   | Framework              | Status      | App                                                          |
| ------ | ---------------------- | ----------- | ------------------------------------------------------------ |
| Server | **Lesto**              | ✅ ready    | `apps/lesto`                                                 |
| Server | **Lesto** (bare)       | ✅ ready    | `apps/lesto` (`LESTO_BENCH_SECURE=false` — secure stack off) |
| Server | Hono                   | ✅ ready    | `apps/hono`                                                  |
| Server | Fastify                | ✅ ready    | `apps/fastify`                                               |
| Server | Express                | ✅ ready    | `apps/express`                                               |
| Server | Elysia                 | ✅ ready    | `apps/elysia`                                                |
| Meta   | Next.js                | 🚧 scaffold | `apps/next`                                                  |
| Meta   | SvelteKit              | 🚧 scaffold | `apps/sveltekit`                                             |
| Meta   | Astro                  | 🚧 scaffold | `apps/astro`                                                 |
| Meta   | React Router 7 (Remix) | 🚧 scaffold | `apps/remix`                                                 |

Server-tier apps deliver a server-built HTML page on `/ssr` and `/realistic` (a
clean HTTP-layer comparison — the render engine is compared separately in
`compare/`). Meta-framework apps use their **native SSR** for those routes; compare
those within the meta tier. `/json` and `/plaintext` are directly comparable across
all tiers. **`/realistic`** is the credible workload — a 24-card catalog page
re-rendered per request behind a simulated 1–5 ms DB round-trip with no caching (see
`workloads.md`); the hello-world routes flatter raw routers and hide real fullstack
cost.

### Versions + hardware

Auto-stamped — every `RESULTS.md` ends with a **Run provenance** table (commit, CPU,
RAM, OS, Bun/Node, generator + resolved framework versions, and the observed
governor/turbo/core-pinning). No hand-filled matrix to rot; the report records what
actually ran. A run on a non-canonical host is flagged ⚠️ and must not be published.

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
    parse.ts      pure: parse oha/autocannon JSON (req/s, p50–max spread, success); stats
                  (mean/stddev/CV + stability gate); saturation (max sustainable req/s);
                  seeded run-order shuffle; median; rank/render  (+ .test.ts)
    env.ts        pure: render run-provenance block + host-readiness probe  (+ .test.ts)
    apps.ts       the framework matrix (data)
    run.ts        orchestrator: prepare → boot → parity(+ct+compression) → warm → sweep the
                  connection ladder in seeded-random order → median+CV → saturation → stamp
    reproduce.ts  one-command runner: host checks → pin cores (taskset) → run → stamp
  Dockerfile      software-pin image (lower fidelity; stamped non-canonical)
  node_modules/   competitor libs (hono/elysia/fastify/find-my-way/autocannon) — isolated, gitignored
  apps/
    _contract.mjs the canonical workload bodies (single source of truth)
    lesto/ hono/ fastify/ express/ elysia/    ready apps
    next/ sveltekit/ astro/ remix/            scaffolds (READMEs)
  workloads.md    the byte-for-byte response contract
```

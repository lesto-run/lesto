# @lesto/bench

The benchmark harness. Perf is central to the Lesto pitch, so the claims need
numbers behind them — this package measures three things and records the results
locally so trends are visible across runs on the same machine:

- **HTTP req/s + p99** — the in-process `Request → Response` round-trip cost
  (construct a `Request`, run a bare handler, read the body back). This is a
  floor on the web-API round-trip the runtime pays per request, **not** a
  measurement of Lesto's router/middleware — Lesto's request handler is not a
  plain `(Request) => Response`, runs in-process with no socket, and is not
  benchmarked here.
- **Queue claims/sec** — a real `@lesto/queue` on an in-memory SQLite database,
  claimed under _N_ concurrent claims on one event loop (the hot path).
- **SSR render throughput** — the genuine `renderPage` → `renderPageMarkup`
  path, rendering a representative component tree to a string in a tight loop.

```sh
bun run --filter @lesto/bench bench
bun run --filter @lesto/bench bench -- --iterations 1000 --concurrency 8 --ref "$(git rev-parse --short HEAD)"
```

> **These are volatile in-process micro-benchmarks.** Measured self-vs-self
> noise routinely runs tens of percent run to run, so the absolute numbers are a
> rough signal at best — read the trend, and never compare across machines.

Results are written to two artifacts beside this package:

- `RESULTS.md` — the human report, with trend columns (Δ req/s, Δ p99) against
  the last recorded run. The committed copy is **illustrative** — a single local
  run, regenerated whenever you run `bench`.
- `results.json` — the machine baseline the next run diffs against. **Not
  tracked** (gitignored): it is one machine's one run, so committing it would
  make every other run diff against a stranger and report spurious regressions.

A run that regresses a workload beyond the threshold (±5% by default, worse-vote
wins between throughput and p99) is reported **informationally**. Because the
noise floor is well above ±5%, the gate is **off by default**; pass `--gate`
(alias `--strict`) to make a recorded regression exit non-zero for CI.

## Design

The package separates a **pure, fully-tested measurement core** from the thin
glue that drives the real subsystems:

- `stats.ts` — percentile/p99 math and req/s aggregation.
- `runner.ts` — the load loop over an **injected** `SampleSource` + clock, so the
  whole loop is unit-tested with fakes (no real server, no real wall clock).
- `compare.ts` — the regression compare against a recorded baseline.
- `report.ts` — the markdown + JSON renderers.
- `workloads.ts` — the three real `SampleSource`s (HTTP, queue, SSR).
- `report-run.ts` — the covered orchestration; the bin injects the filesystem.
- `bin.ts` — pure wiring (argv, disk, `console.log`); the only module outside the
  100%-coverage gate, mirroring `@lesto/cli`'s `bin.ts`.

Private and unpublished.

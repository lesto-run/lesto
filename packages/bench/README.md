# @lesto/bench

The benchmark harness. Perf is central to the Lesto pitch, so the claims need
numbers behind them — this package measures three things and records the results
to tracked files so trends are visible across runs:

- **HTTP req/s + p99** — a Lesto request handler measured against a bare
  baseline handler, so the number is the framework's own overhead, not the
  machine's raw ceiling.
- **Queue claims/sec** — a real `@lesto/queue` on an in-memory SQLite database,
  claimed under _N_ concurrent workers (the hot path workers contend on).
- **SSR render throughput** — the genuine `renderPage` → `renderPageMarkup`
  path, rendering a representative component tree to a string in a tight loop.

```sh
bun run --filter @lesto/bench bench
bun run --filter @lesto/bench bench -- --iterations 1000 --concurrency 8 --ref "$(git rev-parse --short HEAD)"
```

Results are written to two tracked artifacts beside this package:

- `RESULTS.md` — the human report, with trend columns (Δ req/s, Δ p99) against
  the last recorded run.
- `results.json` — the machine baseline the next run diffs against.

A run that regresses a workload beyond the threshold (±5% by default, worse-vote
wins between throughput and p99) exits non-zero, so the harness can gate CI.

## Design

The package separates a **pure, fully-tested measurement core** from the thin
glue that drives the real subsystems:

- `stats.ts` — percentile/p99 math, the latency histogram, req/s aggregation.
- `runner.ts` — the load loop over an **injected** `SampleSource` + clock, so the
  whole loop is unit-tested with fakes (no real server, no real wall clock).
- `compare.ts` — the regression compare against a recorded baseline.
- `report.ts` — the markdown + JSON renderers.
- `workloads.ts` — the three real `SampleSource`s (HTTP, queue, SSR).
- `report-run.ts` — the covered orchestration; the bin injects the filesystem.
- `bin.ts` — pure wiring (argv, disk, `console.log`); the only module outside the
  100%-coverage gate, mirroring `@lesto/cli`'s `bin.ts`.

Private and unpublished.

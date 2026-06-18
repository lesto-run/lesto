/**
 * @lesto/bench — the benchmark harness.
 *
 * Perf is central to the Lesto pitch, so the claims need numbers behind them.
 * This package measures three things — an in-process HTTP `Request→Response`
 * round-trip (req/s + p99), queue claims/sec under concurrent claims, and SSR
 * render-path throughput — and records the results to a local report so trends
 * are visible across runs on the same machine.
 *
 *   bun run --filter @lesto/bench bench
 *
 * The design separates a PURE measurement core (percentile math, the load loop
 * over an injected sample source, the regression compare, the report renderer —
 * all unit-tested to 100%) from the thin glue that drives the real subsystems.
 * These are volatile in-process micro-benchmarks: read the trend, not absolutes.
 *
 *   import { runBench, summarize, compareRuns, renderMarkdown } from "@lesto/bench";
 *
 *   const result = await runBench(mySampleSource, { name: "x", iterations: 1000 });
 *   console.log(result.stats.p99);
 */

export { runReport } from "./report-run";
export type { ReportArtifacts, ReportIo, ReportOptions } from "./report-run";

export { runBench } from "./runner";
export type { MonotonicClock, RunOptions, RunResult, SampleSource } from "./runner";

export { percentile, summarize } from "./stats";
export type { LatencyMs, Stats } from "./stats";

export { compareRuns } from "./compare";
export type { Comparison, CompareOptions, ResultsByName, Verdict, WorkloadDelta } from "./compare";

export { parseBaseline, renderJson, renderMarkdown } from "./report";
export type { Report } from "./report";

export {
  createQueueWorkload,
  createSsrWorkload,
  httpWorkload,
  inprocHttpHandler,
} from "./workloads";
export type { HttpHandler, QueueFixture } from "./workloads";

export { BenchError, LestoError } from "./errors";
export type { BenchErrorCode } from "./errors";

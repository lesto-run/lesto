/**
 * The covered core of the `bench` command — everything the executable does
 * EXCEPT touching the real filesystem, clock, and stdout. The bin (untestable
 * wiring) injects those as `ReportIo`; this module owns every decision, so the
 * suite definition, the baseline compare, and the artifact assembly are unit
 * tested to 100% with fakes.
 */

import { compareRuns } from "./compare";
import { parseBaseline, renderJson, renderMarkdown } from "./report";
import { runBench } from "./runner";
import {
  baselineHttpHandler,
  createQueueWorkload,
  createSsrWorkload,
  httpWorkload,
} from "./workloads";

import type { ResultsByName } from "./compare";
import type { HttpHandler } from "./workloads";
import type { Report } from "./report";
import type { RunResult } from "./runner";

/** The side effects the runner needs, injected so the core stays pure and testable. */
export interface ReportIo {
  /** Read the previously recorded `results.json`, or `null` if there is none yet. */
  readonly readBaseline: () => Promise<string | null>;
  /** Persist the two rendered artifacts (markdown + json). */
  readonly writeMarkdown: (markdown: string) => Promise<void>;
  readonly writeJson: (json: string) => Promise<void>;
  /** Print a line of progress/summary. */
  readonly log: (line: string) => void;
  /** The wall-clock the report timestamp is taken from. */
  readonly now: () => Date;
}

export interface ReportOptions {
  /** Operations per workload. Smaller for a smoke run, larger for a stable number. */
  readonly iterations?: number;
  /** Concurrent workers for the queue (and any contended) workload. */
  readonly concurrency?: number;
  /** Warmup operations discarded before measuring. */
  readonly warmup?: number;
  /** The ref (git sha / release tag) this run measured, recorded into the report. */
  readonly ref?: string;
  /**
   * Override the Lesto HTTP handler under test. Defaults to the bare baseline so a
   * dependency-free `bench` still emits an HTTP req/s number; a caller with the
   * real app handler passes it here to measure the framework.
   */
  readonly httpHandler?: HttpHandler;
}

/** What a report run produces: the assembled report and the rendered artifacts. */
export interface ReportArtifacts {
  readonly report: Report;
  readonly markdown: string;
  readonly json: string;
  /** True iff a workload regressed against the baseline — the CI gate signal. */
  readonly regressed: boolean;
}

const DEFAULT_ITERATIONS = 200;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_WARMUP = 20;

/**
 * Run the full benchmark suite and assemble the tracked report.
 *
 * The suite is fixed and ordered: an HTTP baseline + the Lesto handler (the
 * comparison point for req/s), the queue claim throughput under `concurrency`
 * workers, and the SSR render path. Each is a `runBench` over a real
 * `SampleSource` from `workloads.ts`. After the runs, the recorded baseline (if
 * any) is diffed in so the artifacts carry the trend.
 *
 * Returns the artifacts rather than writing them, so the bin owns the actual
 * disk write and a test asserts the exact strings.
 */
export async function runReport(
  io: ReportIo,
  options: ReportOptions = {},
): Promise<ReportArtifacts> {
  const iterations = options.iterations ?? DEFAULT_ITERATIONS;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const warmup = options.warmup ?? DEFAULT_WARMUP;
  const httpHandler = options.httpHandler ?? baselineHttpHandler;

  io.log(`Running benchmark suite: ${iterations} ops/workload, concurrency ${concurrency}.`);

  // ---- HTTP: a bare baseline next to the handler under test ----
  const httpBaseline = await runBench(httpWorkload(baselineHttpHandler), {
    name: "http-baseline",
    iterations,
    concurrency,
    warmup,
  });
  const httpLesto = await runBench(httpWorkload(httpHandler), {
    name: "http-lesto",
    iterations,
    concurrency,
    warmup,
  });

  // ---- Queue: real claims/sec under N concurrent workers ----
  // Seed enough jobs that the queue never drains inside the measured window
  // (warmup + the full run), so every claim hits a real row.
  const queueFixture = await createQueueWorkload(iterations + warmup);
  let queueRun: RunResult;
  try {
    queueRun = await runBench(queueFixture.source, {
      name: "queue-claim",
      iterations,
      concurrency,
      warmup,
    });
  } finally {
    queueFixture.close();
  }

  // ---- SSR: render-path throughput (single-threaded; the renderer is CPU-bound) ----
  const ssrRun = await runBench(createSsrWorkload(), {
    name: "ssr-render",
    iterations,
    concurrency: 1,
    warmup,
  });

  const results: ResultsByName = indexByName([httpBaseline, httpLesto, queueRun, ssrRun]);
  for (const run of Object.values(results)) {
    io.log(
      `  ${run.name}: ${run.stats.throughput.toFixed(0)} ops/s, ` +
        `p99 ${run.stats.p99.toFixed(2)}ms`,
    );
  }

  const report: Report = options.ref
    ? { recordedAt: io.now().toISOString(), ref: options.ref, results }
    : { recordedAt: io.now().toISOString(), results };

  // Diff against the recorded baseline so the artifacts carry the trend. A first
  // run has no baseline — every workload reads `new` and nothing regresses.
  const baselineJson = await io.readBaseline();
  const baseline: ResultsByName = baselineJson === null ? {} : parseBaseline(baselineJson);
  const comparison = compareRuns(baseline, results);

  const markdown = renderMarkdown(report, comparison);
  const json = renderJson(report);

  await io.writeMarkdown(markdown);
  await io.writeJson(json);

  if (comparison.regressed) {
    io.log("Regression detected against the recorded baseline.");
  }

  return { report, markdown, json, regressed: comparison.regressed };
}

/** Key a list of runs by their workload name — the report's `ResultsByName` shape. */
function indexByName(runs: readonly RunResult[]): ResultsByName {
  const byName: Record<string, RunResult> = {};
  for (const run of runs) {
    byName[run.name] = run;
  }

  return byName;
}

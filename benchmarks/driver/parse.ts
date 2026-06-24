/**
 * The PURE core of the real-server load harness: normalize a load generator's
 * JSON output into one shape, reduce repeated runs to a median, and rank
 * frameworks per workload into a markdown table.
 *
 * The orchestration that actually spawns servers and shells out to the load
 * generator lives in `run.ts` (it cannot run in a sandbox that blocks server
 * starts). Everything a test CAN pin without a socket lives here: the two
 * parsers, the median, and the renderer — so the numbers' provenance is covered
 * even though the live run is CI/local-only.
 *
 * Two generators are supported so the harness runs on whatever a CI image has:
 *   - `oha`        — Rust load generator; JSON times are in SECONDS.
 *   - `autocannon` — Node load generator; JSON times are in MILLISECONDS.
 * Both normalize to {@link LoadSample} (req/s + p50/p99 in ms).
 */

/** One normalized measurement of one (framework, workload) pair. */
export interface LoadSample {
  /** Sustained requests/second — the primary ranking key. */
  readonly requestsPerSec: number;
  /** Median request latency, in milliseconds. */
  readonly p50Ms: number;
  /** Tail request latency, in milliseconds. */
  readonly p99Ms: number;
  /**
   * Fraction of requests that succeeded (2xx), in `[0, 1]`. THIS GUARDS THE
   * RANKING: a framework can post a huge req/s while dropping a third of requests
   * (the Platformatic benchmark's Next.js result). A throughput number at <100%
   * success is not sustained throughput — the report flags it so a glance can't
   * mistake "fast but failing" for "fast".
   */
  readonly successRate: number;
}

/** Raise a parse failure with the offending payload attached, so a bad run is debuggable. */
function fail(generator: string, reason: string): never {
  throw new Error(`Could not parse ${generator} output: ${reason}`);
}

/**
 * Parse `oha --json` output. oha reports `summary.requestsPerSec` and a
 * `latencyPercentiles` map whose values are in SECONDS — converted to ms here so
 * every sample, whatever the generator, is in one unit.
 */
export function parseOha(json: string): LoadSample {
  let parsed: {
    summary?: { requestsPerSec?: number; successRate?: number };
    latencyPercentiles?: Record<string, number>;
  };
  try {
    parsed = JSON.parse(json) as typeof parsed;
  } catch {
    fail("oha", "not valid JSON");
  }

  const rps = parsed.summary?.requestsPerSec;
  const p50 = parsed.latencyPercentiles?.p50;
  const p99 = parsed.latencyPercentiles?.p99;

  if (typeof rps !== "number" || typeof p50 !== "number" || typeof p99 !== "number") {
    fail("oha", "missing summary.requestsPerSec or latencyPercentiles.p50/p99");
  }

  // oha reports successRate as a fraction already; absent (older oha) → assume all-success.
  const successRate =
    typeof parsed.summary?.successRate === "number" ? parsed.summary.successRate : 1;

  // oha latency percentiles are in SECONDS; normalize to milliseconds.
  return { requestsPerSec: rps, p50Ms: p50 * 1000, p99Ms: p99 * 1000, successRate };
}

/**
 * Parse `autocannon --json` output. autocannon reports `requests.average`
 * (req/s) and a `latency` map already in MILLISECONDS.
 */
export function parseAutocannon(json: string): LoadSample {
  let parsed: {
    requests?: { average?: number; total?: number };
    latency?: { p50?: number; p99?: number };
    "2xx"?: number;
    non2xx?: number;
    errors?: number;
    timeouts?: number;
  };
  try {
    parsed = JSON.parse(json) as typeof parsed;
  } catch {
    fail("autocannon", "not valid JSON");
  }

  const rps = parsed.requests?.average;
  const p50 = parsed.latency?.p50;
  const p99 = parsed.latency?.p99;

  if (typeof rps !== "number" || typeof p50 !== "number" || typeof p99 !== "number") {
    fail("autocannon", "missing requests.average or latency.p50/p99");
  }

  // successRate = 2xx / everything that left the gun (2xx + non-2xx + errors + timeouts).
  // A framework that drops requests under load shows up here, not just in a flattering req/s.
  const ok = parsed["2xx"] ?? 0;
  const attempted = ok + (parsed.non2xx ?? 0) + (parsed.errors ?? 0) + (parsed.timeouts ?? 0);
  const successRate = attempted > 0 ? ok / attempted : 1;

  return { requestsPerSec: rps, p50Ms: p50, p99Ms: p99, successRate };
}

/** The supported generators, dispatched by name to their parser. */
export const PARSERS: Record<string, (json: string) => LoadSample> = {
  oha: parseOha,
  autocannon: parseAutocannon,
};

/**
 * The median of `values`. For an even count, the mean of the two middle values.
 * Throws on an empty input — a median of nothing is a bug in the caller, not a
 * silent `0` that would poison a ranking.
 *
 * The harness reports the MEDIAN of N repeated runs, never the best: the best run
 * flatters; the median is what the framework actually sustains.
 */
export function median(values: readonly number[]): number {
  if (values.length === 0) {
    throw new Error("median of an empty list is undefined");
  }

  const sorted = values.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
    : (sorted[mid] as number);
}

/**
 * Reduce repeated runs of one (framework, workload) to a single representative run:
 * the run AT the median throughput, returned WHOLE.
 *
 * We pick a real run rather than medianing each metric independently — independent
 * medians can pair run A's high req/s with run C's good success rate, manufacturing
 * a tuple no run produced and hiding a "fast but failing" run from the ⚠️ flag. The
 * median-throughput run's own success rate and p99 are what that throughput
 * actually cost. Throws on empty input (a bug, not a silent zero).
 */
export function medianSample(samples: readonly LoadSample[]): LoadSample {
  if (samples.length === 0) {
    throw new Error("medianSample of an empty list is undefined");
  }

  const sorted = samples.toSorted((a, b) => a.requestsPerSec - b.requestsPerSec);

  // Lower-middle for an even count — a real run, never an average of two.
  return sorted[Math.floor((sorted.length - 1) / 2)] as LoadSample;
}

/** A finished, reduced result for one (framework, workload) cell. */
export interface FrameworkResult {
  readonly framework: string;
  readonly workload: string;
  readonly sample: LoadSample;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Render the results as one ranked markdown table per workload — frameworks
 * sorted fastest-first by req/s, each annotated with its share of the workload
 * leader. Deterministic for fixed inputs so the committed report diffs cleanly.
 */
export function renderResults(results: readonly FrameworkResult[], recordedAt: string): string {
  const workloads = [...new Set(results.map((r) => r.workload))];

  const sections = workloads.map((workload) => {
    const rows = results
      .filter((r) => r.workload === workload)
      .toSorted((a, b) => b.sample.requestsPerSec - a.sample.requestsPerSec);
    const fastest = rows[0]?.sample.requestsPerSec ?? 0;

    const body = rows.map((row, index) => {
      const rank = index === 0 ? "🏆 1" : String(index + 1);
      const relative = fastest > 0 ? (row.sample.requestsPerSec / fastest) * 100 : 0;
      const successPct = round2(row.sample.successRate * 100);
      // A throughput posted at <100% success is "fast but failing" — flag it loudly
      // so it can't be read as sustained throughput (the Platformatic Next.js trap).
      const success = row.sample.successRate >= 0.999 ? `${successPct}%` : `⚠️ ${successPct}%`;

      return (
        `| ${rank} | ${row.framework} | ${round2(row.sample.requestsPerSec)} | ` +
        `${round2(relative)}% | ${success} | ${round2(row.sample.p50Ms)} | ${round2(row.sample.p99Ms)} |`
      );
    });

    return [
      `### ${workload}`,
      "",
      "| Rank | Framework | req/s | % of fastest | success | p50 (ms) | p99 (ms) |",
      "| ---: | --- | ---: | ---: | ---: | ---: | ---: |",
      ...body,
      "",
    ].join("\n");
  });

  return [
    "# Lesto real-server benchmark results",
    "",
    "Each framework serves the identical, UNCOMPRESSED workload (see `workloads.md`)",
    "from its own pinned app; a load generator hits it over a real socket. Numbers",
    "are the MEDIAN of repeated runs on one machine — reproducible via `driver/run.ts`,",
    "never compared across machines. See `README.md` for the methodology and the exact",
    "hardware/version matrix every published number must cite.",
    "",
    "**Read `success` first.** A big req/s at <100% success (flagged ⚠️) means the",
    "framework dropped requests under load — that is *not* sustained throughput, so its",
    "rank is not a win. Then read p99 (tail latency) — the number users actually feel.",
    "",
    `_recorded: ${recordedAt}_`,
    "",
    ...sections,
  ].join("\n");
}

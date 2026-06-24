/**
 * The PURE core of the real-server load harness: normalize a load generator's
 * JSON output into one shape, reduce repeated runs, sweep a connection ladder into
 * a saturation curve + a single headline (max sustainable req/s at 100% success),
 * and render it all to markdown.
 *
 * The orchestration that actually spawns servers and shells out to the load
 * generator lives in `run.ts` (it cannot run in a sandbox that blocks server
 * starts). Everything a test CAN pin without a socket lives here — the two parsers,
 * the median, the descriptive statistics (mean/stddev/CV), the stability gate, the
 * saturation reducer, the seeded run-order shuffle, and the renderer — so the
 * numbers' provenance and statistical claims are covered even though the live run
 * is CI/local-only.
 *
 * Two generators are supported so the harness runs on whatever a CI image has:
 *   - `oha`        — Rust load generator; JSON times are in SECONDS.
 *   - `autocannon` — Node load generator; JSON times are in MILLISECONDS.
 * Both normalize to {@link LoadSample} (req/s + a full percentile spread in ms).
 */

/**
 * The success rate at or above which a throughput number counts as "sustained":
 * a framework dropping even a fraction of a percent of requests under load is not
 * really serving that throughput. Shared by the ⚠️ render flag AND the
 * max-sustainable-req/s reducer so "fast but failing" is defined in exactly one
 * place. 0.999 ≈ 100% with a sliver of slack for a single dropped request in a run.
 */
export const SUCCESS_THRESHOLD = 0.999;

/** Default coefficient-of-variation ceiling (as a fraction) for the stability gate. */
export const DEFAULT_CV_THRESHOLD = 0.05;

/** One normalized measurement of one (framework, workload, connection-level) run. */
export interface LoadSample {
  /** Sustained requests/second — the primary ranking key. */
  readonly requestsPerSec: number;
  /** Median request latency, in milliseconds. */
  readonly p50Ms: number;
  /** 75th-percentile request latency, in milliseconds. */
  readonly p75Ms: number;
  /** 90th-percentile request latency, in milliseconds. */
  readonly p90Ms: number;
  /** 99th-percentile (tail) request latency, in milliseconds. */
  readonly p99Ms: number;
  /** 99.9th-percentile (deep tail) request latency, in milliseconds. */
  readonly p999Ms: number;
  /** Worst observed request latency, in milliseconds. */
  readonly maxMs: number;
  /**
   * Fraction of requests that succeeded (2xx), in `[0, 1]`. THIS GUARDS THE
   * RANKING: a framework can post a huge req/s while dropping a third of requests
   * (the Platformatic benchmark's Next.js result). A throughput number at <100%
   * success is not sustained throughput — the report flags it so a glance can't
   * mistake "fast but failing" for "fast", and the max-sustainable reducer refuses
   * to count it.
   */
  readonly successRate: number;
}

/** Raise a parse failure with the offending payload attached, so a bad run is debuggable. */
function fail(generator: string, reason: string): never {
  throw new Error(`Could not parse ${generator} output: ${reason}`);
}

/**
 * Parse `oha --json` output. oha reports `summary.requestsPerSec`, a
 * `latencyPercentiles` map whose values are in SECONDS, and `summary.slowest`
 * (the max, also seconds) — all converted to ms here so every sample, whatever the
 * generator, is in one unit. The deep-tail percentile is keyed `"p99.9"` and the
 * deep-tail/max degrade gracefully on an older oha that omits them.
 */
export function parseOha(json: string): LoadSample {
  let parsed: {
    summary?: { requestsPerSec?: number; successRate?: number; slowest?: number };
    latencyPercentiles?: Record<string, number>;
  };
  try {
    parsed = JSON.parse(json) as typeof parsed;
  } catch {
    fail("oha", "not valid JSON");
  }

  const lp = parsed.latencyPercentiles ?? {};
  const rps = parsed.summary?.requestsPerSec;
  const p50 = lp.p50;
  const p75 = lp.p75;
  const p90 = lp.p90;
  const p99 = lp.p99;

  if (
    typeof rps !== "number" ||
    typeof p50 !== "number" ||
    typeof p75 !== "number" ||
    typeof p90 !== "number" ||
    typeof p99 !== "number"
  ) {
    fail("oha", "missing summary.requestsPerSec or latencyPercentiles.p50/p75/p90/p99");
  }

  // Deep tail + max are best-effort: fall back up the spread so an older oha still
  // yields a monotone sample rather than a 0 that would flatter the tail.
  const p999 = typeof lp["p99.9"] === "number" ? lp["p99.9"] : p99;
  const slowest = parsed.summary?.slowest;
  const max = typeof slowest === "number" ? slowest : p999;

  // oha reports successRate as a fraction already; absent (older oha) → assume all-success.
  const successRate =
    typeof parsed.summary?.successRate === "number" ? parsed.summary.successRate : 1;

  // oha latency values are in SECONDS; normalize to milliseconds.
  return {
    requestsPerSec: rps,
    p50Ms: p50 * 1000,
    p75Ms: p75 * 1000,
    p90Ms: p90 * 1000,
    p99Ms: p99 * 1000,
    p999Ms: p999 * 1000,
    maxMs: max * 1000,
    successRate,
  };
}

/**
 * Parse `autocannon --json` output. autocannon reports `requests.average`
 * (req/s) and a `latency` map already in MILLISECONDS, keyed `p50`/`p75`/`p90`/
 * `p99`/`p99_9`/`max` (`.` → `_` in the histogram keys).
 */
export function parseAutocannon(json: string): LoadSample {
  let parsed: {
    requests?: { average?: number; total?: number };
    latency?: {
      p50?: number;
      p75?: number;
      p90?: number;
      p99?: number;
      p99_9?: number;
      max?: number;
    };
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

  const lat = parsed.latency ?? {};
  const rps = parsed.requests?.average;
  const p50 = lat.p50;
  const p75 = lat.p75;
  const p90 = lat.p90;
  const p99 = lat.p99;

  if (
    typeof rps !== "number" ||
    typeof p50 !== "number" ||
    typeof p75 !== "number" ||
    typeof p90 !== "number" ||
    typeof p99 !== "number"
  ) {
    fail("autocannon", "missing requests.average or latency.p50/p75/p90/p99");
  }

  const p999 = typeof lat.p99_9 === "number" ? lat.p99_9 : p99;
  const max = typeof lat.max === "number" ? lat.max : p999;

  // successRate = 2xx / everything that left the gun (2xx + non-2xx + errors + timeouts).
  // A framework that drops requests under load shows up here, not just in a flattering req/s.
  const ok = parsed["2xx"] ?? 0;
  const attempted = ok + (parsed.non2xx ?? 0) + (parsed.errors ?? 0) + (parsed.timeouts ?? 0);
  const successRate = attempted > 0 ? ok / attempted : 1;

  return {
    requestsPerSec: rps,
    p50Ms: p50,
    p75Ms: p75,
    p90Ms: p90,
    p99Ms: p99,
    p999Ms: p999,
    maxMs: max,
    successRate,
  };
}

/** The supported generators, dispatched by name to their parser. */
export const PARSERS: Record<string, (json: string) => LoadSample> = {
  oha: parseOha,
  autocannon: parseAutocannon,
};

// ---------------------------------------------------------------------------
// Descriptive statistics — the rigor layer over N repeated trials.
// ---------------------------------------------------------------------------

/** The arithmetic mean of `values`. Throws on empty input (a caller bug, not a silent 0). */
export function mean(values: readonly number[]): number {
  if (values.length === 0) {
    throw new Error("mean of an empty list is undefined");
  }

  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * The SAMPLE standard deviation (Bessel-corrected, `n - 1`) of `values` — the
 * spread across repeated trials, the honest estimator when the runs are a sample
 * of all possible runs. Returns 0 for a single value (no spread to estimate) and
 * throws on empty input.
 */
export function sampleStdDev(values: readonly number[]): number {
  if (values.length === 0) {
    throw new Error("stddev of an empty list is undefined");
  }
  if (values.length === 1) {
    return 0;
  }
  const m = mean(values);
  const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1);

  return Math.sqrt(variance);
}

/**
 * The coefficient of variation — stddev / mean, as a FRACTION (0.05 = 5%). This is
 * the run-to-run noise normalized by the magnitude, so it's comparable across fast
 * and slow frameworks. Returns 0 when the mean is 0 (no signal to be noisy about).
 */
export function coefficientOfVariation(values: readonly number[]): number {
  const m = mean(values);

  return m === 0 ? 0 : sampleStdDev(values) / m;
}

/** The stability of one (framework, workload, level)'s throughput across its trials. */
export interface Stability {
  /** Mean req/s across the trials. */
  readonly mean: number;
  /** Sample standard deviation of req/s. */
  readonly stdDev: number;
  /** Coefficient of variation as a fraction (stdDev / mean). */
  readonly cv: number;
  /** Number of trials the statistics were computed from. */
  readonly trials: number;
  /** Whether `cv` is at or below the threshold — false means the number is too noisy to trust. */
  readonly stable: boolean;
}

/**
 * Assess the throughput stability of N repeated trials. A run whose CV exceeds the
 * threshold is FLAGGED, not silently averaged away: high run-to-run variance means
 * the host was contended (background load, thermal throttling) and the median is
 * not reproducible. The default ceiling is {@link DEFAULT_CV_THRESHOLD}.
 */
export function assessStability(
  rpsSamples: readonly number[],
  cvThreshold: number = DEFAULT_CV_THRESHOLD,
): Stability {
  const cv = coefficientOfVariation(rpsSamples);

  return {
    mean: mean(rpsSamples),
    stdDev: sampleStdDev(rpsSamples),
    cv,
    trials: rpsSamples.length,
    stable: cv <= cvThreshold,
  };
}

// ---------------------------------------------------------------------------
// Reduction: repeated runs → one representative run.
// ---------------------------------------------------------------------------

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
 * Reduce repeated runs of one (framework, workload, level) to a single
 * representative run: the run AT the median throughput, returned WHOLE.
 *
 * We pick a real run rather than medianing each metric independently — independent
 * medians can pair run A's high req/s with run C's good success rate, manufacturing
 * a tuple no run produced and hiding a "fast but failing" run from the ⚠️ flag. The
 * median-throughput run's own success rate and percentiles are what that throughput
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

// ---------------------------------------------------------------------------
// Saturation: a connection ladder → the headline (max sustainable req/s).
// ---------------------------------------------------------------------------

/** One rung of the connection ladder for a (framework, workload): its reduced run + trial spread. */
export interface ConnectionLevel {
  /** Concurrent connections the load generator held at this rung. */
  readonly connections: number;
  /** The median-throughput run of this rung's trials. */
  readonly sample: LoadSample;
  /** Throughput stability across this rung's trials. */
  readonly stability: Stability;
}

/** The saturation summary for one (framework, workload) across the whole connection ladder. */
export interface SaturationResult {
  readonly framework: string;
  readonly workload: string;
  /** Every rung, ASCENDING by connections. */
  readonly levels: readonly ConnectionLevel[];
  /**
   * The headline: the highest req/s recorded at a rung that still held
   * {@link SUCCESS_THRESHOLD} success. 0 if no rung sustained it (the framework
   * dropped requests at every concurrency we tried).
   */
  readonly maxSustainableRps: number;
  /** The connection count at the sustainable peak, or null if nothing sustained. */
  readonly maxSustainableAt: number | null;
  /** The full sample at the sustainable peak (for its p99 etc.), or null. */
  readonly peakSample: LoadSample | null;
  /**
   * Did we actually observe the knee of the curve? True if some rung fell below the
   * success threshold (we pushed past capacity) OR the peak throughput was not at
   * the top rung (throughput stopped climbing). False ⇒ the curve was still rising
   * at the highest concurrency tested — the headline is a floor, raise `--connections`.
   */
  readonly saturated: boolean;
}

/**
 * Reduce a connection ladder to the saturation headline. The MAX SUSTAINABLE
 * req/s is the real metric (per the Platformatic 1k-rps framing): the best
 * throughput a framework holds without dropping requests, NOT the biggest number it
 * can post while shedding load. Levels are sorted ascending; ties in throughput
 * keep the lower-concurrency rung (cheaper to achieve the same rate).
 */
export function summarizeSaturation(
  framework: string,
  workload: string,
  levels: readonly ConnectionLevel[],
  successThreshold: number = SUCCESS_THRESHOLD,
): SaturationResult {
  if (levels.length === 0) {
    throw new Error("summarizeSaturation of an empty ladder is undefined");
  }

  const sorted = levels.toSorted((a, b) => a.connections - b.connections);

  let maxSustainableRps = 0;
  let maxSustainableAt: number | null = null;
  let peakSample: LoadSample | null = null;
  for (const level of sorted) {
    if (
      level.sample.successRate >= successThreshold &&
      level.sample.requestsPerSec > maxSustainableRps
    ) {
      maxSustainableRps = level.sample.requestsPerSec;
      maxSustainableAt = level.connections;
      peakSample = level.sample;
    }
  }

  // The peak THROUGHPUT rung (ignoring success) — if it isn't the last rung, the
  // curve turned over, so we found the knee. Also saturated if any rung shed load.
  const peakThroughputConns = sorted.reduce((best, l) =>
    l.sample.requestsPerSec > best.sample.requestsPerSec ? l : best,
  ).connections;
  const sheddedLoad = sorted.some((l) => l.sample.successRate < successThreshold);
  const turnedOver =
    peakThroughputConns !== (sorted[sorted.length - 1] as ConnectionLevel).connections;

  return {
    framework,
    workload,
    levels: sorted,
    maxSustainableRps,
    maxSustainableAt,
    peakSample,
    saturated: sheddedLoad || turnedOver,
  };
}

// ---------------------------------------------------------------------------
// Reproducible run order — a seeded shuffle to defeat thermal/ordering bias.
// ---------------------------------------------------------------------------

/**
 * A tiny, deterministic PRNG (mulberry32) seeded by a 32-bit integer. The harness
 * randomizes the order of measurement units so a framework isn't systematically
 * timed while the CPU is cold (first) or hot (last) — but a benchmark must be
 * reproducible, so the order is seeded and the seed is stamped into the report.
 * Same seed ⇒ same order. Not for cryptography.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;

  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A Fisher–Yates shuffle driven by `rng` (so it's deterministic for a fixed seed).
 * Returns a new array; the input is not mutated.
 */
export function shuffle<T>(items: readonly T[], rng: () => number): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }

  return a;
}

// ---------------------------------------------------------------------------
// Rendering.
// ---------------------------------------------------------------------------

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Format a success rate as a percent, prefixed with ⚠️ when it's below the sustained bar. */
function fmtSuccess(successRate: number): string {
  const pct = round2(successRate * 100);

  return successRate >= SUCCESS_THRESHOLD ? `${pct}%` : `⚠️ ${pct}%`;
}

/** Run-level parameters stamped into the report header so a number carries how it was produced. */
export interface ReportMeta {
  readonly recordedAt: string;
  /** Repetitions per rung (the median is reported). */
  readonly runs?: number;
  /** The seed the run order was shuffled with (so the order is reproducible). */
  readonly seed?: number | null;
  /** Constant request rate (req/s) for coordinated-omission-aware load, or null = closed-loop. */
  readonly rateRps?: number | null;
  /** The connection ladder that was swept. */
  readonly connections?: readonly number[];
  /** The CV ceiling (percent) the stability gate used. */
  readonly cvThresholdPct?: number;
}

/** The per-workload max-sustainable headline: frameworks ranked by sustained throughput. */
function renderHeadline(workload: string, results: readonly SaturationResult[]): string {
  const rows = results
    .filter((r) => r.workload === workload)
    .toSorted((a, b) => b.maxSustainableRps - a.maxSustainableRps);
  const fastest = rows[0]?.maxSustainableRps ?? 0;

  const body = rows.map((row, index) => {
    const sustained = row.maxSustainableRps > 0;
    const rank = !sustained ? "—" : index === 0 ? "🏆 1" : String(index + 1);
    const relative =
      sustained && fastest > 0 ? `${round2((row.maxSustainableRps / fastest) * 100)}%` : "—";
    // The headline number, annotated when the curve was still climbing (a floor, not the ceiling).
    const rps = sustained
      ? `${round2(row.maxSustainableRps)}${row.saturated ? "" : " ↑"}`
      : "⚠️ none";
    const at = row.maxSustainableAt === null ? "—" : `${row.maxSustainableAt}c`;
    const p99 = row.peakSample ? round2(row.peakSample.p99Ms) : "—";
    const p999 = row.peakSample ? round2(row.peakSample.p999Ms) : "—";

    return `| ${rank} | ${row.framework} | ${rps} | ${relative} | ${at} | ${p99} | ${p999} |`;
  });

  return [
    `### ${workload}`,
    "",
    "**Max sustainable req/s** (highest throughput held at ≥99.9% success). `↑` = curve still",
    "climbing at the top of the ladder (raise `--connections`); `⚠️ none` = dropped requests at every rung.",
    "",
    "| Rank | Framework | max sustainable req/s | % of fastest | @ conns | p99 (ms) | p99.9 (ms) |",
    "| ---: | --- | ---: | ---: | ---: | ---: | ---: |",
    ...body,
    "",
  ].join("\n");
}

/** The per-(framework, workload) saturation curve: one row per connection rung. */
function renderCurve(result: SaturationResult): string {
  const rows = result.levels.map((level) => {
    const s = level.sample;
    const cvPct = round2(level.stability.cv * 100);
    const cvCell = level.stability.stable ? `${cvPct}%` : `⚠️ ${cvPct}%`;

    return (
      `| ${level.connections} | ${round2(s.requestsPerSec)} | ${fmtSuccess(s.successRate)} | ` +
      `${round2(s.p50Ms)} | ${round2(s.p90Ms)} | ${round2(s.p99Ms)} | ${round2(s.p999Ms)} | ` +
      `${round2(s.maxMs)} | ${cvCell} |`
    );
  });

  return [
    `#### ${result.framework} — ${result.workload}`,
    "",
    "| conns | req/s | success | p50 | p90 | p99 | p99.9 | max | CV |",
    "| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...rows,
    "",
  ].join("\n");
}

/**
 * Render the results as markdown: per workload, a max-sustainable ranking headline,
 * then the full saturation curve per framework (the throughput/latency/success
 * trade-off at each concurrency, with the CV stability flag). Deterministic for
 * fixed inputs so the committed report diffs cleanly.
 */
export function renderResults(results: readonly SaturationResult[], meta: ReportMeta): string {
  const workloads = [...new Set(results.map((r) => r.workload))];

  const load =
    meta.rateRps != null
      ? `constant-rate ${meta.rateRps} req/s (coordinated-omission-aware)`
      : "closed-loop (connection-bound)";
  const params = [
    meta.runs != null ? `${meta.runs} trials/rung (median)` : null,
    meta.connections ? `ladder ${meta.connections.join("/")}c` : null,
    `load ${load}`,
    meta.cvThresholdPct != null ? `stability gate CV≤${meta.cvThresholdPct}%` : null,
    meta.seed != null ? `seed ${meta.seed}` : null,
  ].filter((p): p is string => p !== null);

  const sections: string[] = [];
  for (const workload of workloads) {
    sections.push(renderHeadline(workload, results));
    for (const result of results.filter((r) => r.workload === workload)) {
      sections.push(renderCurve(result));
    }
  }

  return [
    "# Lesto real-server benchmark results",
    "",
    "Each framework serves the identical, UNCOMPRESSED workload (see `workloads.md`)",
    "from its own pinned app; a load generator sweeps a ladder of connection levels",
    "over a real socket. The headline per workload is **max sustainable req/s** — the",
    "highest throughput a framework holds at ≥99.9% success — not the biggest number it",
    "can post while shedding load. Numbers are the MEDIAN of repeated trials on one",
    "machine, reproducible via `driver/run.ts`, never compared across machines.",
    "",
    "**Read `success` first.** A big req/s at <100% success (flagged ⚠️) means the",
    "framework dropped requests under load — that is *not* sustained throughput, so its",
    "rank is not a win. Then read p99 / p99.9 (tail latency) — the number users feel. A",
    "⚠️ on `CV` means that rung was too noisy (host contention) to trust.",
    "",
    `_recorded: ${meta.recordedAt}_  \n_run: ${params.join(" · ")}_`,
    "",
    ...sections,
  ].join("\n");
}

import { describe, expect, test } from "bun:test";

import {
  assessStability,
  coefficientOfVariation,
  type ConnectionLevel,
  DEFAULT_CV_THRESHOLD,
  type LoadSample,
  mean,
  median,
  medianSample,
  mulberry32,
  parseAutocannon,
  parseOha,
  renderResults,
  sampleStdDev,
  type SaturationResult,
  shuffle,
  summarizeSaturation,
  SUCCESS_THRESHOLD,
} from "./parse";

/** A full LoadSample with sane defaults, overridable per field — keeps the tests terse. */
function sample(overrides: Partial<LoadSample> = {}): LoadSample {
  return {
    requestsPerSec: 1000,
    p50Ms: 1,
    p75Ms: 2,
    p90Ms: 3,
    p99Ms: 5,
    p999Ms: 9,
    maxMs: 20,
    successRate: 1,
    ...overrides,
  };
}

describe("parseOha", () => {
  test("reads req/s, success rate, full percentile spread, and converts seconds → ms", () => {
    const json = JSON.stringify({
      summary: { requestsPerSec: 52345.6, successRate: 0.97, slowest: 0.042 },
      latencyPercentiles: { p50: 0.0012, p75: 0.0019, p90: 0.0031, p99: 0.0098, "p99.9": 0.021 },
    });

    const s = parseOha(json);
    expect(s.requestsPerSec).toBe(52345.6);
    expect(s.p50Ms).toBeCloseTo(1.2, 10);
    expect(s.p75Ms).toBeCloseTo(1.9, 10);
    expect(s.p90Ms).toBeCloseTo(3.1, 10);
    expect(s.p99Ms).toBeCloseTo(9.8, 10);
    expect(s.p999Ms).toBeCloseTo(21, 10);
    expect(s.maxMs).toBeCloseTo(42, 10);
    expect(s.successRate).toBe(0.97);
  });

  test("defaults success rate to 1 when oha omits it", () => {
    const json = JSON.stringify({
      summary: { requestsPerSec: 100 },
      latencyPercentiles: { p50: 0.001, p75: 0.001, p90: 0.001, p99: 0.002 },
    });

    expect(parseOha(json).successRate).toBe(1);
  });

  test("falls back p99.9 → p99 and max → p99.9 when an older oha omits them", () => {
    const json = JSON.stringify({
      summary: { requestsPerSec: 100 },
      latencyPercentiles: { p50: 0.001, p75: 0.001, p90: 0.001, p99: 0.002 },
    });

    const s = parseOha(json);
    expect(s.p999Ms).toBeCloseTo(2, 10); // fell back to p99
    expect(s.maxMs).toBeCloseTo(2, 10); // fell back to p99.9 (which fell back to p99)
  });

  test("throws with a useful message on malformed JSON", () => {
    expect(() => parseOha("not json")).toThrow(/Could not parse oha/);
  });

  test("throws when a required percentile is absent", () => {
    expect(() =>
      parseOha(
        JSON.stringify({ summary: { requestsPerSec: 1 }, latencyPercentiles: { p50: 0.001 } }),
      ),
    ).toThrow(/missing/);
  });
});

describe("parseAutocannon", () => {
  test("reads req/s, the ms percentile spread, and computes success rate from status counts", () => {
    const json = JSON.stringify({
      requests: { average: 41000, total: 100 },
      latency: { p50: 1.1, p75: 1.8, p90: 3.2, p99: 7.2, p99_9: 15.5, max: 42.1 },
      "2xx": 90,
      non2xx: 5,
      errors: 3,
      timeouts: 2,
    });

    expect(parseAutocannon(json)).toEqual({
      requestsPerSec: 41000,
      p50Ms: 1.1,
      p75Ms: 1.8,
      p90Ms: 3.2,
      p99Ms: 7.2,
      p999Ms: 15.5,
      maxMs: 42.1,
      successRate: 0.9, // 90 / (90 + 5 + 3 + 2)
    });
  });

  test("defaults success rate to 1 when no status counts are present", () => {
    const json = JSON.stringify({
      requests: { average: 1 },
      latency: { p50: 1, p75: 1, p90: 1, p99: 2 },
    });

    expect(parseAutocannon(json).successRate).toBe(1);
  });

  test("falls back p99.9 → p99 and max → p99.9 when absent", () => {
    const json = JSON.stringify({
      requests: { average: 1 },
      latency: { p50: 1, p75: 1, p90: 1, p99: 2 },
    });

    const s = parseAutocannon(json);
    expect(s.p999Ms).toBe(2);
    expect(s.maxMs).toBe(2);
  });

  test("throws on a missing latency block", () => {
    expect(() => parseAutocannon(JSON.stringify({ requests: { average: 1 } }))).toThrow(/missing/);
  });
});

describe("mean", () => {
  test("computes the arithmetic mean", () => {
    expect(mean([2, 4, 6])).toBe(4);
  });

  test("throws on empty input", () => {
    expect(() => mean([])).toThrow(/empty/);
  });
});

describe("sampleStdDev", () => {
  test("uses the Bessel-corrected (n-1) estimator", () => {
    // values [2,4,6]: mean 4, squared devs 4+0+4=8, /(3-1)=4, sqrt=2.
    expect(sampleStdDev([2, 4, 6])).toBeCloseTo(2, 10);
  });

  test("is 0 for a single value (no spread to estimate)", () => {
    expect(sampleStdDev([42])).toBe(0);
  });

  test("throws on empty input", () => {
    expect(() => sampleStdDev([])).toThrow(/empty/);
  });
});

describe("coefficientOfVariation", () => {
  test("is stddev / mean as a fraction", () => {
    // [90,100,110]: mean 100, stddev 10 → CV 0.1.
    expect(coefficientOfVariation([90, 100, 110])).toBeCloseTo(0.1, 10);
  });

  test("is 0 when the mean is 0", () => {
    expect(coefficientOfVariation([0, 0, 0])).toBe(0);
  });
});

describe("assessStability", () => {
  test("flags a run as stable when CV is within the threshold", () => {
    const st = assessStability([1000, 1010, 990], 0.05);
    expect(st.trials).toBe(3);
    expect(st.mean).toBeCloseTo(1000, 6);
    expect(st.stable).toBe(true);
    expect(st.cv).toBeLessThan(0.05);
  });

  test("flags a noisy run as unstable when CV exceeds the threshold", () => {
    const st = assessStability([1000, 1500, 500], 0.05);
    expect(st.stable).toBe(false);
    expect(st.cv).toBeGreaterThan(0.05);
  });

  test("defaults the threshold to DEFAULT_CV_THRESHOLD", () => {
    // [1000,1100,900]: mean 1000, stddev 100 → CV 10%, above the 5% default → unstable.
    expect(DEFAULT_CV_THRESHOLD).toBe(0.05);
    expect(assessStability([1000, 1100, 900]).stable).toBe(false);
  });
});

describe("median", () => {
  test("odd count picks the middle", () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  test("even count averages the two middles", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  test("throws on empty input rather than poisoning a ranking with 0", () => {
    expect(() => median([])).toThrow(/empty/);
  });
});

describe("medianSample", () => {
  test("returns the median-throughput run WHOLE — not per-field medians", () => {
    // The median-throughput run (200 req/s) had a LOW success rate; per-field medians
    // would report success 1 (median of [1, 0.5, 1]) and hide it. Selecting the real
    // run surfaces the 0.5 so the ⚠️ flag can fire.
    const reduced = medianSample([
      sample({ requestsPerSec: 300, successRate: 1 }),
      sample({ requestsPerSec: 200, p99Ms: 90, successRate: 0.5 }),
      sample({ requestsPerSec: 100, successRate: 1 }),
    ]);

    expect(reduced.requestsPerSec).toBe(200);
    expect(reduced.successRate).toBe(0.5);
    expect(reduced.p99Ms).toBe(90);
  });

  test("throws on empty input rather than fabricating a row", () => {
    expect(() => medianSample([])).toThrow(/empty/);
  });
});

describe("summarizeSaturation", () => {
  function level(connections: number, s: Partial<LoadSample>): ConnectionLevel {
    return {
      connections,
      sample: sample(s),
      stability: assessStability([s.requestsPerSec ?? 1000]),
    };
  }

  test("reports the highest throughput held at full success as the headline", () => {
    // Throughput climbs to 100c then the 200c rung sheds load (success 0.8) — so the
    // sustainable peak is the 100c rung, NOT the bigger-but-failing 200c number.
    const result = summarizeSaturation("lesto", "json", [
      level(50, { requestsPerSec: 40000, successRate: 1 }),
      level(100, { requestsPerSec: 80000, successRate: 1 }),
      level(200, { requestsPerSec: 95000, successRate: 0.8 }),
    ]);

    expect(result.maxSustainableRps).toBe(80000);
    expect(result.maxSustainableAt).toBe(100);
    expect(result.peakSample?.requestsPerSec).toBe(80000);
    expect(result.saturated).toBe(true); // a rung shed load → we found the limit
  });

  test("sorts the ladder ascending regardless of input order", () => {
    const result = summarizeSaturation("hono", "json", [
      level(200, { requestsPerSec: 90000, successRate: 1 }),
      level(50, { requestsPerSec: 40000, successRate: 1 }),
      level(100, { requestsPerSec: 80000, successRate: 1 }),
    ]);

    expect(result.levels.map((l) => l.connections)).toEqual([50, 100, 200]);
  });

  test("flags an un-saturated curve when throughput is still climbing at the top rung", () => {
    const result = summarizeSaturation("fastify", "json", [
      level(50, { requestsPerSec: 40000, successRate: 1 }),
      level(100, { requestsPerSec: 60000, successRate: 1 }),
      level(200, { requestsPerSec: 90000, successRate: 1 }),
    ]);

    expect(result.maxSustainableRps).toBe(90000);
    expect(result.maxSustainableAt).toBe(200);
    expect(result.saturated).toBe(false); // peak at the top rung, no shedding → keep climbing
  });

  test("reports zero sustainable when every rung dropped requests", () => {
    const result = summarizeSaturation("express", "json", [
      level(50, { requestsPerSec: 30000, successRate: 0.9 }),
      level(100, { requestsPerSec: 50000, successRate: 0.6 }),
    ]);

    expect(result.maxSustainableRps).toBe(0);
    expect(result.maxSustainableAt).toBeNull();
    expect(result.peakSample).toBeNull();
    expect(result.saturated).toBe(true);
  });

  test("throws on an empty ladder", () => {
    expect(() => summarizeSaturation("x", "json", [])).toThrow(/empty/);
  });
});

describe("mulberry32 + shuffle", () => {
  test("the PRNG is deterministic for a fixed seed", () => {
    const a = mulberry32(123);
    const b = mulberry32(123);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  test("different seeds diverge", () => {
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });

  test("shuffle is a permutation (keeps every element) and does not mutate input", () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    const out = shuffle(input, mulberry32(42));
    expect(out.toSorted((x, y) => x - y)).toEqual(input);
    expect(input).toEqual([1, 2, 3, 4, 5, 6, 7, 8]); // untouched
  });

  test("same seed ⇒ same order (reproducible run order)", () => {
    const items = ["a", "b", "c", "d", "e"];
    expect(shuffle(items, mulberry32(7))).toEqual(shuffle(items, mulberry32(7)));
  });
});

describe("renderResults", () => {
  function satResult(
    framework: string,
    workload: string,
    levels: Array<{ connections: number; s: Partial<LoadSample>; cv?: number[] }>,
  ): SaturationResult {
    return summarizeSaturation(
      framework,
      workload,
      levels.map((l) => ({
        connections: l.connections,
        sample: sample(l.s),
        stability: assessStability(l.cv ?? [l.s.requestsPerSec ?? 1000]),
      })),
    );
  }

  const meta = {
    recordedAt: "2026-01-01T00:00:00.000Z",
    runs: 5,
    seed: 12345,
    connections: [50, 100, 200],
    cvThresholdPct: 5,
  };

  test("ranks each workload by max sustainable req/s with a share-of-leader column", () => {
    const md = renderResults(
      [
        satResult("lesto", "json", [
          { connections: 100, s: { requestsPerSec: 90000, successRate: 1 } },
          { connections: 50, s: { requestsPerSec: 60000, successRate: 1 } },
        ]),
        satResult("express", "json", [
          { connections: 100, s: { requestsPerSec: 30000, successRate: 1 } },
          { connections: 50, s: { requestsPerSec: 25000, successRate: 1 } },
        ]),
      ],
      meta,
    );

    expect(md).toContain("### json");
    // lesto leads at 90k (saturated: peak at 100c, not the top rung 50→100 ascending… top is 100)
    expect(md).toContain("🏆 1 | lesto");
    expect(md).toContain("| express |");
    // express sustainable 30000 is 33.33% of lesto's 90000.
    expect(md).toContain("33.33%");
    expect(md).toContain("seed 12345");
    expect(md).toContain("_recorded: 2026-01-01T00:00:00.000Z_");
  });

  test("renders a per-framework saturation curve with the full percentile spread", () => {
    const md = renderResults(
      [
        satResult("lesto", "json", [
          {
            connections: 50,
            s: { requestsPerSec: 60000, p50Ms: 0.8, p90Ms: 1.5, p99Ms: 3, p999Ms: 6, maxMs: 15 },
          },
          {
            connections: 100,
            s: { requestsPerSec: 90000, p50Ms: 1.1, p90Ms: 2.2, p99Ms: 4, p999Ms: 8, maxMs: 20 },
          },
        ]),
      ],
      meta,
    );

    expect(md).toContain("#### lesto — json");
    expect(md).toContain("| conns | req/s | success | p50 | p75 | p90 | p99 | p99.9 | max | CV |");
    expect(md).toContain("| 50 |");
    expect(md).toContain("| 100 |");
  });

  test("flags a framework that posts throughput at <100% success and reports none sustainable", () => {
    const md = renderResults(
      [
        satResult("fast-but-failing", "json", [
          { connections: 200, s: { requestsPerSec: 200000, p99Ms: 400, successRate: 0.64 } },
        ]),
      ],
      meta,
    );

    // The ⚠️ markers make "fast but dropping a third of requests" impossible to misread as a win.
    expect(md).toContain("⚠️ 64%");
    expect(md).toContain("⚠️ none");
  });

  test("annotates an un-saturated headline with ↑ (curve still climbing)", () => {
    const md = renderResults(
      [
        satResult("lesto", "json", [
          { connections: 50, s: { requestsPerSec: 40000, successRate: 1 } },
          { connections: 100, s: { requestsPerSec: 90000, successRate: 1 } },
        ]),
      ],
      meta,
    );

    expect(md).toContain("↑");
  });

  test("flags a noisy rung's CV with ⚠️ in the curve", () => {
    const md = renderResults(
      [
        satResult("lesto", "json", [
          { connections: 50, s: { requestsPerSec: 1000, successRate: 1 }, cv: [1000, 1500, 500] },
        ]),
      ],
      meta,
    );

    // CV of [1000,1500,500] ≈ 50% → above the gate → flagged.
    expect(md).toMatch(/⚠️ \d+(\.\d+)?%/);
  });

  test("labels constant-rate (coordinated-omission-aware) runs in the header", () => {
    const md = renderResults(
      [
        satResult("lesto", "json", [
          { connections: 100, s: { requestsPerSec: 50000, successRate: 1 } },
        ]),
      ],
      { ...meta, rateRps: 50000 },
    );

    expect(md).toContain("coordinated-omission-aware");
  });
});

describe("SUCCESS_THRESHOLD", () => {
  test("is the single source of the sustained-throughput bar", () => {
    expect(SUCCESS_THRESHOLD).toBe(0.999);
  });
});

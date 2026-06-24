import { describe, expect, test } from "bun:test";

import {
  median,
  medianSample,
  parseAutocannon,
  parseOha,
  renderResults,
  type FrameworkResult,
} from "./parse";

describe("parseOha", () => {
  test("reads req/s, success rate, and converts second-based percentiles to ms", () => {
    const json = JSON.stringify({
      summary: { requestsPerSec: 52345.6, successRate: 0.97 },
      latencyPercentiles: { p50: 0.0012, p99: 0.0098 },
    });

    const sample = parseOha(json);
    expect(sample.requestsPerSec).toBe(52345.6);
    expect(sample.p50Ms).toBeCloseTo(1.2, 10);
    expect(sample.p99Ms).toBeCloseTo(9.8, 10);
    expect(sample.successRate).toBe(0.97);
  });

  test("defaults success rate to 1 when oha omits it", () => {
    const json = JSON.stringify({
      summary: { requestsPerSec: 100 },
      latencyPercentiles: { p50: 0.001, p99: 0.002 },
    });

    expect(parseOha(json).successRate).toBe(1);
  });

  test("throws with a useful message on malformed JSON", () => {
    expect(() => parseOha("not json")).toThrow(/Could not parse oha/);
  });

  test("throws when the expected fields are absent", () => {
    expect(() => parseOha(JSON.stringify({ summary: {} }))).toThrow(/missing/);
  });
});

describe("parseAutocannon", () => {
  test("reads req/s, ms latencies, and computes success rate from status counts", () => {
    const json = JSON.stringify({
      requests: { average: 41000, total: 100 },
      latency: { p50: 1.1, p99: 7.2 },
      "2xx": 90,
      non2xx: 5,
      errors: 3,
      timeouts: 2,
    });

    expect(parseAutocannon(json)).toEqual({
      requestsPerSec: 41000,
      p50Ms: 1.1,
      p99Ms: 7.2,
      successRate: 0.9, // 90 / (90 + 5 + 3 + 2)
    });
  });

  test("defaults success rate to 1 when no status counts are present", () => {
    const json = JSON.stringify({ requests: { average: 1 }, latency: { p50: 1, p99: 2 } });

    expect(parseAutocannon(json).successRate).toBe(1);
  });

  test("throws on a missing latency block", () => {
    expect(() => parseAutocannon(JSON.stringify({ requests: { average: 1 } }))).toThrow(/missing/);
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
      { requestsPerSec: 300, p50Ms: 3, p99Ms: 30, successRate: 1 },
      { requestsPerSec: 200, p50Ms: 9, p99Ms: 90, successRate: 0.5 },
      { requestsPerSec: 100, p50Ms: 1, p99Ms: 10, successRate: 1 },
    ]);

    expect(reduced).toEqual({ requestsPerSec: 200, p50Ms: 9, p99Ms: 90, successRate: 0.5 });
  });

  test("throws on empty input rather than fabricating a row", () => {
    expect(() => medianSample([])).toThrow(/empty/);
  });
});

describe("renderResults", () => {
  const results: FrameworkResult[] = [
    {
      framework: "lesto",
      workload: "json",
      sample: { requestsPerSec: 90000, p50Ms: 1, p99Ms: 3, successRate: 1 },
    },
    {
      framework: "express",
      workload: "json",
      sample: { requestsPerSec: 30000, p50Ms: 3, p99Ms: 9, successRate: 1 },
    },
    {
      framework: "lesto",
      workload: "plaintext",
      sample: { requestsPerSec: 120000, p50Ms: 0.5, p99Ms: 2, successRate: 1 },
    },
  ];

  test("ranks each workload fastest-first with a share-of-leader column", () => {
    const md = renderResults(results, "2026-01-01T00:00:00.000Z");

    expect(md).toContain("### json");
    expect(md).toContain("### plaintext");
    // lesto leads json at 90k; express is a third of that.
    expect(md).toContain("🏆 1 | lesto | 90000 | 100%");
    expect(md).toContain("express | 30000 | 33.33%");
    expect(md).toContain("_recorded: 2026-01-01T00:00:00.000Z_");
  });

  test("flags a framework that posts throughput at <100% success", () => {
    const md = renderResults(
      [
        {
          framework: "fast-but-failing",
          workload: "json",
          sample: { requestsPerSec: 200000, p50Ms: 1, p99Ms: 400, successRate: 0.64 },
        },
      ],
      "2026-01-01T00:00:00.000Z",
    );

    // The ⚠️ marker makes "fast but dropping a third of requests" impossible to misread as a win.
    expect(md).toContain("⚠️ 64%");
  });
});

import { describe, expect, it } from "vitest";

import { compareRuns, parseBaseline, renderJson, renderMarkdown } from "../src/index";

import type { Report, ResultsByName, RunResult, Stats } from "../src/index";

function run(name: string, throughput: number, p99: number, p50 = p99): RunResult {
  const stats: Stats = {
    count: 10,
    throughput,
    elapsedMs: 100,
    min: 1,
    mean: p50,
    p50,
    p99,
    max: p99,
  };

  return { name, iterations: 10, concurrency: 2, stats };
}

function results(...runs: RunResult[]): ResultsByName {
  return Object.fromEntries(runs.map((r) => [r.name, r]));
}

const recordedAt = "2026-06-18T00:00:00.000Z";

describe("renderMarkdown", () => {
  it("renders a stable, sorted snapshot table without a comparison", () => {
    const report: Report = {
      recordedAt,
      results: results(run("zeta", 50, 9), run("alpha", 100, 4)),
    };

    const markdown = renderMarkdown(report);

    // Rows are sorted by name: alpha before zeta.
    const alphaIndex = markdown.indexOf("| alpha |");
    const zetaIndex = markdown.indexOf("| zeta |");
    expect(alphaIndex).toBeGreaterThan(-1);
    expect(alphaIndex).toBeLessThan(zetaIndex);
    // No trend columns when there is no comparison.
    expect(markdown).not.toContain("Δ req/s");
    expect(markdown).toContain("# Lesto benchmark results");
    // Deterministic: same input → byte-identical output.
    expect(renderMarkdown(report)).toBe(markdown);
  });

  it("appends trend columns and a verdict marker when given a comparison", () => {
    const before = results(run("a", 100, 10));
    const after = results(run("a", 130, 9));
    const comparison = compareRuns(before, after);

    const markdown = renderMarkdown({ recordedAt, results: after }, comparison);

    expect(markdown).toContain("Δ req/s");
    expect(markdown).toContain("Δ p99");
    expect(markdown).toContain("+30%"); // throughput up 30%
    expect(markdown).toContain("up"); // verdict marker
  });

  it("renders the em-dash placeholder for a new workload's null deltas", () => {
    const after = results(run("fresh", 100, 10));
    const comparison = compareRuns({}, after); // no baseline → new

    const markdown = renderMarkdown({ recordedAt, results: after }, comparison);

    expect(markdown).toContain("—");
    expect(markdown).toContain("new");
  });

  it("emits a regression note when a workload regressed", () => {
    const before = results(run("a", 100, 10));
    const after = results(run("a", 40, 10)); // throughput collapsed
    const comparison = compareRuns(before, after);

    const markdown = renderMarkdown({ recordedAt, results: after }, comparison);

    expect(markdown).toContain("regressed beyond the threshold");
    expect(markdown).toContain("down");
  });

  it("renders 'flat' for an unchanged workload and no regression note", () => {
    const before = results(run("a", 100, 100));
    const after = results(run("a", 101, 100));
    const comparison = compareRuns(before, after);

    const markdown = renderMarkdown({ recordedAt, results: after }, comparison);

    expect(markdown).toContain("flat");
    expect(markdown).not.toContain("regressed beyond the threshold");
  });

  it("includes a ref line when the report carries a ref", () => {
    const markdown = renderMarkdown({
      recordedAt,
      ref: "abc123",
      results: results(run("a", 1, 1)),
    });

    expect(markdown).toContain("ref: `abc123`");
  });

  it("omits the ref line when there is no ref", () => {
    const markdown = renderMarkdown({ recordedAt, results: results(run("a", 1, 1)) });

    expect(markdown).not.toContain("ref:");
  });
});

describe("renderJson", () => {
  it("produces sorted, pretty-printed, newline-terminated JSON", () => {
    const report: Report = { recordedAt, results: results(run("zeta", 1, 1), run("alpha", 2, 2)) };

    const json = renderJson(report);

    expect(json.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(json) as Report;
    // Keys are canonicalized in sorted order.
    expect(Object.keys(parsed.results)).toEqual(["alpha", "zeta"]);
    expect(parsed.recordedAt).toBe(recordedAt);
  });

  it("includes the ref in the canonical JSON when present", () => {
    const json = renderJson({ recordedAt, ref: "deadbeef", results: results(run("a", 1, 1)) });

    expect(JSON.parse(json).ref).toBe("deadbeef");
  });

  it("omits the ref key entirely when absent", () => {
    const json = renderJson({ recordedAt, results: results(run("a", 1, 1)) });

    expect(Object.keys(JSON.parse(json))).not.toContain("ref");
  });
});

describe("parseBaseline", () => {
  it("round-trips a rendered report's results back into a baseline", () => {
    const report: Report = { recordedAt, results: results(run("a", 100, 10)) };
    const json = renderJson(report);

    const baseline = parseBaseline(json);

    expect(baseline.a?.stats.throughput).toBe(100);
  });
});

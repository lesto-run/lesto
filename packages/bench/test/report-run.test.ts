import { describe, expect, it } from "vitest";

import { runReport } from "../src/index";

import type { ReportIo } from "../src/index";

/** A fake IO that records writes and lets a test inject the baseline + clock. */
function fakeIo(baseline: string | null): {
  io: ReportIo;
  writes: { markdown?: string; json?: string };
  logs: string[];
} {
  const writes: { markdown?: string; json?: string } = {};
  const logs: string[] = [];

  const io: ReportIo = {
    readBaseline: async () => baseline,
    writeMarkdown: async (markdown) => {
      writes.markdown = markdown;
    },
    writeJson: async (json) => {
      writes.json = json;
    },
    log: (line) => logs.push(line),
    now: () => new Date("2026-06-18T12:00:00.000Z"),
  };

  return { io, writes, logs };
}

// Tiny runs so the real subsystems (queue, SSR) execute fast in the test.
const fast = { iterations: 3, concurrency: 2, warmup: 1 } as const;

describe("runReport", () => {
  it("runs the full suite, writes both artifacts, and reports no regression on a first run", async () => {
    const { io, writes, logs } = fakeIo(null);

    const artifacts = await runReport(io, fast);

    // All three workloads ran and are present in the report.
    expect(Object.keys(artifacts.report.results).toSorted()).toEqual([
      "http-inproc",
      "queue-claim",
      "ssr-render",
    ]);

    // Both tracked artifacts were written, matching the returned strings.
    expect(writes.markdown).toBe(artifacts.markdown);
    expect(writes.json).toBe(artifacts.json);
    expect(writes.markdown).toContain("# Lesto benchmark results");

    // First run: no baseline, nothing regressed, every workload reads "new".
    expect(artifacts.regressed).toBe(false);
    expect(artifacts.markdown).toContain("new");
    expect(logs.some((line) => line.startsWith("Running benchmark suite"))).toBe(true);
  });

  it("stamps the report timestamp from the injected clock", async () => {
    const { io } = fakeIo(null);

    const artifacts = await runReport(io, fast);

    expect(artifacts.report.recordedAt).toBe("2026-06-18T12:00:00.000Z");
  });

  it("records a ref when supplied", async () => {
    const { io } = fakeIo(null);

    const artifacts = await runReport(io, { ...fast, ref: "feature-x" });

    expect(artifacts.report.ref).toBe("feature-x");
    expect(artifacts.markdown).toContain("ref: `feature-x`");
  });

  it("diffs against a recorded baseline and flags a regression", async () => {
    // A baseline whose queue throughput is astronomically high, so this run's
    // real (far lower) number reads as a regression.
    const baseline = JSON.stringify({
      recordedAt: "2026-06-01T00:00:00.000Z",
      results: {
        "queue-claim": {
          name: "queue-claim",
          iterations: 3,
          concurrency: 2,
          stats: {
            count: 3,
            throughput: 1_000_000_000,
            elapsedMs: 1,
            min: 0,
            mean: 0.001,
            p50: 0.001,
            p99: 0.001,
            max: 0.001,
          },
        },
      },
    });
    const { io, logs } = fakeIo(baseline);

    const artifacts = await runReport(io, fast);

    expect(artifacts.regressed).toBe(true);
    expect(logs).toContain("Regression detected against the recorded baseline.");
    expect(artifacts.markdown).toContain("regressed beyond the threshold");
  });

  it("uses the defaults when no options are supplied", async () => {
    // The default suite is large (200 ops/workload), so this is the slow path —
    // kept as a single assertion that the defaults wire through without error.
    const { io } = fakeIo(null);

    const artifacts = await runReport(io);

    expect(artifacts.report.results["http-inproc"]?.iterations).toBe(200);
    expect(artifacts.report.results["http-inproc"]?.concurrency).toBe(4);
  }, 60_000);
});

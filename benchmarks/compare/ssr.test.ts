import { describe, expect, test } from "bun:test";

import { runBench } from "@lesto/bench";

import {
  DEFAULT_SSR_ROWS,
  expectedSsrMarkup,
  lestoRegistrySsrSample,
  preactSsrSample,
  reactSsrSample,
  renderLestoRegistrySsr,
  renderPreactSsr,
  renderReactSsr,
} from "./ssr";

describe("SSR equivalence — the comparison is only fair if every path emits the same HTML", () => {
  test("every render path emits byte-identical markup", () => {
    const oracle = expectedSsrMarkup();

    expect(renderLestoRegistrySsr()).toBe(oracle);
    expect(renderReactSsr()).toBe(oracle);
    expect(renderPreactSsr()).toBe(oracle);
  });

  test("equivalence holds at a different row count", () => {
    const oracle = expectedSsrMarkup(7);

    expect(renderLestoRegistrySsr(7)).toBe(oracle);
    expect(renderReactSsr(7)).toBe(oracle);
    expect(renderPreactSsr(7)).toBe(oracle);
  });

  test("the oracle actually scales with the row count", () => {
    expect(expectedSsrMarkup(DEFAULT_SSR_ROWS).length).toBeGreaterThan(expectedSsrMarkup(1).length);
  });
});

describe("SSR samples drive measurable runs", () => {
  test("each sample runs through the bench runner without throwing", async () => {
    const samples = [lestoRegistrySsrSample(4), reactSsrSample(4), preactSsrSample(4)];
    for (const sample of samples) {
      const run = await runBench(sample, { name: "ssr", iterations: 5, warmup: 1 });

      expect(run.stats.count).toBe(5);
      expect(run.stats.throughput).toBeGreaterThan(0);
    }
  });
});

import { describe, expect, test } from "bun:test";

import { runBench } from "@lesto/bench";

import {
  buildFindMyWayMatcher,
  buildLestoMatcher,
  findMyWayRouterSample,
  lestoRouterSample,
  REQUESTS,
} from "./router";

describe("router parity — the comparison is only fair if both routers make the SAME decisions", () => {
  test("Lesto and find-my-way resolve every request to the same hit/miss", async () => {
    const lesto = buildLestoMatcher();
    const fmw = await buildFindMyWayMatcher();

    if (fmw === null) {
      // find-my-way absent (offline) — nothing to cross-check; the Lesto resolver
      // must still return a defined result (index or null) for every request.
      for (const [method, path] of REQUESTS) {
        expect(lesto(method, path)).not.toBeUndefined();
      }

      return;
    }

    for (const [method, path] of REQUESTS) {
      expect(fmw(method, path)).toBe(lesto(method, path));
    }
  });

  test("the request stream exercises both hits and the guaranteed miss", () => {
    const lesto = buildLestoMatcher();
    const results = REQUESTS.map(([method, path]) => lesto(method, path));

    expect(results.some((r) => r !== null)).toBe(true); // at least one hit
    expect(results.some((r) => r === null)).toBe(true); // the `/nope/...` miss
  });
});

describe("router samples", () => {
  test("the Lesto route-match sample resolves the request stream without throwing", async () => {
    const run = await runBench(lestoRouterSample(), {
      name: "lesto-router",
      iterations: 5,
      warmup: 1,
    });

    expect(run.stats.count).toBe(5);
    expect(run.stats.throughput).toBeGreaterThan(0);
  });

  test("the find-my-way sample is either a runnable source or a graceful skip", async () => {
    const sample = await findMyWayRouterSample();

    // `find-my-way` is dynamically imported: present → a usable source, absent → null.
    // Either is correct; what must never happen is a throw on a missing import.
    if (sample === null) {
      expect(sample).toBeNull();

      return;
    }

    const run = await runBench(sample, { name: "fmw-router", iterations: 5, warmup: 1 });
    expect(run.stats.count).toBe(5);
  });
});

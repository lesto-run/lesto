import { describe, expect, test } from "bun:test";

import { runBench } from "@lesto/bench";

import { buildDispatchContenders, DISPATCH_ORACLE } from "./dispatch";

describe("dispatch contenders", () => {
  test("lesto-bare is always present; installed competitors are appended", async () => {
    const contenders = await buildDispatchContenders();
    const names = contenders.map((c) => c.name);

    // lesto-bare (secure:false routing only) is the Lesto contender; a secure-on
    // in-process row would just measure rate-limit 429s, so it is intentionally absent.
    expect(names[0]).toBe("lesto-bare");
    expect(names).not.toContain("lesto");
    expect(new Set(names).size).toBe(names.length); // no duplicates
    for (const name of names) {
      expect(["lesto-bare", "hono", "elysia", "fastify"]).toContain(name);
    }
  });

  test("every contender emits the SAME body bytes (the parity that makes a comparison fair)", async () => {
    const contenders = await buildDispatchContenders();

    for (const contender of contenders) {
      expect(await contender.read("json")).toBe(DISPATCH_ORACLE.json);
      expect(await contender.read("plaintext")).toBe(DISPATCH_ORACLE.plaintext);
    }
  });

  test("each contender's samples drive a measurable run", async () => {
    const contenders = await buildDispatchContenders();

    for (const contender of contenders) {
      const run = await runBench(contender.json, {
        name: contender.name,
        iterations: 5,
        warmup: 1,
      });
      expect(run.stats.count).toBe(5);
      expect(run.stats.throughput).toBeGreaterThan(0);
    }
  });
});

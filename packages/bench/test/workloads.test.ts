import { describe, expect, it } from "vitest";

import {
  createQueueWorkload,
  createSsrWorkload,
  httpWorkload,
  inprocHttpHandler,
  runBench,
} from "../src/index";

import type { HttpHandler } from "../src/index";

describe("httpWorkload", () => {
  it("issues a request through the handler and drains the body", async () => {
    const seen: string[] = [];
    const handler: HttpHandler = (request) => {
      seen.push(request.url);

      return new Response("body");
    };

    const source = httpWorkload(handler, "http://example.test/x");
    await source();

    expect(seen).toEqual(["http://example.test/x"]);
  });

  it("defaults the URL and accepts an async handler", async () => {
    let calls = 0;
    const handler: HttpHandler = async () => {
      calls += 1;

      return new Response("ok");
    };

    await httpWorkload(handler)();

    expect(calls).toBe(1);
  });

  it("inprocHttpHandler returns a 200 'ok'", async () => {
    const response = await inprocHttpHandler(new Request("http://x/"));

    expect(await response.text()).toBe("ok");
  });

  it("drives a measurable run through the runner", async () => {
    const result = await runBench(httpWorkload(inprocHttpHandler), {
      name: "http",
      iterations: 5,
    });

    expect(result.stats.count).toBe(5);
    expect(result.stats.throughput).toBeGreaterThan(0);
  });
});

describe("createQueueWorkload", () => {
  it("seeds jobs and claims one real row per sample", async () => {
    const { source, close } = await createQueueWorkload(3);

    try {
      // Three seeded jobs → three successful samples without throwing.
      await source();
      await source();
      await source();
    } finally {
      close();
    }

    expect(true).toBe(true);
  });

  it("reports genuine claims/sec through the runner", async () => {
    const fixture = await createQueueWorkload(8);

    try {
      const result = await runBench(fixture.source, {
        name: "queue",
        iterations: 6,
        concurrency: 2,
      });

      expect(result.stats.count).toBe(6);
      expect(result.stats.p99).toBeGreaterThanOrEqual(0);
    } finally {
      fixture.close();
    }
  });
});

describe("createSsrWorkload", () => {
  it("renders the component tree to a string on each sample", async () => {
    const source = createSsrWorkload();

    // It does not throw and runs a measurable number of renders.
    const result = await runBench(source, { name: "ssr", iterations: 4, concurrency: 1 });

    expect(result.stats.count).toBe(4);
  });
});

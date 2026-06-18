import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  InMemoryExporter,
  OtlpHttpExporter,
  otlpTraceRequest,
  randomHexId,
  systemClock,
  Tracer,
} from "../src/index";

import type { Clock, SpanData } from "../src/index";

// A clock we can stop, so every `startedAt` / `endedAt` is deterministic.
let now: number;
const clock: Clock = () => now;
const advance = (ms: number): void => {
  now += ms;
};

// A counting id-generator, so trace and span ids are predictable in order.
let counter: number;
const idGenerator = (): string => `id-${++counter}`;

let exporter: InMemoryExporter;
let tracer: Tracer;

beforeEach(() => {
  now = 1_000;
  counter = 0;
  exporter = new InMemoryExporter();
  tracer = new Tracer({ exporter, clock, idGenerator });
});

describe("startSpan", () => {
  it("roots a fresh trace with a spanId and no parentSpanId", () => {
    const span = tracer.startSpan("handle_request");

    // First id mints the traceId, second the spanId.
    expect(span.data.traceId).toBe("id-1");
    expect(span.data.spanId).toBe("id-2");
    expect(span.data.parentSpanId).toBeUndefined();

    expect(span.data.name).toBe("handle_request");
    expect(span.data.startedAt).toBe(1_000);
    expect(span.data.endedAt).toBeUndefined();
    expect(span.data.status).toBe("unset");
    expect(span.data.attributes).toEqual({});
  });

  it("nests a child under its parent's trace, pointing back at the parent span", () => {
    const root = tracer.startSpan("root"); // id-1 (trace), id-2 (span)
    const child = tracer.startSpan("child", { parent: root }); // id-3 (span only)

    expect(child.data.traceId).toBe(root.data.traceId);
    expect(child.data.parentSpanId).toBe(root.data.spanId);
    expect(child.data.spanId).toBe("id-3");
  });

  it("seeds attributes passed at start", () => {
    const span = tracer.startSpan("q", { attributes: { rows: 12 } });

    expect(span.data.attributes).toEqual({ rows: 12 });
  });
});

describe("span mutation", () => {
  it("chains setAttribute and setStatus, mutating the data", () => {
    const span = tracer.startSpan("op");

    const returned = span.setAttribute("user", "ada").setStatus("ok");

    expect(returned).toBe(span); // fluent: every setter returns this
    expect(span.data.attributes).toEqual({ user: "ada" });
    expect(span.data.status).toBe("ok");
  });
});

describe("end", () => {
  it("stamps endedAt from the clock and exports exactly once", () => {
    const span = tracer.startSpan("op");

    advance(50);
    span.end();

    expect(span.data.endedAt).toBe(1_050);
    expect(exporter.spans).toHaveLength(1);
    expect(exporter.spans[0]).toBe(span.data);
  });

  it("is idempotent: a second end() neither re-exports nor restamps the end time", () => {
    const span = tracer.startSpan("op");

    advance(50);
    span.end();

    // A later, redundant end() must be a no-op — the span is already closed.
    advance(50);
    span.end();

    expect(exporter.spans).toHaveLength(1);
    expect(span.data.endedAt).toBe(1_050);
  });
});

describe("withSpan", () => {
  it("runs fn, ends the span, and returns the value", async () => {
    const result = await tracer.withSpan("work", (span) => {
      span.setStatus("ok");
      advance(10);

      return 42;
    });

    expect(result).toBe(42);
    expect(exporter.spans).toHaveLength(1);

    const exported = exporter.spans[0] as SpanData;
    expect(exported.name).toBe("work");
    expect(exported.status).toBe("ok");
    expect(exported.endedAt).toBe(1_010);
  });

  it("on a throwing fn sets status error, ends the span, and rethrows", async () => {
    const boom = new Error("boom");

    await expect(
      tracer.withSpan("risky", () => {
        throw boom;
      }),
    ).rejects.toBe(boom);

    expect(exporter.spans).toHaveLength(1);

    const exported = exporter.spans[0] as SpanData;
    expect(exported.status).toBe("error");
    expect(exported.endedAt).toBe(1_000);
  });

  it("threads a parent through to the started span", async () => {
    const root = tracer.startSpan("root");

    await tracer.withSpan("child", () => undefined, { parent: root });

    const exported = exporter.spans[0] as SpanData;
    expect(exported.traceId).toBe(root.data.traceId);
    expect(exported.parentSpanId).toBe(root.data.spanId);
  });
});

describe("InMemoryExporter", () => {
  it("collects spans in the order they end", () => {
    const a = tracer.startSpan("a");
    const b = tracer.startSpan("b");

    a.end();
    b.end();

    expect(exporter.spans.map((s) => s.name)).toEqual(["a", "b"]);
  });
});

describe("defaults", () => {
  it("falls back to the system clock and random hex id-generator", () => {
    // Construct a Tracer with ONLY an exporter, exercising both `??` defaults.
    const bare = new Tracer({ exporter });

    const before = Date.now();
    const span = bare.startSpan("default");
    const after = Date.now();

    // Random hex ids: 16 bytes -> 32 hex chars, and trace != span.
    expect(span.data.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span.data.spanId).toMatch(/^[0-9a-f]{32}$/);
    expect(span.data.traceId).not.toBe(span.data.spanId);

    // System clock: startedAt sits within the window around construction.
    expect(span.data.startedAt).toBeGreaterThanOrEqual(before);
    expect(span.data.startedAt).toBeLessThanOrEqual(after);
  });

  it("exposes the default id-generator and clock directly", () => {
    expect(randomHexId()).toMatch(/^[0-9a-f]{32}$/);
    expect(typeof systemClock()).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// OTLP/HTTP export: the mapping, pinned byte-for-byte, and the shipping seam.
// ---------------------------------------------------------------------------

/** A finished span with every field populated, for the mapping test. */
const fullSpan: SpanData = {
  traceId: "a".repeat(32),
  spanId: "b".repeat(32),
  parentSpanId: "c".repeat(32),
  name: "http.request",
  startedAt: 1_000,
  endedAt: 1_250,
  attributes: {
    "http.method": "GET",
    "http.status_code": 200,
    ratio: 0.5,
    cached: true,
    weird: { nested: true },
  },
  status: "ok",
};

describe("otlpTraceRequest", () => {
  it("maps a batch to the OTLP JSON shape a collector accepts", () => {
    expect(otlpTraceRequest([fullSpan], "estate")).toEqual({
      resourceSpans: [
        {
          resource: {
            attributes: [{ key: "service.name", value: { stringValue: "estate" } }],
          },
          scopeSpans: [
            {
              scope: { name: "@volo/observability" },
              spans: [
                {
                  traceId: "a".repeat(32),
                  // Span ids truncate to OTLP's 16 hex chars; the traceId is full-width.
                  spanId: "b".repeat(16),
                  parentSpanId: "c".repeat(16),
                  name: "http.request",
                  kind: 2,
                  startTimeUnixNano: "1000000000",
                  endTimeUnixNano: "1250000000",
                  attributes: [
                    { key: "http.method", value: { stringValue: "GET" } },
                    { key: "http.status_code", value: { intValue: "200" } },
                    { key: "ratio", value: { doubleValue: 0.5 } },
                    { key: "cached", value: { boolValue: true } },
                    { key: "weird", value: { stringValue: "[object Object]" } },
                  ],
                  status: { code: 1 },
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it("roots, unfinished spans, and error/unset statuses map honestly", () => {
    const root: SpanData = {
      traceId: "t".repeat(32),
      spanId: "s".repeat(32),
      name: "boom",
      startedAt: 5,
      attributes: {},
      status: "error",
    };

    const mapped = otlpTraceRequest([root, { ...root, status: "unset" }], "volo") as {
      resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<Record<string, unknown>> }> }>;
    };

    const [first, second] = mapped.resourceSpans[0]!.scopeSpans[0]!.spans;

    // No parent → no parentSpanId key; never-ended → end falls back to start.
    expect(first).not.toHaveProperty("parentSpanId");
    expect(first?.["endTimeUnixNano"]).toBe("5000000");
    expect(first?.["status"]).toEqual({ code: 2 });
    expect(second?.["status"]).toEqual({ code: 0 });
  });
});

/** A fetch stub that records its calls and answers with `status`. */
function fakeFetch(status: number): {
  fetchFn: typeof fetch;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];

  const fetchFn = ((url: string, init: RequestInit) => {
    calls.push({ url, init });

    return Promise.resolve({ ok: status < 400, status } as Response);
  }) as unknown as typeof fetch;

  return { fetchFn, calls };
}

describe("OtlpHttpExporter", () => {
  it("buffers spans and ships the batch on flush, then starts empty again", async () => {
    const { fetchFn, calls } = fakeFetch(200);

    const otlp = new OtlpHttpExporter({
      url: "http://collector:4318/v1/traces",
      headers: { authorization: "Bearer t" },
      serviceName: "estate",
      fetchFn,
    });

    const otlpTracer = new Tracer({
      exporter: otlp,
      clock: () => 7,
      idGenerator: () => "f".repeat(32),
    });

    otlpTracer.startSpan("one").end();
    otlpTracer.startSpan("two").end();

    await otlp.flush();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://collector:4318/v1/traces");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.headers).toEqual({
      "content-type": "application/json",
      authorization: "Bearer t",
    });

    const body = JSON.parse(calls[0]?.init.body as string) as {
      resourceSpans: Array<{ scopeSpans: Array<{ spans: unknown[] }> }>;
    };

    expect(body.resourceSpans[0]?.scopeSpans[0]?.spans).toHaveLength(2);

    // The buffer drained: a second flush has nothing to say and says nothing.
    await otlp.flush();

    expect(calls).toHaveLength(1);
  });

  it("routes a non-2xx response to onError and drops the batch", async () => {
    const { fetchFn } = fakeFetch(503);

    const errors: unknown[] = [];

    const otlp = new OtlpHttpExporter({
      url: "http://collector/v1/traces",
      fetchFn,
      onError: (error) => errors.push(error),
    });

    otlp.export(fullSpan);

    await otlp.flush();

    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain("OTLP export failed: 503 for 1 span(s)");
  });

  it("routes a network throw to onError — telemetry never takes the app down", async () => {
    const sunk = new Error("ECONNREFUSED");

    const errors: unknown[] = [];

    const otlp = new OtlpHttpExporter({
      url: "http://collector/v1/traces",
      fetchFn: (() => Promise.reject(sunk)) as unknown as typeof fetch,
      onError: (error) => errors.push(error),
    });

    otlp.export(fullSpan);

    await expect(otlp.flush()).resolves.toBeUndefined();
    expect(errors).toEqual([sunk]);
  });

  it("uses the global fetch when none is injected", async () => {
    const calls: string[] = [];

    vi.stubGlobal("fetch", ((url: string) => {
      calls.push(url);

      return Promise.resolve({ ok: true, status: 200 } as Response);
    }) as unknown as typeof fetch);

    try {
      const otlp = new OtlpHttpExporter({ url: "http://collector/v1/traces" });

      otlp.export(fullSpan);

      await otlp.flush();

      expect(calls).toEqual(["http://collector/v1/traces"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports through console.error by default", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const otlp = new OtlpHttpExporter({
      url: "http://collector/v1/traces",
      fetchFn: (() => Promise.reject(new Error("down"))) as unknown as typeof fetch,
    });

    otlp.export(fullSpan);

    await otlp.flush();

    expect(spy).toHaveBeenCalledWith("[volo/observability]", expect.any(Error));

    spy.mockRestore();
  });

  it("caps the buffer: drops the oldest span and counts the drop when full", async () => {
    const { fetchFn, calls } = fakeFetch(200);

    // A tiny ceiling so the cap is reached deterministically.
    const otlp = new OtlpHttpExporter({
      url: "http://collector/v1/traces",
      fetchFn,
      maxBufferedSpans: 2,
    });

    const span = (name: string): SpanData => ({ ...fullSpan, name });

    otlp.export(span("a"));
    otlp.export(span("b"));

    // The third arrival evicts the oldest ("a"), counting one drop.
    otlp.export(span("c"));

    expect(otlp.dropped).toBe(1);

    await otlp.flush();

    const body = JSON.parse(calls[0]?.init.body as string) as {
      resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ name: string }> }> }>;
    };

    const names = body.resourceSpans[0]?.scopeSpans[0]?.spans.map((s) => s.name);

    // "a" was dropped; the freshest two survive.
    expect(names).toEqual(["b", "c"]);
  });

  it("starts with a zero drop count and a default ceiling that does not drop under normal load", () => {
    const otlp = new OtlpHttpExporter({ url: "http://c/v1/traces" });

    expect(otlp.dropped).toBe(0);

    // A handful of spans is nowhere near the 10k default ceiling — no drops.
    for (let i = 0; i < 100; i++) otlp.export({ ...fullSpan, name: `n${i}` });

    expect(otlp.dropped).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The inbound-trace join: a span adopting a `traceparent`'s ids.
// ---------------------------------------------------------------------------

describe("startSpan with an inbound trace", () => {
  it("adopts the inbound traceId and points back at the inbound parentId", () => {
    const span = tracer.startSpan("http.request", {
      inbound: { traceId: "a".repeat(32), parentId: "b".repeat(16) },
    });

    expect(span.data.traceId).toBe("a".repeat(32));
    expect(span.data.parentSpanId).toBe("b".repeat(16));
    // The span still mints its OWN fresh spanId.
    expect(span.data.spanId).toBe("id-1");
  });

  it("a live parent wins over an inbound trace (a real span we own)", () => {
    const root = tracer.startSpan("root"); // id-1 trace, id-2 span

    const child = tracer.startSpan("child", {
      parent: root,
      inbound: { traceId: "z".repeat(32), parentId: "z".repeat(16) },
    });

    // The live parent's trace + span, NOT the inbound ids.
    expect(child.data.traceId).toBe(root.data.traceId);
    expect(child.data.parentSpanId).toBe(root.data.spanId);
  });
});

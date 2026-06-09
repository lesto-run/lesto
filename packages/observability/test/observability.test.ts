import { beforeEach, describe, expect, it } from "vitest";

import { InMemoryExporter, randomHexId, systemClock, Tracer } from "../src/index";

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

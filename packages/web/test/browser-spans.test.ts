import { describe, expect, it, vi } from "vitest";

import type { BrowserSpan } from "@lesto/observability";

import {
  BROWSER_SPANS_ROUTE,
  browserSpansHandler,
  defaultBrowserSpanSink,
  MAX_ATTRIBUTE_CHARS,
  MAX_BROWSER_SPANS_BYTES,
  normalizeBrowserSpan,
  normalizeBrowserSpans,
} from "../src/browser-spans";
import { Context } from "../src/handler-context";
import type { AnyLestoResponse, LestoRequest } from "../src/types";

// A valid browser span body the browser would POST (string-keyed, as it arrives JSON).
const VALID = {
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  spanId: "00f067aa0ba902b7",
  parentSpanId: "0102030405060708",
  name: "browser.navigation",
  startedAt: 1000,
  endedAt: 1120,
  attributes: { "browser.load_ms": 120, "browser.resource_path": "/client.js" },
  status: 1,
};

/** Build a Context around a POST body, the way a route handler receives it. */
function postContext(body: unknown): Context {
  const request: LestoRequest = {
    method: "POST",
    path: BROWSER_SPANS_ROUTE,
    params: {},
    query: {},
    headers: {},
    body,
  };

  return new Context(request);
}

/** Invoke the terminal handler (its `next` must never run). */
function call(handler: ReturnType<typeof browserSpansHandler>, body: unknown): AnyLestoResponse {
  return handler(postContext(body), () => {
    throw new Error("next must not be called");
  }) as AnyLestoResponse;
}

// ---------------------------------------------------------------------------
// normalizeBrowserSpan — one span, leniently, dropping anything unjoinable.
// ---------------------------------------------------------------------------

describe("normalizeBrowserSpan", () => {
  it("reads a complete span verbatim", () => {
    expect(normalizeBrowserSpan(VALID)).toEqual({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      parentSpanId: "0102030405060708",
      name: "browser.navigation",
      startedAt: 1000,
      endedAt: 1120,
      attributes: { "browser.load_ms": 120, "browser.resource_path": "/client.js" },
      status: 1,
    });
  });

  it("drops a non-object span entry", () => {
    expect(normalizeBrowserSpan("nope")).toBeUndefined();
    expect(normalizeBrowserSpan(null)).toBeUndefined();
    expect(normalizeBrowserSpan(["array"])).toBeUndefined();
  });

  it("drops a span with a malformed or missing trace id (unjoinable)", () => {
    expect(normalizeBrowserSpan({ ...VALID, traceId: "short" })).toBeUndefined();
    expect(normalizeBrowserSpan({ ...VALID, traceId: undefined })).toBeUndefined();
  });

  it("drops a span with a malformed span id", () => {
    expect(normalizeBrowserSpan({ ...VALID, spanId: "ZZZ" })).toBeUndefined();
  });

  it("drops a span missing either timestamp", () => {
    expect(normalizeBrowserSpan({ ...VALID, startedAt: undefined })).toBeUndefined();
    expect(normalizeBrowserSpan({ ...VALID, endedAt: -1 })).toBeUndefined();
    expect(normalizeBrowserSpan({ ...VALID, startedAt: Number.NaN })).toBeUndefined();
  });

  it("omits a malformed parentSpanId rather than carrying it (browser-rooted span)", () => {
    const span = normalizeBrowserSpan({ ...VALID, parentSpanId: "garbage" });

    expect(span).toBeDefined();
    expect(span?.parentSpanId).toBeUndefined();
  });

  it("keeps a valid parentSpanId", () => {
    expect(normalizeBrowserSpan(VALID)?.parentSpanId).toBe("0102030405060708");
  });

  it("defaults a missing/non-string name to a generic marker", () => {
    const noName = { ...VALID } as Record<string, unknown>;
    delete noName["name"];

    expect(normalizeBrowserSpan(noName)?.name).toBe("browser.span");
    expect(normalizeBrowserSpan({ ...VALID, name: 42 })?.name).toBe("browser.span");
  });

  it("caps an over-long name", () => {
    const longName = "n".repeat(MAX_ATTRIBUTE_CHARS + 50);

    expect(normalizeBrowserSpan({ ...VALID, name: longName })?.name).toHaveLength(
      MAX_ATTRIBUTE_CHARS,
    );
  });

  it("keeps only number and (capped) string attributes, dropping the rest", () => {
    const longValue = "v".repeat(MAX_ATTRIBUTE_CHARS + 10);

    const span = normalizeBrowserSpan({
      ...VALID,
      attributes: {
        n: 5,
        s: "ok",
        long: longValue,
        bad: { nested: true },
        nope: null,
        inf: Number.POSITIVE_INFINITY,
      },
    });

    expect(span?.attributes).toEqual({
      n: 5,
      s: "ok",
      long: "v".repeat(MAX_ATTRIBUTE_CHARS),
    });
  });

  it("treats a non-object attributes field as an empty bag", () => {
    expect(normalizeBrowserSpan({ ...VALID, attributes: "nope" })?.attributes).toEqual({});
    expect(normalizeBrowserSpan({ ...VALID, attributes: ["x"] })?.attributes).toEqual({});
  });

  it("keeps a valid OTLP status code and defaults an invalid one to ok", () => {
    expect(normalizeBrowserSpan({ ...VALID, status: 0 })?.status).toBe(0);
    expect(normalizeBrowserSpan({ ...VALID, status: 2 })?.status).toBe(2);
    // 7 is not a valid code → defaults to ok (1).
    expect(normalizeBrowserSpan({ ...VALID, status: 7 })?.status).toBe(1);
    expect(normalizeBrowserSpan({ ...VALID, status: "bad" })?.status).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// normalizeBrowserSpans — the batch, dropping the unjoinable entries.
// ---------------------------------------------------------------------------

describe("normalizeBrowserSpans", () => {
  it("normalizes the joinable spans and drops the rest", () => {
    const spans = normalizeBrowserSpans({
      spans: [VALID, { ...VALID, traceId: "short" }, { ...VALID, spanId: "00f067aa0ba90299" }],
    });

    expect(spans).toHaveLength(2);
    expect(spans.map((s) => s.spanId)).toEqual(["00f067aa0ba902b7", "00f067aa0ba90299"]);
  });

  it("is empty when `spans` is not an array", () => {
    expect(normalizeBrowserSpans({})).toEqual([]);
    expect(normalizeBrowserSpans({ spans: "nope" })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// defaultBrowserSpanSink — one structured JSON line per span.
// ---------------------------------------------------------------------------

describe("defaultBrowserSpanSink", () => {
  it("writes one structured, PII-free JSON line", () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const span: BrowserSpan = {
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      parentSpanId: "0102030405060708",
      name: "browser.resource",
      startedAt: 2000,
      endedAt: 2042,
      attributes: { "browser.resource_path": "/client.js" },
      status: 1,
    };

    defaultBrowserSpanSink(span);

    expect(JSON.parse(infoSpy.mock.calls[0]?.[0] as string)).toEqual({
      level: "info",
      event: "browser.span",
      name: "browser.resource",
      trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
      span_id: "00f067aa0ba902b7",
      parent_span_id: "0102030405060708",
      started_at: 2000,
      ended_at: 2042,
      attributes: { "browser.resource_path": "/client.js" },
    });

    infoSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// browserSpansHandler — the route.
// ---------------------------------------------------------------------------

describe("browserSpansHandler", () => {
  it("normalizes a batch, forwards each span to the sink, and answers a bodiless 204", () => {
    const seen: BrowserSpan[] = [];

    const handler = browserSpansHandler((span) => seen.push(span));

    const response = call(handler, { v: 1, traceId: VALID.traceId, spans: [VALID] });

    expect(response).toEqual({ status: 204, headers: {}, body: "" });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.name).toBe("browser.navigation");
  });

  it("forwards only the joinable spans, dropping the malformed ones", () => {
    const seen: BrowserSpan[] = [];

    const handler = browserSpansHandler((span) => seen.push(span));

    call(handler, { spans: [VALID, { traceId: "short" }] });

    expect(seen).toHaveLength(1);
  });

  it("refuses a non-object body with a 400, never reaching the sink", () => {
    const seen: BrowserSpan[] = [];

    const handler = browserSpansHandler((span) => seen.push(span));

    expect(call(handler, "not-an-object")).toMatchObject({ status: 400 });
    expect(call(handler, ["array"])).toMatchObject({ status: 400 });
    expect(call(handler, null)).toMatchObject({ status: 400 });

    expect(seen).toEqual([]);
  });

  it("refuses an oversized payload with a coded 413, never reaching the sink", () => {
    const seen: BrowserSpan[] = [];

    const handler = browserSpansHandler((span) => seen.push(span));

    // A name whose JSON form pushes the whole payload over the cap.
    const huge = {
      spans: [{ ...VALID, name: "x".repeat(MAX_BROWSER_SPANS_BYTES + 100) }],
    };

    const response = call(handler, huge);

    expect(response.status).toBe(413);
    expect(response.headers["x-lesto-error"]).toBe("WEB_BROWSER_SPANS_BODY_TOO_LARGE");
    expect(seen).toEqual([]);
  });

  it("accepts a payload comfortably under the size boundary", () => {
    const seen: BrowserSpan[] = [];

    const handler = browserSpansHandler((span) => seen.push(span));

    const response = call(handler, { spans: [VALID] });

    expect(response.status).toBe(204);
    expect(seen).toHaveLength(1);
  });

  it("treats an un-serializable body as size-zero, then normalizes it as an object", () => {
    const seen: BrowserSpan[] = [];

    const handler = browserSpansHandler((span) => seen.push(span));

    // A circular object cannot serialize: jsonByteLength returns undefined, so the
    // size check is skipped — but it IS a plain object, so it normalizes (no `spans`
    // array → no spans) and answers 204.
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;

    const response = call(handler, circular);

    expect(response.status).toBe(204);
    expect(seen).toEqual([]);
  });

  it("treats a body that serializes to undefined (a non-object) as a 400", () => {
    const seen: BrowserSpan[] = [];

    const handler = browserSpansHandler((span) => seen.push(span));

    expect(call(handler, undefined).status).toBe(400);
    expect(seen).toEqual([]);
  });
});

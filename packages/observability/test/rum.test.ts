// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BROWSER_SPANS_PATH,
  BrowserTracer,
  browserRumEnvironment,
  BrowserVitals,
  CLS_SESSION_GAP_MS,
  CLS_SESSION_WINDOW_MS,
  DEFAULT_RUM_SAMPLE_RATE,
  defaultSendBrowserSpans,
  readTraceparentMeta,
  shouldSampleRum,
  startBrowserRum,
  TRACEPARENT_META_NAME,
  VITAL_SCORE_SCALE,
  wrapFetch,
} from "../src/rum";
import type { BrowserSpansPayload, RumEnvironment } from "../src/rum";
import type { Traceparent } from "../src/traceparent";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

// A caller's trace in the W3C spec's example shape, reused across cases.
const SERVER_TRACE: Traceparent = {
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  parentId: "00f067aa0ba902b7",
  flags: "01",
};

/** A counting span-id generator so minted ids are predictable in order. */
function countingSpanIds(): () => string {
  let n = 0;

  return () => `span${(++n).toString().padStart(12, "0")}`;
}

/** A typed fetch double recording each call's `(input, init)` pair. */
function recordingFetch(): {
  fetchImpl: typeof fetch;
  calls: { input: RequestInfo | URL; init: RequestInit | undefined }[];
} {
  const calls: { input: RequestInfo | URL; init: RequestInit | undefined }[] = [];

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });

    return new Response("ok");
  }) as typeof fetch;

  return { fetchImpl, calls };
}

// ---------------------------------------------------------------------------
// shouldSampleRum — the bounded-sampling gate (mirrors the beacon's).
// ---------------------------------------------------------------------------

describe("shouldSampleRum", () => {
  it("never samples at rate <= 0 without consulting random", () => {
    const random = vi.fn(() => 0);

    expect(shouldSampleRum(0, random)).toBe(false);
    expect(shouldSampleRum(-1, random)).toBe(false);
    expect(random).not.toHaveBeenCalled();
  });

  it("always samples at rate >= 1 without consulting random", () => {
    const random = vi.fn(() => 0.99);

    expect(shouldSampleRum(1, random)).toBe(true);
    expect(shouldSampleRum(2, random)).toBe(true);
    expect(random).not.toHaveBeenCalled();
  });

  it("is a single random() < rate draw in between", () => {
    expect(shouldSampleRum(0.5, () => 0.4)).toBe(true);
    expect(shouldSampleRum(0.5, () => 0.6)).toBe(false);
  });

  it("exposes a conservative 10% default", () => {
    expect(DEFAULT_RUM_SAMPLE_RATE).toBe(0.1);
  });
});

// ---------------------------------------------------------------------------
// readTraceparentMeta — adopt the SSR-injected server trace.
// ---------------------------------------------------------------------------

describe("readTraceparentMeta", () => {
  it("parses a valid traceparent meta into the server trace", () => {
    const meta = document.createElement("meta");
    meta.setAttribute("name", TRACEPARENT_META_NAME);
    meta.setAttribute("content", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
    document.head.appendChild(meta);

    expect(readTraceparentMeta()).toEqual(SERVER_TRACE);
  });

  it("is undefined when the meta is absent (a static page, an untraced app)", () => {
    expect(readTraceparentMeta()).toBeUndefined();
  });

  it("is undefined when the meta has no content attribute", () => {
    const meta = document.createElement("meta");
    meta.setAttribute("name", TRACEPARENT_META_NAME);
    document.head.appendChild(meta);

    expect(readTraceparentMeta()).toBeUndefined();
  });

  it("is undefined when the meta content is malformed (strict parse)", () => {
    const meta = document.createElement("meta");
    meta.setAttribute("name", TRACEPARENT_META_NAME);
    meta.setAttribute("content", "not-a-traceparent");
    document.head.appendChild(meta);

    expect(readTraceparentMeta()).toBeUndefined();
  });

  it("is undefined off-document (no `document` global)", () => {
    vi.stubGlobal("document", undefined);

    expect(readTraceparentMeta()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// BrowserTracer — the pure span-building core.
// ---------------------------------------------------------------------------

describe("BrowserTracer", () => {
  const tracerOptions = {
    timeOrigin: 1000,
    origin: "https://app.test",
    randomSpanId: countingSpanIds(),
    randomTraceId: () => "ffffffffffffffffffffffffffffffff",
  };

  it("adopts the inbound server trace id and parents on the request span", () => {
    const tracer = new BrowserTracer({ inbound: SERVER_TRACE, ...tracerOptions });

    expect(tracer.traceId).toBe(SERVER_TRACE.traceId);

    const span = tracer.vitalSpan("LCP", 2500, 40, "ms");

    expect(span.traceId).toBe(SERVER_TRACE.traceId);
    expect(span.parentSpanId).toBe(SERVER_TRACE.parentId);
  });

  it("roots a fresh browser trace when no inbound traceparent is present", () => {
    const tracer = new BrowserTracer({ inbound: undefined, ...tracerOptions });

    expect(tracer.traceId).toBe("ffffffffffffffffffffffffffffffff");

    // A rooted span has no parent — the browser trace stands alone.
    const span = tracer.vitalSpan("layout-shift", 100, 10, "score_x1000");

    expect(span.parentSpanId).toBeUndefined();
  });

  it("builds a navigation span from the phase marks (epoch ms from timeOrigin)", () => {
    const tracer = new BrowserTracer({ inbound: SERVER_TRACE, ...tracerOptions });

    const span = tracer.navigationSpan({
      entryType: "navigation",
      name: "https://app.test/",
      startTime: 0,
      duration: 0,
      domainLookupStart: 1,
      domainLookupEnd: 6,
      connectStart: 6,
      connectEnd: 26,
      secureConnectionStart: 16,
      requestStart: 26,
      responseStart: 56,
      responseEnd: 76,
      domContentLoadedEventEnd: 96,
      loadEventEnd: 120,
    });

    expect(span.name).toBe("browser.navigation");
    expect(span.startedAt).toBe(1000); // timeOrigin + startTime(0), rounded
    expect(span.endedAt).toBe(1120); // timeOrigin + loadEventEnd(120)
    expect(span.attributes["browser.dns_ms"]).toBe(5);
    expect(span.attributes["browser.tcp_ms"]).toBe(20);
    expect(span.attributes["browser.tls_ms"]).toBe(10); // connectEnd - secureConnectionStart
    expect(span.attributes["browser.request_ms"]).toBe(30);
    expect(span.attributes["browser.response_ms"]).toBe(20);
    expect(span.attributes["browser.dom_ms"]).toBe(20);
    expect(span.attributes["browser.load_ms"]).toBe(120);
    expect(span.status).toBe(1);
  });

  it("records no TLS phase for a plain-HTTP load (secureConnectionStart 0)", () => {
    const tracer = new BrowserTracer({ inbound: SERVER_TRACE, ...tracerOptions });

    const span = tracer.navigationSpan({
      entryType: "navigation",
      name: "http://app.test/",
      startTime: 0,
      duration: 0,
      domainLookupStart: 0,
      domainLookupEnd: 0,
      connectStart: 0,
      connectEnd: 10,
      secureConnectionStart: 0,
      requestStart: 10,
      responseStart: 20,
      responseEnd: 30,
      domContentLoadedEventEnd: 40,
      loadEventEnd: 50,
    });

    expect(span.attributes["browser.tls_ms"]).toBe(0);
  });

  it("builds a same-origin resource span, stripped to its path", () => {
    const tracer = new BrowserTracer({ inbound: SERVER_TRACE, ...tracerOptions });

    const span = tracer.resourceSpan({
      entryType: "resource",
      name: "https://app.test/client.js?v=3",
      startTime: 100,
      duration: 42,
      initiatorType: "script",
    });

    expect(span).toBeDefined();
    expect(span?.name).toBe("browser.resource");
    // The query string (where per-user values hide) is dropped; only the path stays.
    expect(span?.attributes["browser.resource_path"]).toBe("/client.js");
    expect(span?.attributes["browser.initiator"]).toBe("script");
    expect(span?.attributes["browser.duration_ms"]).toBe(42);
    expect(span?.startedAt).toBe(1100);
    expect(span?.endedAt).toBe(1142);
  });

  it("drops a cross-origin resource (no PII-safe path to record)", () => {
    const tracer = new BrowserTracer({ inbound: SERVER_TRACE, ...tracerOptions });

    const span = tracer.resourceSpan({
      entryType: "resource",
      name: "https://cdn.other.test/analytics.js",
      startTime: 5,
      duration: 9,
      initiatorType: "script",
    });

    expect(span).toBeUndefined();
  });

  it("drops a resource whose URL the parser rejects", () => {
    const tracer = new BrowserTracer({ inbound: SERVER_TRACE, ...tracerOptions });

    const span = tracer.resourceSpan({
      entryType: "resource",
      name: "http://[bad",
      startTime: 5,
      duration: 9,
      initiatorType: "fetch",
    });

    expect(span).toBeUndefined();
  });

  it("builds a zero-width vital span carrying the rounded value and its UNIT", () => {
    const tracer = new BrowserTracer({ inbound: SERVER_TRACE, ...tracerOptions });

    const span = tracer.vitalSpan("LCP", 2500.7, 40, "ms");

    expect(span.name).toBe("browser.web_vital");
    expect(span.attributes["browser.vital"]).toBe("LCP");
    expect(span.attributes["browser.value"]).toBe(2501);
    // The number alone cannot say whether it is ms or a ×1000 layout score — a
    // consumer reads the unit off the span rather than knowing which vitals scale.
    expect(span.attributes["browser.value_unit"]).toBe("ms");
    // A vital is a measurement, not a window: zero-width.
    expect(span.startedAt).toBe(span.endedAt);
    expect(span.startedAt).toBe(1040);
  });
});

// ---------------------------------------------------------------------------
// wrapFetch — outbound traceparent on same-origin requests only.
// ---------------------------------------------------------------------------

describe("wrapFetch", () => {
  const base = {
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    origin: "https://app.test",
    randomSpanId: () => "aaaaaaaaaaaaaaaa",
  };

  it("stamps an outbound traceparent on a same-origin string URL", async () => {
    const { fetchImpl, calls } = recordingFetch();
    const wrapped = wrapFetch({ ...base, fetchImpl });

    await wrapped("/lab/api/listings/3");

    const headers = new Headers(calls[0]?.init?.headers);

    expect(headers.get("traceparent")).toBe(
      "00-4bf92f3577b34da6a3ce929d0e0e4736-aaaaaaaaaaaaaaaa-01",
    );
  });

  it("resolves a same-origin Request object via its .url", async () => {
    const { fetchImpl, calls } = recordingFetch();
    const wrapped = wrapFetch({ ...base, fetchImpl });

    await wrapped(new Request("https://app.test/data"));

    expect(new Headers(calls[0]?.init?.headers).get("traceparent")).toContain("4bf92f");
  });

  it("preserves a Request object's own headers when stamping (no init)", async () => {
    const { fetchImpl, calls } = recordingFetch();
    const wrapped = wrapFetch({ ...base, fetchImpl });

    await wrapped(new Request("https://app.test/data", { headers: { authorization: "Bearer t" } }));

    // fetch(request, { headers }) would replace the Request's headers wholesale;
    // wrapFetch must keep them and ADD the traceparent, not drop the Authorization.
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer t");
    expect(headers.get("traceparent")).toContain("4bf92f");
  });

  it("never stamps a cross-origin request (no trace-id leak)", async () => {
    const { fetchImpl, calls } = recordingFetch();
    const wrapped = wrapFetch({ ...base, fetchImpl });

    await wrapped("https://cdn.other.test/asset.js");

    // Passed through verbatim — no init injected, no traceparent.
    expect(calls[0]?.input).toBe("https://cdn.other.test/asset.js");
    expect(calls[0]?.init).toBeUndefined();
  });

  it("passes an unparseable URL through untouched", async () => {
    const { fetchImpl, calls } = recordingFetch();
    const wrapped = wrapFetch({ ...base, fetchImpl });

    await wrapped("http://[bad");

    expect(calls[0]?.input).toBe("http://[bad");
    expect(calls[0]?.init).toBeUndefined();
  });

  it("never overwrites a traceparent the caller already set", async () => {
    const { fetchImpl, calls } = recordingFetch();
    const wrapped = wrapFetch({ ...base, fetchImpl });

    await wrapped("/data", { headers: { traceparent: "00-caller-trace-set-01" } });

    expect(new Headers(calls[0]?.init?.headers).get("traceparent")).toBe("00-caller-trace-set-01");
  });
});

// ---------------------------------------------------------------------------
// defaultSendBrowserSpans — the same-origin POST transport.
// ---------------------------------------------------------------------------

describe("defaultSendBrowserSpans", () => {
  const payload: BrowserSpansPayload = {
    v: 1,
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    spans: [],
  };

  it("POSTs the payload to the browser-spans path with keepalive", () => {
    const fetchSpy = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    vi.stubGlobal("fetch", fetchSpy);

    defaultSendBrowserSpans(payload);

    expect(fetchSpy).toHaveBeenCalledWith(
      BROWSER_SPANS_PATH,
      expect.objectContaining({ method: "POST", keepalive: true }),
    );
  });

  it("swallows a rejected fetch (a dead beacon never throws on the page)", async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error("offline")));
    vi.stubGlobal("fetch", fetchSpy);

    expect(() => defaultSendBrowserSpans(payload)).not.toThrow();

    // Let the rejected promise's `.catch` settle so it is not an unhandled rejection.
    await Promise.resolve();
  });
});

// ---------------------------------------------------------------------------
// startBrowserRum — the orchestration, driven by an injected environment.
// ---------------------------------------------------------------------------

/** Build a fake environment whose observer the test fires by hand. */
function fakeEnvironment(overrides: Partial<RumEnvironment> = {}): {
  environment: RumEnvironment;
  fire: (entries: readonly unknown[]) => void;
  /** Drive the page-hide seam — the moment the lifetime vitals are published. */
  hide: () => void;
  disconnects: number;
  pageHideUnregisters: number;
  sent: BrowserSpansPayload[];
  observed: { type: string; buffered?: boolean; durationThreshold?: number }[];
} {
  let callback: ((entries: readonly unknown[]) => void) | undefined;
  let onHide: (() => void) | undefined;
  let disconnects = 0;
  let pageHideUnregisters = 0;
  const sent: BrowserSpansPayload[] = [];
  const observed: { type: string; buffered?: boolean; durationThreshold?: number }[] = [];

  const environment: RumEnvironment = {
    readTraceparent: () => SERVER_TRACE,
    timeOrigin: 1000,
    createObserver: (cb) => {
      callback = cb as (entries: readonly unknown[]) => void;

      return {
        observe: (options) => void observed.push(options),
        disconnect: () => {
          disconnects += 1;
        },
      };
    },
    send: (payload) => sent.push(payload),
    random: () => 0,
    randomSpanId: countingSpanIds(),
    randomTraceId: () => "ffffffffffffffffffffffffffffffff",
    onPageHide: (cb) => {
      onHide = cb;

      return () => {
        pageHideUnregisters += 1;
      };
    },
    ...overrides,
  };

  return {
    environment,
    fire: (entries) => callback?.(entries as never),
    hide: () => onHide?.(),
    get disconnects() {
      return disconnects;
    },
    get pageHideUnregisters() {
      return pageHideUnregisters;
    },
    sent,
    observed,
  };
}

// ---------------------------------------------------------------------------
// BrowserVitals — the two LIFETIME metrics. Neither is a property of one entry,
// which is exactly how RUM got them wrong: it published a single `first-input`
// entry as "INP" and never summed a layout shift at all.
// ---------------------------------------------------------------------------

describe("BrowserVitals — INP", () => {
  it("is undefined before any interaction", () => {
    expect(new BrowserVitals().inp()).toBeUndefined();
  });

  it("is the LONGEST interaction, not the first and not the last", () => {
    const vitals = new BrowserVitals();

    vitals.recordInteraction(24, 100);
    vitals.recordInteraction(310, 900);
    vitals.recordInteraction(48, 1_500);

    // The old behaviour would have reported 24 (the first input) — a page whose
    // every later interaction janked would have read green.
    expect(vitals.inp()).toEqual({ value: 310, at: 900 });
  });

  it("keeps the worst even when a later interaction ties it", () => {
    const vitals = new BrowserVitals();

    vitals.recordInteraction(200, 10);
    vitals.recordInteraction(200, 20);

    // A tie does not move the timestamp — the first occurrence is the one measured.
    expect(vitals.inp()).toEqual({ value: 200, at: 10 });
  });
});

describe("BrowserVitals — CLS", () => {
  it("is undefined before any shift", () => {
    expect(new BrowserVitals().cls()).toBeUndefined();
  });

  it("sums shifts that fall inside one session window", () => {
    const vitals = new BrowserVitals();

    vitals.recordLayoutShift(0.03, 100);
    vitals.recordLayoutShift(0.04, 500);
    vitals.recordLayoutShift(0.02, 900);

    expect(vitals.cls()?.value).toBeCloseTo(0.09, 10);
    expect(vitals.cls()?.at).toBe(900);
  });

  it("starts a NEW session after a gap, and reports the MAX session — not the total", () => {
    const vitals = new BrowserVitals();

    // Session 1: 0.05 total.
    vitals.recordLayoutShift(0.02, 0);
    vitals.recordLayoutShift(0.03, 500);

    // A gap longer than the inter-shift limit opens session 2: 0.10 total.
    vitals.recordLayoutShift(0.1, 500 + CLS_SESSION_GAP_MS + 1);

    // The page total is 0.15; CLS is the WORST SESSION, which is 0.10.
    expect(vitals.cls()?.value).toBeCloseTo(0.1, 10);
  });

  it("keeps the earlier session when it is the worst one", () => {
    const vitals = new BrowserVitals();

    vitals.recordLayoutShift(0.4, 0);
    vitals.recordLayoutShift(0.05, CLS_SESSION_GAP_MS + 1);

    expect(vitals.cls()).toEqual({ value: 0.4, at: 0 });
  });

  it("caps a session at the 5s window even when every shift is within 1s of the last", () => {
    // The second window rule, which a naive gap-only implementation drops: a
    // steady drizzle of shifts would otherwise accumulate forever into one session.
    const vitals = new BrowserVitals();

    for (let at = 0; at <= CLS_SESSION_WINDOW_MS; at += 500) {
      vitals.recordLayoutShift(0.01, at);
    }

    // 11 shifts × 0.01 = 0.11 if it were one session. The window closes at 5s, so
    // the last shift opens a fresh session and the worst session is the first ten.
    expect(vitals.cls()?.value).toBeCloseTo(0.1, 10);
  });
});

describe("startBrowserRum", () => {
  it("does nothing (no observer) when the session is not sampled", () => {
    let created = false;

    const dispose = startBrowserRum({
      sampleRate: 0,
      environment: fakeEnvironment({
        random: () => 0.5,
        createObserver: () => {
          created = true;

          return { observe: () => {}, disconnect: () => {} };
        },
      }).environment,
    });

    expect(created).toBe(false);
    // Always returns a disposer, even on the no-op path.
    expect(() => dispose()).not.toThrow();
  });

  it("does nothing when PerformanceObserver is unsupported", () => {
    const { environment, sent } = fakeEnvironment({ createObserver: undefined });

    const dispose = startBrowserRum({ sampleRate: 1, environment });

    expect(sent).toHaveLength(0);
    expect(() => dispose()).not.toThrow();
  });

  it("maps each observed entry type to a span and POSTs them under the server trace", () => {
    const harness = fakeEnvironment();

    startBrowserRum({ sampleRate: 1, environment: harness.environment });

    harness.fire([
      {
        entryType: "navigation",
        name: "https://app.test/",
        startTime: 0,
        duration: 0,
        domainLookupStart: 0,
        domainLookupEnd: 4,
        connectStart: 4,
        connectEnd: 10,
        secureConnectionStart: 0,
        requestStart: 10,
        responseStart: 20,
        responseEnd: 30,
        domContentLoadedEventEnd: 40,
        loadEventEnd: 50,
      },
      {
        // Same-origin to jsdom's `http://localhost:3000` so the resource span is
        // kept; `startBrowserRum` resolves the origin from `location`, not the fixture.
        entryType: "resource",
        name: "http://localhost:3000/client.js",
        startTime: 5,
        duration: 9,
        initiatorType: "script",
      },
      { entryType: "largest-contentful-paint", name: "", startTime: 1200, duration: 0 },
      { entryType: "first-input", name: "", startTime: 1300, duration: 12 },
      {
        entryType: "layout-shift",
        name: "",
        startTime: 1400,
        duration: 0,
        value: 0.05,
        hadRecentInput: false,
      },
    ]);

    expect(harness.sent).toHaveLength(1);

    const payload = harness.sent[0] as BrowserSpansPayload;
    expect(payload.traceId).toBe(SERVER_TRACE.traceId);

    const names = payload.spans.map((span) => span.name);
    expect(names).toEqual([
      "browser.navigation",
      "browser.resource",
      "browser.web_vital",
      "browser.web_vital",
      "browser.web_vital",
    ]);

    // Every span joins the server trace and parents on the request span.
    for (const span of payload.spans) {
      expect(span.traceId).toBe(SERVER_TRACE.traceId);
      expect(span.parentSpanId).toBe(SERVER_TRACE.parentId);
    }

    const vitals = payload.spans.filter((span) => span.name === "browser.web_vital");
    // layout-shift is emitted RAW (per-shift) and named for what it is; the
    // cumulative CLS is a lifetime metric published at page hide, not here. The
    // first input is likewise named `first-input` — it was mislabelled "INP" for
    // its whole life, and INP is the worst interaction over the page, not the first.
    expect(vitals.map((span) => span.attributes["browser.vital"])).toEqual([
      "LCP",
      "first-input",
      "layout-shift",
    ]);
    expect(vitals.map((span) => span.attributes["browser.value_unit"])).toEqual([
      "ms",
      "ms",
      "score_x1000",
    ]);
  });

  it("excludes a layout-shift that followed recent input (per the CLS spec)", () => {
    const harness = fakeEnvironment();

    startBrowserRum({ sampleRate: 1, environment: harness.environment });

    harness.fire([
      {
        entryType: "layout-shift",
        name: "",
        startTime: 10,
        duration: 0,
        value: 0.2,
        hadRecentInput: true,
      },
    ]);

    // An excluded shift yields no span — and with no spans, no POST.
    expect(harness.sent).toHaveLength(0);
  });

  it("drops a cross-origin resource entry but still flushes the rest", () => {
    const harness = fakeEnvironment();

    startBrowserRum({ sampleRate: 1, environment: harness.environment });

    harness.fire([
      {
        entryType: "resource",
        name: "https://cdn.other.test/x.js",
        startTime: 1,
        duration: 2,
        initiatorType: "script",
      },
      { entryType: "largest-contentful-paint", name: "", startTime: 900, duration: 0 },
    ]);

    const payload = harness.sent[0] as BrowserSpansPayload;
    expect(payload.spans).toHaveLength(1);
    expect(payload.spans[0]?.name).toBe("browser.web_vital");
  });

  it("flushes pending spans and disconnects on dispose", () => {
    const harness = fakeEnvironment();

    const dispose = startBrowserRum({ sampleRate: 1, environment: harness.environment });

    dispose();

    // Nothing was pending, so dispose sends nothing, but it disconnects the observer.
    expect(harness.disconnects).toBe(1);
    expect(harness.sent).toHaveLength(0);
  });

  it("roots its own trace when there is no inbound traceparent meta", () => {
    const harness = fakeEnvironment({ readTraceparent: () => undefined });

    startBrowserRum({ sampleRate: 1, environment: harness.environment });

    harness.fire([
      { entryType: "largest-contentful-paint", name: "", startTime: 500, duration: 0 },
    ]);

    const payload = harness.sent[0] as BrowserSpansPayload;
    expect(payload.traceId).toBe("ffffffffffffffffffffffffffffffff");
    expect(payload.spans[0]?.parentSpanId).toBeUndefined();
  });

  it("uses the default environment + sample rate when none are passed", () => {
    // No options at all: `startBrowserRum` builds the default browserRumEnvironment
    // and uses DEFAULT_RUM_SAMPLE_RATE. Force the gate open with a low random draw,
    // then dispose — exercising the default-environment and default-rate branches.
    vi.spyOn(Math, "random").mockReturnValue(0.0);

    const dispose = startBrowserRum();

    expect(() => dispose()).not.toThrow();
  });

  it("falls back to a localhost origin when there is no `location` global", () => {
    vi.stubGlobal("location", undefined);

    const harness = fakeEnvironment();

    const dispose = startBrowserRum({ sampleRate: 1, environment: harness.environment });

    // A same-origin resource against the fallback origin is still recorded.
    harness.fire([
      {
        entryType: "resource",
        name: "http://localhost/x.js",
        startTime: 1,
        duration: 2,
        initiatorType: "script",
      },
    ]);

    expect(harness.sent[0]?.spans[0]?.name).toBe("browser.resource");
    expect(() => dispose()).not.toThrow();
  });

  it("tolerates an observe() that throws for an unsupported entry type", () => {
    let observed = 0;

    const environment: RumEnvironment = {
      ...fakeEnvironment().environment,
      createObserver: () => ({
        observe: () => {
          observed += 1;

          // First type supported, the rest throw — a partial-support browser.
          if (observed > 1) throw new Error("unsupported entry type");
        },
        disconnect: () => {},
      }),
    };

    expect(() => startBrowserRum({ sampleRate: 1, environment })).not.toThrow();
    // It attempted to observe every type despite the per-type throws.
    expect(observed).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// The page-hide finalization: where the two LIFETIME vitals are published. A
// metric defined over the whole page has no honest value until the page ends.
// ---------------------------------------------------------------------------

/** One `event`-timing entry, as the browser reports an interaction's events. */
const eventEntry = (
  duration: number,
  startTime: number,
  interactionId: number,
): Record<string, unknown> => ({
  entryType: "event",
  name: "pointerdown",
  startTime,
  duration,
  interactionId,
});

/** One CLS-eligible layout-shift entry. */
const shiftEntry = (value: number, startTime: number): Record<string, unknown> => ({
  entryType: "layout-shift",
  name: "",
  startTime,
  duration: 0,
  value,
  hadRecentInput: false,
});

describe("startBrowserRum — lifetime vitals at page hide", () => {
  it("observes `event` entries with a lowered duration threshold", () => {
    const harness = fakeEnvironment();

    startBrowserRum({ sampleRate: 1, environment: harness.environment });

    const event = harness.observed.find((options) => options.type === "event");

    // Without a threshold the browser reports only interactions over 104ms, so a
    // merely-slow one would never reach INP at all.
    expect(event).toEqual({ type: "event", buffered: true, durationThreshold: 40 });
    // Every type is buffered, so an entry from before the observer attached lands.
    expect(harness.observed.every((options) => options.buffered === true)).toBe(true);
  });

  it("emits ONE INP vital at page hide, valued by the WORST interaction", () => {
    const harness = fakeEnvironment();

    startBrowserRum({ sampleRate: 1, environment: harness.environment });

    harness.fire([eventEntry(24, 100, 1), eventEntry(310, 900, 2), eventEntry(48, 1_500, 3)]);

    // No span per event: three interactions, nothing on the wire yet.
    expect(harness.sent).toHaveLength(0);

    harness.hide();

    const vitals = harness.sent
      .flatMap((payload) => payload.spans)
      .filter((span) => span.attributes["browser.vital"] === "INP");

    expect(vitals).toHaveLength(1);
    expect(vitals[0]?.attributes["browser.value"]).toBe(310);
    expect(vitals[0]?.attributes["browser.value_unit"]).toBe("ms");
  });

  it("ignores an event that is not part of an interaction", () => {
    const harness = fakeEnvironment();

    startBrowserRum({ sampleRate: 1, environment: harness.environment });

    // `interactionId: 0` means the browser did not treat this event as a user
    // interaction — counting it would inflate INP with work no user waited on. A
    // browser that omits the field entirely is the same case, not a crash.
    harness.fire([
      eventEntry(500, 10, 0),
      { entryType: "event", name: "pointerdown", startTime: 20, duration: 400 },
    ]);
    harness.hide();

    expect(harness.sent).toHaveLength(0);
  });

  it("folds a `first-input` entry into INP, so a browser with no `event` support still reports one", () => {
    const harness = fakeEnvironment();

    startBrowserRum({ sampleRate: 1, environment: harness.environment });

    harness.fire([{ entryType: "first-input", name: "", startTime: 300, duration: 120 }]);
    harness.hide();

    const vitals = harness.sent
      .flatMap((payload) => payload.spans)
      .map((span) => span.attributes["browser.vital"]);

    // Its own honestly-named span at the time it happened, plus the lifetime INP.
    expect(vitals).toEqual(["first-input", "INP"]);
  });

  it("emits ONE CLS vital at page hide, valued by the max session sum, scaled", () => {
    const harness = fakeEnvironment();

    startBrowserRum({ sampleRate: 1, environment: harness.environment });

    // Session 1 sums to 0.05; a gap opens session 2, which sums to 0.10.
    harness.fire([
      shiftEntry(0.02, 0),
      shiftEntry(0.03, 500),
      shiftEntry(0.06, 2_000),
      shiftEntry(0.04, 2_400),
    ]);

    harness.hide();

    const spans = harness.sent.flatMap((payload) => payload.spans);

    // The raw per-shift spans still ship — the only per-event detail a debugger has.
    expect(
      spans.filter((span) => span.attributes["browser.vital"] === "layout-shift"),
    ).toHaveLength(4);

    const cls = spans.filter((span) => span.attributes["browser.vital"] === "CLS");

    expect(cls).toHaveLength(1);
    expect(cls[0]?.attributes["browser.value"]).toBe(Math.round(0.1 * VITAL_SCORE_SCALE));
    // Never a bare 0.1 rounded to 0 — and the wire says which convention it used.
    expect(cls[0]?.attributes["browser.value_unit"]).toBe("score_x1000");
  });

  it("keeps reporting after a tab switch — a hide is not the end of the page", () => {
    // The defect a one-shot latch has: a hide is ANY tab switch. Latch on the first
    // one and INP/CLS freeze at whatever the page managed in its first few seconds,
    // and the work the user actually came back to do is never reported.
    const harness = fakeEnvironment();

    startBrowserRum({ sampleRate: 1, environment: harness.environment });

    harness.fire([eventEntry(24, 100, 1), shiftEntry(0.02, 0)]);
    harness.hide();

    const first = harness.sent
      .flatMap((payload) => payload.spans)
      .filter((span) => span.attributes["browser.vital"] === "INP");

    expect(first).toHaveLength(1);
    expect(first[0]?.attributes["browser.value"]).toBe(24);

    // The user comes back and janks something badly, then leaves for real.
    harness.fire([eventEntry(310, 900, 2), shiftEntry(0.2, 8_000)]);
    harness.hide();

    const spans = harness.sent.flatMap((payload) => payload.spans);
    const inp = spans.filter((span) => span.attributes["browser.vital"] === "INP");
    const cls = spans.filter((span) => span.attributes["browser.vital"] === "CLS");

    // Both moved, so both re-report; the LAST is authoritative (both metrics are
    // running maxima, so last === max).
    expect(inp.map((span) => span.attributes["browser.value"])).toEqual([24, 310]);
    expect(cls.map((span) => span.attributes["browser.value"])).toEqual([20, 200]);
  });

  it("does not re-report a vital that only moved below the wire's resolution", () => {
    // The gate compares the value the wire carries, so two readings that round to
    // the same integer do not become two spans a consumer cannot tell apart.
    const harness = fakeEnvironment();

    startBrowserRum({ sampleRate: 1, environment: harness.environment });

    harness.fire([shiftEntry(0.0201, 0)]);
    harness.hide();

    harness.fire([shiftEntry(0.0001, 500)]);
    harness.hide();

    const cls = harness.sent
      .flatMap((payload) => payload.spans)
      .filter((span) => span.attributes["browser.vital"] === "CLS");

    // 0.0201 and 0.0202 both round to 20 on the ×1000 wire.
    expect(cls.map((span) => span.attributes["browser.value"])).toEqual([20]);
  });

  it("does not re-report a vital whose value did not move", () => {
    const harness = fakeEnvironment();

    startBrowserRum({ sampleRate: 1, environment: harness.environment });

    harness.fire([eventEntry(200, 10, 1)]);

    harness.hide();
    harness.hide();
    harness.hide();

    // Three hides, one span: the common page still gets exactly one INP.
    expect(
      harness.sent
        .flatMap((payload) => payload.spans)
        .filter((span) => span.attributes["browser.vital"] === "INP"),
    ).toHaveLength(1);
  });

  it("finalizes exactly once across a hide followed by a dispose", () => {
    const harness = fakeEnvironment();

    const dispose = startBrowserRum({ sampleRate: 1, environment: harness.environment });

    harness.fire([eventEntry(200, 10, 1), shiftEntry(0.2, 20)]);

    harness.hide();
    dispose();

    const vitals = harness.sent
      .flatMap((payload) => payload.spans)
      .map((span) => span.attributes["browser.vital"]);

    // Two INPs for one page would leave a consumer guessing which is the page's.
    expect(vitals.filter((name) => name === "INP")).toHaveLength(1);
    expect(vitals.filter((name) => name === "CLS")).toHaveLength(1);
  });

  it("finalizes on dispose even when the page never hid", () => {
    const harness = fakeEnvironment();

    const dispose = startBrowserRum({ sampleRate: 1, environment: harness.environment });

    harness.fire([eventEntry(200, 10, 1)]);

    dispose();

    expect(
      harness.sent
        .flatMap((payload) => payload.spans)
        .map((span) => span.attributes["browser.vital"]),
    ).toEqual(["INP"]);
  });

  it("emits neither vital on a page with no interaction and no shift", () => {
    const harness = fakeEnvironment();

    const dispose = startBrowserRum({ sampleRate: 1, environment: harness.environment });

    harness.hide();
    dispose();

    // Nothing measured, nothing invented, and so no POST at all.
    expect(harness.sent).toHaveLength(0);
  });

  it("falls back to the real browser page-hide seam when the environment omits one", () => {
    // `onPageHide` is optional, so an environment that predates it still gets the
    // lifetime vitals — through the real listener, driven here at its real target.
    const harness = fakeEnvironment();

    const { onPageHide: _omitted, ...withoutSeam } = harness.environment;

    const dispose = startBrowserRum({ sampleRate: 1, environment: withoutSeam });

    harness.fire([eventEntry(200, 10, 1)]);

    expect(harness.sent).toHaveLength(0);

    window.dispatchEvent(new Event("pagehide"));

    expect(
      harness.sent
        .flatMap((payload) => payload.spans)
        .map((span) => span.attributes["browser.vital"]),
    ).toEqual(["INP"]);

    // Real listeners were attached to the real window; take them back off, or a
    // later case in this file fires this one's callback too.
    dispose();
  });

  it("unregisters the page-hide listener and disconnects on dispose", () => {
    const harness = fakeEnvironment();

    const dispose = startBrowserRum({ sampleRate: 1, environment: harness.environment });

    dispose();

    expect(harness.pageHideUnregisters).toBe(1);
    expect(harness.disconnects).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// browserRumEnvironment — the default wiring off the live (jsdom) globals.
// ---------------------------------------------------------------------------

describe("browserRumEnvironment", () => {
  it("builds an environment with a working observer under jsdom", () => {
    const environment = browserRumEnvironment();

    expect(environment.createObserver).toBeDefined();
    expect(typeof environment.timeOrigin).toBe("number");

    // The default ids are real 16/32-hex strings drawn from crypto.
    expect(environment.randomSpanId()).toMatch(/^[0-9a-f]{16}$/);
    expect(environment.randomTraceId()).toMatch(/^[0-9a-f]{32}$/);
  });

  it("its observer forwards getEntries() to the callback", () => {
    // Stub `PerformanceObserver` with a fake that invokes its callback synchronously
    // when `observe()` is called — jsdom's real one never auto-fires, so this is the
    // only way to exercise the wrapper's `list.getEntries()` forwarding.
    let captured: ((list: { getEntries: () => unknown[] }) => void) | undefined;

    class FakeObserver {
      constructor(cb: (list: { getEntries: () => unknown[] }) => void) {
        captured = cb;
      }

      observe(): void {
        captured?.({ getEntries: () => [{ entryType: "navigation" }] });
      }

      disconnect(): void {}
    }

    vi.stubGlobal("PerformanceObserver", FakeObserver);

    const environment = browserRumEnvironment();

    const seen: unknown[] = [];

    const observer = environment.createObserver?.((entries) => {
      seen.push(...entries);
    });

    observer?.observe({ type: "navigation", buffered: true });

    expect(seen).toEqual([{ entryType: "navigation" }]);

    expect(() => observer?.disconnect()).not.toThrow();
  });

  it("falls back to a no-op observer when PerformanceObserver is absent", () => {
    vi.stubGlobal("PerformanceObserver", undefined);

    const environment = browserRumEnvironment();

    expect(environment.createObserver).toBeUndefined();
    // With no `performance`, timeOrigin reads 0.
    vi.stubGlobal("performance", undefined);
    expect(browserRumEnvironment().timeOrigin).toBe(0);
  });

  it("fires its page-hide callback on visibilitychange → hidden, never on visible", () => {
    const onPageHide = browserRumEnvironment().onPageHide as NonNullable<
      RumEnvironment["onPageHide"]
    >;

    let hides = 0;
    const stop = onPageHide(() => {
      hides += 1;
    });

    // jsdom reports "visible" by default; a change back to visible is not a hide.
    document.dispatchEvent(new Event("visibilitychange"));
    expect(hides).toBe(0);

    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(hides).toBe(1);

    // Put jsdom back: a stubbed `visibilityState` left behind changes what every
    // later case in this file observes.
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });

    // `pagehide` is dispatched at the WINDOW and never reaches the document — a
    // listener registered on the document there can never fire, so dispatching at
    // the real target is the whole point of this assertion.
    window.dispatchEvent(new Event("pagehide"));
    expect(hides).toBe(2);

    stop();

    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("pagehide"));
    expect(hides).toBe(2);
  });

  it("registers each listener on the target that actually dispatches it", () => {
    const onDocument = vi.spyOn(document, "addEventListener");
    const onWindow = vi.spyOn(window, "addEventListener");

    (browserRumEnvironment().onPageHide as NonNullable<RumEnvironment["onPageHide"]>)(() => {});

    // …and NO unload/beforeunload anywhere: either would disqualify the page from
    // the back/forward cache.
    expect(onDocument.mock.calls.map((call) => call[0])).toEqual(["visibilitychange"]);
    expect(onWindow.mock.calls.map((call) => call[0])).toEqual(["pagehide"]);
  });

  it("is a no-op page-hide seam with no document and no window (SSR, a bare test)", () => {
    vi.stubGlobal("document", undefined);
    vi.stubGlobal("window", undefined);

    const stop = (browserRumEnvironment().onPageHide as NonNullable<RumEnvironment["onPageHide"]>)(
      () => {
        throw new Error("must never fire");
      },
    );

    expect(() => stop()).not.toThrow();
  });

  it("falls back to Math.random ids when crypto.getRandomValues is absent", () => {
    vi.stubGlobal("crypto", undefined);
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5);

    const environment = browserRumEnvironment();

    expect(environment.randomSpanId()).toMatch(/^[0-9a-f]{16}$/);
    expect(environment.randomTraceId()).toMatch(/^[0-9a-f]{32}$/);
    expect(randomSpy).toHaveBeenCalled();
  });
});

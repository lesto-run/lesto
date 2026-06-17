// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BROWSER_SPANS_PATH,
  BrowserTracer,
  browserRumEnvironment,
  DEFAULT_RUM_SAMPLE_RATE,
  defaultSendBrowserSpans,
  readTraceparentMeta,
  shouldSampleRum,
  startBrowserRum,
  TRACEPARENT_META_NAME,
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

    const span = tracer.vitalSpan("LCP", 2500, 40);

    expect(span.traceId).toBe(SERVER_TRACE.traceId);
    expect(span.parentSpanId).toBe(SERVER_TRACE.parentId);
  });

  it("roots a fresh browser trace when no inbound traceparent is present", () => {
    const tracer = new BrowserTracer({ inbound: undefined, ...tracerOptions });

    expect(tracer.traceId).toBe("ffffffffffffffffffffffffffffffff");

    // A rooted span has no parent — the browser trace stands alone.
    const span = tracer.vitalSpan("CLS", 100, 10);

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

  it("builds a zero-width vital span carrying the rounded value", () => {
    const tracer = new BrowserTracer({ inbound: SERVER_TRACE, ...tracerOptions });

    const span = tracer.vitalSpan("LCP", 2500.7, 40);

    expect(span.name).toBe("browser.web_vital");
    expect(span.attributes["browser.vital"]).toBe("LCP");
    expect(span.attributes["browser.value"]).toBe(2501);
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
  disconnects: number;
  sent: BrowserSpansPayload[];
} {
  let callback: ((entries: readonly unknown[]) => void) | undefined;
  let disconnects = 0;
  const sent: BrowserSpansPayload[] = [];

  const environment: RumEnvironment = {
    readTraceparent: () => SERVER_TRACE,
    timeOrigin: 1000,
    createObserver: (cb) => {
      callback = cb as (entries: readonly unknown[]) => void;

      return {
        observe: () => {},
        disconnect: () => {
          disconnects += 1;
        },
      };
    },
    send: (payload) => sent.push(payload),
    random: () => 0,
    randomSpanId: countingSpanIds(),
    randomTraceId: () => "ffffffffffffffffffffffffffffffff",
    ...overrides,
  };

  return {
    environment,
    fire: (entries) => callback?.(entries as never),
    get disconnects() {
      return disconnects;
    },
    sent,
  };
}

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
    expect(vitals.map((span) => span.attributes["browser.vital"])).toEqual(["LCP", "INP", "CLS"]);
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

  it("falls back to Math.random ids when crypto.getRandomValues is absent", () => {
    vi.stubGlobal("crypto", undefined);
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5);

    const environment = browserRumEnvironment();

    expect(environment.randomSpanId()).toMatch(/^[0-9a-f]{16}$/);
    expect(environment.randomTraceId()).toMatch(/^[0-9a-f]{32}$/);
    expect(randomSpy).toHaveBeenCalled();
  });
});

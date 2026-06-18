/**
 * Browser RUM — the spans the BROWSER emits, stitched to the SERVER trace.
 *
 * ARCHITECTURE.md §7 promises "browser spans stitch to the server trace — the
 * thing no JS meta-framework ships." This module is the browser half of that
 * promise: a `PerformanceObserver`-driven client that turns the browser's own
 * timing records (navigation phases, resource fetches, Core Web Vitals) into
 * Lesto spans, and — crucially — ADOPTS the server request's `traceId` so a page
 * load lands UNDER the same `http.request` span the server already emitted. One
 * trace, UI → API → DB.
 *
 * The join is a `<meta name="lesto-traceparent" content="00-<traceId>-<spanId>-01">`
 * the SSR layer injects: the server stamps the request span's ids into the
 * document, the browser reads them ({@link readTraceparentMeta}), and every span
 * minted here uses that `traceId` and parents on that `spanId`. Absent the meta
 * (a static page, a non-traced app), the browser roots its OWN trace instead —
 * never crashing, just unparented.
 *
 * The same two rules the client-error beacon lives by hold here:
 *
 *   - **Bounded sampling.** A page must not turn every load into a span POST, so
 *     the session is gated by a configurable rate (default the same conservative
 *     {@link DEFAULT_RUM_SAMPLE_RATE} the beacon uses). The gate is `random() <
 *     rate`, with `random` injected so the rate is provable in a test.
 *   - **No PII, ever.** A span carries only same-origin resource URLs (stripped
 *     to path), W3C-standard timing numbers, and Web-Vital values — never a query
 *     string, never a cross-origin URL, never a header. An outbound `traceparent`
 *     is stamped on SAME-ORIGIN fetches only ({@link wrapFetch}), so the trace id
 *     never leaks to a third party.
 *
 * This file is BROWSER code: it touches `performance`, `PerformanceObserver`,
 * `document`, and `fetch`, all feature-detected so it is a silent no-op where
 * they are absent (SSR, an old browser, a test without jsdom). It takes no node
 * dependency, so `@lesto/assets` can inline it into the synthesized client entry.
 */

import { formatTraceparent, parseTraceparent } from "./traceparent";
import type { Traceparent } from "./traceparent";

/** Where finished browser spans POST — the receiver lives in `@lesto/web`. */
export const BROWSER_SPANS_PATH = "/__lesto/browser-spans";

/** The SSR-injected meta tag the browser reads its inbound traceparent from. */
export const TRACEPARENT_META_NAME = "lesto-traceparent";

/**
 * The default sampling rate: 10% of sessions emit browser spans.
 *
 * The same conservative default the client-error beacon takes, and for the same
 * reason — RUM exists to SAMPLE the field, not to mirror every navigation into a
 * span POST. An operator who wants denser data raises it; one watching a flood
 * lowers it.
 */
export const DEFAULT_RUM_SAMPLE_RATE = 0.1;

/**
 * One browser span, in the flat shape the receiver normalizes and the exporter
 * ships. A structural subset of `@lesto/observability`'s `SpanData` — the fields
 * a browser can author honestly: ids, name, the two epoch-ms timestamps, a small
 * PII-free attribute bag, and an OTLP status code (0 unset / 1 ok / 2 error).
 *
 * The browser does NOT speak the OTLP envelope; it POSTs these flat records and
 * the server-side receiver maps them onto the existing exporter, so they share
 * one collector and one trace id with the server spans.
 */
export interface BrowserSpan {
  /** The trace this span belongs to — the SERVER trace's id when the meta is present. */
  readonly traceId: string;

  /** This span's own id (16 hex — the width the OTLP wire and traceparent both use). */
  readonly spanId: string;

  /** The span this one points back at — the server request span, or a browser parent. */
  readonly parentSpanId?: string;

  /** The span name, e.g. `browser.navigation`, `browser.resource`, `browser.web_vital`. */
  readonly name: string;

  /** Epoch-ms start (derived from the performance entry's high-res time + the time origin). */
  readonly startedAt: number;

  /** Epoch-ms end. Equal to `startedAt` for a point-in-time vital with no duration. */
  readonly endedAt: number;

  /** A small PII-free attribute bag (timing numbers, a same-origin path, a vital value). */
  readonly attributes: Record<string, number | string>;

  /** OTLP status: 0 unset, 1 ok, 2 error. A browser span is `ok` (1) unless noted. */
  readonly status: 0 | 1 | 2;
}

/** The exact JSON body the browser POSTs to {@link BROWSER_SPANS_PATH}. */
export interface BrowserSpansPayload {
  /** Schema version, so the receiver can evolve the wire without a flag day. */
  readonly v: 1;

  /** The trace these spans belong to — the join key with the server `http.request` span. */
  readonly traceId: string;

  readonly spans: readonly BrowserSpan[];
}

/** The minimal `PerformanceObserver` surface this module drives (feature-detected). */
interface PerfObserverLike {
  observe(options: { type: string; buffered?: boolean }): void;

  disconnect(): void;
}

/** One performance entry, narrowed to the cross-type fields RUM reads off any entry. */
interface PerfEntryLike {
  readonly entryType: string;
  readonly name: string;
  readonly startTime: number;
  readonly duration: number;
}

/** A navigation-timing entry's phase marks (a `PerformanceNavigationTiming`, structurally). */
interface NavEntryLike extends PerfEntryLike {
  readonly domainLookupStart: number;
  readonly domainLookupEnd: number;
  readonly connectStart: number;
  readonly connectEnd: number;
  readonly secureConnectionStart: number;
  readonly requestStart: number;
  readonly responseStart: number;
  readonly responseEnd: number;
  readonly domContentLoadedEventEnd: number;
  readonly loadEventEnd: number;
}

/** A resource-timing entry, structurally (`initiatorType` distinguishes a script/fetch/img). */
interface ResourceEntryLike extends PerfEntryLike {
  readonly initiatorType: string;
}

/** A layout-shift entry, structurally — `value` is ONE shift's score (CLS is the cumulative sum of these, which RUM does not compute here). */
interface LayoutShiftLike extends PerfEntryLike {
  readonly value: number;
  readonly hadRecentInput: boolean;
}

/**
 * The browser globals RUM needs, injected so a test drives them without a real
 * browser. Each is optional: an absent one means "this capability is missing",
 * and {@link startBrowserRum} degrades to a silent no-op rather than throwing.
 */
export interface RumEnvironment {
  /** Reads the inbound traceparent meta — the SSR-injected `<meta name="lesto-traceparent">`. */
  readonly readTraceparent: () => Traceparent | undefined;

  /** The high-res clock origin (`performance.timeOrigin`) — added to entry times for epoch ms. */
  readonly timeOrigin: number;

  /** Constructs a `PerformanceObserver` over `callback`, or `undefined` if unsupported. */
  readonly createObserver:
    | ((callback: (entries: readonly PerfEntryLike[]) => void) => PerfObserverLike)
    | undefined;

  /** Where finished spans go — defaults to a same-origin POST; injected for tests. */
  readonly send: (payload: BrowserSpansPayload) => void;

  /** The sampling source — `Math.random` in the browser, a stub in tests. */
  readonly random: () => number;

  /** A fresh 16-hex span id. The browser draws from `crypto`; a test injects a counter. */
  readonly randomSpanId: () => string;

  /** A fresh 32-hex trace id, used only when no inbound traceparent roots the trace. */
  readonly randomTraceId: () => string;
}

/** Knobs the synthesized client entry passes through; all have safe defaults. */
export interface RumOptions {
  /** Fraction of sessions that emit spans, in `[0, 1]`. Defaults to {@link DEFAULT_RUM_SAMPLE_RATE}. */
  readonly sampleRate?: number;

  /** The browser environment, injected for tests. Defaults to {@link browserRumEnvironment}. */
  readonly environment?: RumEnvironment;
}

/**
 * The entry types RUM observes. `navigation` is the page load's phase timeline;
 * `resource` is each sub-resource fetch (island chunk, data fetch, image);
 * `largest-contentful-paint` (LCP) is a Core Web Vital. `layout-shift` entries are
 * emitted RAW (one span per eligible shift) — RUM does not sum them into the
 * cumulative CLS metric. `first-input` (INP's seed) is observed too. Each is
 * `buffered: true` so an entry that fired before the observer attached is still
 * delivered.
 */
const OBSERVED_TYPES = [
  "navigation",
  "resource",
  "largest-contentful-paint",
  "layout-shift",
  "first-input",
] as const;

/**
 * Decide whether this session emits, gated by the bounded rate.
 *
 * `rate <= 0` never emits; `rate >= 1` always does; in between it is a single
 * `random() < rate` draw. Mirrors the beacon's `shouldSample` so the two
 * browser-side gates behave identically. Exported so the gate is unit-testable.
 */
export function shouldSampleRum(rate: number, random: () => number): boolean {
  if (rate <= 0) return false;
  if (rate >= 1) return true;

  return random() < rate;
}

/**
 * Read the inbound traceparent the SSR layer injected as a meta tag.
 *
 * Looks up `<meta name="lesto-traceparent" content="00-…">` in the live document
 * and parses its content through the SAME strict `parseTraceparent` the server
 * uses — a malformed or absent meta yields `undefined`, and the browser roots its
 * own trace. Guarded for `document` so it is a safe no-op outside a browser.
 */
export function readTraceparentMeta(): Traceparent | undefined {
  if (typeof document === "undefined") return undefined;

  const meta = document.querySelector(`meta[name="${TRACEPARENT_META_NAME}"]`);

  // A meta with no content attribute reads as null → parseTraceparent's absent case.
  const content = meta?.getAttribute("content") ?? undefined;

  return parseTraceparent(content);
}

/** Strip a URL to its same-origin path, or `undefined` if it is cross-origin/unparseable. */
function sameOriginPath(url: string, origin: string): string | undefined {
  let parsed: URL;

  try {
    parsed = new URL(url, origin);
  } catch {
    // A URL the parser rejects carries no path we can trust — drop it entirely.
    return undefined;
  }

  // Cross-origin resources are never recorded: their path could carry a third
  // party's identifiers, and we never want RUM to widen the PII surface.
  if (parsed.origin !== origin) return undefined;

  // Path only — the query string is exactly where per-user values hide.
  return parsed.pathname;
}

/**
 * The span-building core: pure, given an inbound trace (or none) and the ids.
 *
 * Holds the trace context (the adopted server trace id + the request span as
 * parent, or a freshly-rooted browser trace) and turns each performance entry
 * into a {@link BrowserSpan}. Pure and injectable so every mapping branch is
 * unit-tested without a `PerformanceObserver`.
 */
export class BrowserTracer {
  /** The trace every span here joins — the server's, or a fresh browser root. */
  readonly traceId: string;

  /** The parent every top-level browser span points back at — the server request span, or none. */
  private readonly serverSpanId: string | undefined;

  private readonly timeOrigin: number;

  private readonly origin: string;

  private readonly randomSpanId: () => string;

  constructor(options: {
    readonly inbound: Traceparent | undefined;
    readonly timeOrigin: number;
    readonly origin: string;
    readonly randomSpanId: () => string;
    readonly randomTraceId: () => string;
  }) {
    // An inbound traceparent (the SSR meta) joins the SERVER trace and parents on
    // the request span; absent, we root a fresh browser trace with no parent.
    this.traceId = options.inbound?.traceId ?? options.randomTraceId();
    this.serverSpanId = options.inbound?.parentId;
    this.timeOrigin = options.timeOrigin;
    this.origin = options.origin;
    this.randomSpanId = options.randomSpanId;
  }

  /** A high-res entry time (ms since `timeOrigin`) → epoch ms, rounded for the wire. */
  private epoch(highRes: number): number {
    return Math.round(this.timeOrigin + highRes);
  }

  /** Mint one span parented on the server request span (or unparented when rooted). */
  private span(
    name: string,
    startTime: number,
    endTime: number,
    attributes: Record<string, number | string>,
  ): BrowserSpan {
    return {
      traceId: this.traceId,
      spanId: this.randomSpanId(),
      ...(this.serverSpanId === undefined ? {} : { parentSpanId: this.serverSpanId }),
      name,
      startedAt: this.epoch(startTime),
      endedAt: this.epoch(endTime),
      attributes,
      status: 1,
    };
  }

  /** Map a navigation-timing entry to one `browser.navigation` span carrying its phase marks. */
  navigationSpan(entry: NavEntryLike): BrowserSpan {
    // Each phase is a duration (ms), authored by the browser — pure timing, no PII.
    // A TLS handshake that never happened (plain HTTP) reports secureConnectionStart
    // as 0, so we only record the TLS phase when it actually occurred.
    const tlsMs =
      entry.secureConnectionStart > 0 ? entry.connectEnd - entry.secureConnectionStart : 0;

    return this.span("browser.navigation", entry.startTime, entry.loadEventEnd, {
      "browser.dns_ms": entry.domainLookupEnd - entry.domainLookupStart,
      "browser.tcp_ms": entry.connectEnd - entry.connectStart,
      "browser.tls_ms": tlsMs,
      "browser.request_ms": entry.responseStart - entry.requestStart,
      "browser.response_ms": entry.responseEnd - entry.responseStart,
      "browser.dom_ms": entry.domContentLoadedEventEnd - entry.responseEnd,
      "browser.load_ms": entry.loadEventEnd - entry.startTime,
    });
  }

  /**
   * Map a resource-timing entry to one `browser.resource` span, or `undefined`
   * when the resource is cross-origin (its path is dropped, so there is nothing
   * PII-safe to record). The island chunk and data fetch this captures are the
   * UI→API hop the trace is meant to show.
   */
  resourceSpan(entry: ResourceEntryLike): BrowserSpan | undefined {
    const path = sameOriginPath(entry.name, this.origin);

    if (path === undefined) return undefined;

    return this.span("browser.resource", entry.startTime, entry.startTime + entry.duration, {
      "browser.resource_path": path,
      "browser.initiator": entry.initiatorType,
      "browser.duration_ms": Math.round(entry.duration),
    });
  }

  /**
   * Map a Web-Vital entry (LCP / first-input for INP / a raw layout-shift) to a
   * point-in-time `browser.web_vital` span. A vital is a measurement, not a window,
   * so its span is zero-width (start == end) and carries the value as an attribute.
   */
  vitalSpan(name: string, value: number, at: number): BrowserSpan {
    return this.span("browser.web_vital", at, at, {
      "browser.vital": name,
      "browser.value": Math.round(value),
    });
  }
}

/** The default same-origin POST: fire-and-forget, `keepalive` so it survives unload. */
export function defaultSendBrowserSpans(payload: BrowserSpansPayload): void {
  // `keepalive` lets the POST outlive a navigation away (the spans still land);
  // a rejected fetch is swallowed — a dead RUM beacon must never throw on a page.
  void fetch(BROWSER_SPANS_PATH, {
    method: "POST",
    keepalive: true,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  }).catch(() => {});
}

/**
 * Wrap a `fetch` so SAME-ORIGIN requests carry an outbound `traceparent`.
 *
 * This is the UI→API propagation seam: an island/data fetch made through the
 * wrapped `fetch` stamps a W3C `traceparent` built from the browser trace's id +
 * a fresh child span id, so the SERVER handler joins the SAME trace the page is
 * already part of. The header is added ONLY for same-origin requests — stamping
 * it cross-origin would leak the trace id to a third party — and never overwrites
 * a `traceparent` the caller already set.
 *
 * `traceId` comes from the page's {@link BrowserTracer}; `spanId` is freshly
 * minted per call so each request points the server at its own child span.
 * `origin` and the `fetch` impl are injected so the same-origin decision and the
 * wrapping are unit-testable without a browser.
 */
export function wrapFetch(options: {
  readonly traceId: string;
  readonly origin: string;
  readonly randomSpanId: () => string;
  readonly fetchImpl: typeof fetch;
}): typeof fetch {
  const { traceId, origin, randomSpanId, fetchImpl } = options;

  const wrapped = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    // Resolve the request URL the same way the platform does, tolerating a
    // `Request` object, a `URL`, or a string. A URL we cannot parse is left
    // untouched — we never want the wrapper to break a fetch it can't classify.
    let url: URL | undefined;

    try {
      const raw = typeof input === "object" && "url" in input ? input.url : String(input);

      url = new URL(raw, origin);
    } catch {
      url = undefined;
    }

    // Cross-origin (or unparseable): pass through verbatim — never stamp the trace
    // id where it could leak to a third party.
    if (url === undefined || url.origin !== origin) return fetchImpl(input, init);

    // `fetch(input, init)` builds the request's headers from `init.headers` when
    // present, else from a Request `input` — it does NOT merge the two. Mirror that
    // so `fetch(new Request(url, { headers }))` keeps its own headers instead of
    // losing them all to the traceparent stamp.
    const headers = new Headers(
      typeof input === "object" && "url" in input && init?.headers === undefined
        ? input.headers
        : init?.headers,
    );

    // Never overwrite a traceparent the caller already set — they own propagation.
    // The outbound parent-id is THIS request's fresh child span; the server then
    // points its `http.request` span back at it, joining the page's trace.
    if (!headers.has("traceparent")) {
      headers.set("traceparent", formatTraceparent(traceId, randomSpanId()));
    }

    return fetchImpl(input, { ...init, headers });
  };

  return wrapped as typeof fetch;
}

/** Build the default browser environment from the live globals (feature-detected). */
export function browserRumEnvironment(): RumEnvironment {
  // `PerformanceObserver` is the capability gate: absent (an old browser, SSR, a
  // test without jsdom), `createObserver` is undefined and RUM is a silent no-op.
  const hasObserver =
    typeof PerformanceObserver !== "undefined" && typeof performance !== "undefined";

  const createObserver = hasObserver
    ? (callback: (entries: readonly PerfEntryLike[]) => void): PerfObserverLike => {
        const observer = new PerformanceObserver((list) => {
          callback(list.getEntries() as unknown as readonly PerfEntryLike[]);
        });

        return observer as unknown as PerfObserverLike;
      }
    : undefined;

  return {
    readTraceparent: readTraceparentMeta,
    timeOrigin: typeof performance === "undefined" ? 0 : performance.timeOrigin,
    createObserver,
    send: defaultSendBrowserSpans,
    random: Math.random,
    randomSpanId: () => randomHex(16),
    randomTraceId: () => randomHex(32),
  };
}

/**
 * A random lowercase-hex id of `chars` length, drawn from `crypto` when present.
 *
 * The browser ships `crypto.getRandomValues`; we draw `chars/2` bytes and render
 * them hex. Where `crypto` is absent (an ancient runtime) we fall back to
 * `Math.random` — RUM ids are correlation keys, not security tokens, so a weaker
 * source is acceptable for the fallback rather than failing the whole pipeline.
 */
function randomHex(chars: number): string {
  const bytes = chars / 2;

  const cryptoApi = typeof crypto === "undefined" ? undefined : crypto;

  if (cryptoApi?.getRandomValues !== undefined) {
    const buffer = new Uint8Array(bytes);

    cryptoApi.getRandomValues(buffer);

    return Array.from(buffer, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  let out = "";

  for (let i = 0; i < bytes; i++) {
    out += Math.floor(Math.random() * 256)
      .toString(16)
      .padStart(2, "0");
  }

  return out;
}

/**
 * The capability the dispatcher reads off each performance entry — which span
 * builder it maps to. Pure routing, factored out so the observe loop stays flat.
 */
function spanForEntry(tracer: BrowserTracer, entry: PerfEntryLike): BrowserSpan | undefined {
  if (entry.entryType === "navigation") {
    return tracer.navigationSpan(entry as NavEntryLike);
  }

  if (entry.entryType === "resource") {
    return tracer.resourceSpan(entry as ResourceEntryLike);
  }

  if (entry.entryType === "largest-contentful-paint") {
    return tracer.vitalSpan("LCP", entry.startTime, entry.startTime);
  }

  if (entry.entryType === "first-input") {
    // INP's seed: the first input's processing delay is its `duration`. The vital
    // is recorded at the input's start time, valued by that delay.
    return tracer.vitalSpan("INP", entry.duration, entry.startTime);
  }

  // A layout-shift WITHOUT recent input is CLS-eligible; one right after an input
  // is user-initiated and excluded by spec (an excluded shift yields no span). We
  // emit each eligible shift's RAW score under a `layout-shift` label — not a
  // `CLS` one — because the cumulative metric is a session-windowed sum this
  // dispatcher does not compute. (×1000 so a sub-unit score survives Math.round.)
  const shift = entry as LayoutShiftLike;

  if (shift.hadRecentInput) return undefined;

  return tracer.vitalSpan("layout-shift", shift.value * 1000, shift.startTime);
}

/**
 * Start browser RUM: observe the page's performance, build spans under the server
 * trace, and POST them.
 *
 * The lifecycle:
 *
 *   1. Gate on the sample rate — an unsampled session does nothing (no observer,
 *      no cost), exactly the bounded posture the beacon takes.
 *   2. Feature-detect `PerformanceObserver` — absent, return a no-op disposer.
 *   3. Read the SSR-injected traceparent meta; build a {@link BrowserTracer} that
 *      adopts the server trace id (or roots a fresh one).
 *   4. Observe navigation/resource/web-vital entries (buffered, so pre-attach
 *      entries still arrive), map each to a span, and POST batches.
 *
 * Returns a disposer that flushes any pending spans and disconnects the observer
 * — called on page hide so the last batch is not lost. Always returns a function,
 * even on the no-op paths, so a caller can dispose unconditionally.
 */
export function startBrowserRum(options: RumOptions = {}): () => void {
  const environment = options.environment ?? browserRumEnvironment();

  const rate = options.sampleRate ?? DEFAULT_RUM_SAMPLE_RATE;

  // Bounded sampling: an unsampled session is a true no-op — no observer attaches.
  if (!shouldSampleRum(rate, environment.random)) return () => {};

  const { createObserver } = environment;

  // No `PerformanceObserver` (old browser, SSR, a bare test): nothing to observe.
  if (createObserver === undefined) return () => {};

  const inbound = environment.readTraceparent();

  const origin = typeof location === "undefined" ? "http://localhost" : location.origin;

  const tracer = new BrowserTracer({
    inbound,
    timeOrigin: environment.timeOrigin,
    origin,
    randomSpanId: environment.randomSpanId,
    randomTraceId: environment.randomTraceId,
  });

  // The pending batch — flushed when the observer fires and once on dispose, so a
  // late entry (a layout shift just before the page hides) is not stranded.
  let pending: BrowserSpan[] = [];

  const flush = (): void => {
    if (pending.length === 0) return;

    const spans = pending;
    pending = [];

    environment.send({ v: 1, traceId: tracer.traceId, spans });
  };

  const observer = createObserver((entries) => {
    for (const entry of entries) {
      const span = spanForEntry(tracer, entry);

      if (span !== undefined) pending.push(span);
    }

    flush();
  });

  for (const type of OBSERVED_TYPES) {
    // A browser that lacks one entry type throws on `observe` for it; we tolerate
    // that per-type so the supported types still attach (a partial-support browser
    // still emits the vitals it can, rather than RUM failing wholesale).
    try {
      observer.observe({ type, buffered: true });
    } catch {
      // unsupported entry type on this browser — skip it, keep the rest
    }
  }

  return () => {
    flush();

    observer.disconnect();
  };
}

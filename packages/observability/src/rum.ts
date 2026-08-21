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
 * A vital comes in one of two shapes, and conflating them is how this module got
 * INP and CLS wrong for its whole life. An ENTRY-shaped vital is a fact about one
 * performance entry (LCP, the first input, one layout shift) and is emitted as it
 * happens. A LIFETIME vital is a fact about the whole page — INP is the worst
 * interaction it ever served, CLS the largest session-windowed shift sum — and has
 * no honest value until the page ends, so {@link BrowserVitals} accumulates it and
 * {@link startBrowserRum} emits it once, at the page-hide seam.
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

/** One `observe()` call's options — `durationThreshold` is the `event` type's INP knob. */
interface ObserveOptions {
  type: string;
  buffered?: boolean;
  durationThreshold?: number;
}

/** The minimal `PerformanceObserver` surface this module drives (feature-detected). */
interface PerfObserverLike {
  observe(options: ObserveOptions): void;

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

/** A layout-shift entry, structurally — `value` is ONE shift's score; {@link BrowserVitals} windows them into CLS. */
interface LayoutShiftLike extends PerfEntryLike {
  readonly value: number;
  readonly hadRecentInput: boolean;
}

/**
 * An event-timing entry (`PerformanceEventTiming`), structurally.
 *
 * `interactionId` is what makes an event part of an INTERACTION: the browser
 * assigns one id to every event of a single user interaction (pointerdown →
 * pointerup → click) and `0` to events that are not interactions at all. INP
 * takes the longest event within each interaction, then the worst interaction —
 * so the global maximum `duration` over entries with a non-zero id IS the worst
 * interaction, with no grouping to hold.
 */
interface EventTimingLike extends PerfEntryLike {
  readonly interactionId?: number;
}

/** How long an interaction must last (ms) before the browser reports its `event` entry. */
export const INP_DURATION_THRESHOLD_MS = 40;

/** A new layout-shift session starts when this long has passed since the previous shift. */
export const CLS_SESSION_GAP_MS = 1_000;

/** A layout-shift session is capped at this long from its FIRST shift. */
export const CLS_SESSION_WINDOW_MS = 5_000;

/**
 * The factor a unitless score (CLS, one layout shift) is multiplied by for the wire.
 *
 * `browser.value` is an integer — `Math.round` is applied so the attribute bag
 * stays flat numbers — and a CLS of `0.08` would round to `0`. Scaling by 1000
 * keeps three decimals of a score that lives almost entirely below 1. A span says
 * which convention its value follows in `browser.value_unit`, so a consumer never
 * has to know this constant to read the number correctly.
 */
export const VITAL_SCORE_SCALE = 1_000;

/** What unit a `browser.value` is in — stamped on every vital span so the number is readable. */
export type VitalUnit = "ms" | "score_x1000";

/** A finished vital measurement: its value and the entry time it was measured at. */
export interface VitalMeasurement {
  readonly value: number;
  readonly at: number;
}

/**
 * The two LIFETIME vitals, accumulated in O(1) state and read once at page hide.
 *
 * Neither INP nor CLS is a property of a single performance entry — both are
 * defined over the whole page lifetime — which is exactly why RUM got them wrong
 * before: it published one `first-input` entry as "INP" and never summed a shift
 * at all. Pure and injected-free, so every rule below is unit-tested with numbers
 * rather than a browser.
 *
 * **INP — the worst interaction, and how that differs from the spec.** The spec
 * reports a high percentile (the 98th, approximated as the Nth-worst once a page
 * has 50+ interactions). Below 50 interactions — nearly every page — the
 * percentile IS the worst interaction, so the two agree. Above it, the worst is
 * `>=` the percentile: this never reads BETTER than the spec's number. A budget
 * over it can false-RED, never false-green, which is the correct direction for the
 * thing a budget exists to catch — and it is what keeps the state one number
 * instead of a retained interaction list plus an interaction count.
 *
 * The floor is {@link INP_DURATION_THRESHOLD_MS}: an interaction faster than that
 * is never reported by the browser, so a page whose every interaction is under it
 * reports no INP at all rather than a small one.
 *
 * **CLS — the maximum SESSION-windowed sum**, per the spec's own windowing: a
 * shift joins the running session when it lands within {@link CLS_SESSION_GAP_MS}
 * of the previous shift AND within {@link CLS_SESSION_WINDOW_MS} of the session's
 * first; otherwise it opens a new session. CLS is the largest session sum, not the
 * page total — summing everything would punish a long page for shifts a user never
 * saw together.
 */
export class BrowserVitals {
  /** The worst interaction seen so far — INP, by the definition in the class doc. */
  #worstInteraction: VitalMeasurement | undefined;

  /** The running layout-shift session: its sum, its first shift's time, its last shift's time. */
  #sessionValue = 0;
  #sessionFirstAt = 0;
  #sessionLastAt = 0;

  /** The largest session sum seen so far, and when its last shift landed — CLS. */
  #worstSession: VitalMeasurement | undefined;

  /**
   * Record one interaction event's duration. Every event of one interaction
   * carries the same id and INP takes the longest of them, so keeping the running
   * maximum over all interaction events yields the worst interaction directly.
   */
  recordInteraction(durationMs: number, at: number): void {
    if (this.#worstInteraction !== undefined && durationMs <= this.#worstInteraction.value) return;

    this.#worstInteraction = { value: durationMs, at };
  }

  /** Record one CLS-eligible layout shift (the caller has already excluded input-driven ones). */
  recordLayoutShift(value: number, at: number): void {
    // The very first shift has no session to join; every later one joins the
    // running session only when BOTH window rules hold — within 1s of the previous
    // shift AND within 5s of the session's first. A gap-only rule would let a
    // steady drizzle accumulate into one session forever.
    const joinsSession =
      this.#worstSession !== undefined &&
      at - this.#sessionLastAt < CLS_SESSION_GAP_MS &&
      at - this.#sessionFirstAt < CLS_SESSION_WINDOW_MS;

    if (joinsSession) {
      this.#sessionValue += value;
    } else {
      this.#sessionValue = value;
      this.#sessionFirstAt = at;
    }

    this.#sessionLastAt = at;

    if (this.#worstSession === undefined || this.#sessionValue > this.#worstSession.value) {
      this.#worstSession = { value: this.#sessionValue, at };
    }
  }

  /** INP: the worst interaction, or `undefined` when the page saw none. */
  inp(): VitalMeasurement | undefined {
    return this.#worstInteraction;
  }

  /** CLS: the largest session-windowed sum, or `undefined` when the page saw no shift. */
  cls(): VitalMeasurement | undefined {
    return this.#worstSession;
  }
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

  /**
   * Register a page-hide callback; returns an unregister.
   *
   * INP and CLS are LIFETIME metrics — neither has a final value until the page
   * goes away — so RUM owns the moment it reads them rather than trusting every
   * call site to wire a disposer (none of them did: `assets`' synthesized entry
   * and estate's `client.tsx` both dropped the returned handle on the floor).
   *
   * The browser default listens on `visibilitychange` → hidden and on `pagehide`,
   * and NEVER on `unload`/`beforeunload` — those disqualify a page from the
   * back/forward cache, which is exactly the trap `@lesto/ui`'s
   * `observePageLifecycle` exists to avoid.
   *
   * OPTIONAL: it is the one member added after this interface was published, so an
   * environment that predates it keeps compiling and gets the browser default.
   */
  readonly onPageHide?: (callback: () => void) => () => void;
}

/** Knobs the synthesized client entry passes through; all have safe defaults. */
export interface RumOptions {
  /** Fraction of sessions that emit spans, in `[0, 1]`. Defaults to {@link DEFAULT_RUM_SAMPLE_RATE}. */
  readonly sampleRate?: number;

  /** The browser environment, injected for tests. Defaults to {@link browserRumEnvironment}. */
  readonly environment?: RumEnvironment;
}

/**
 * The entry types RUM observes, with each type's own observe options.
 *
 *   - `navigation` — the page load's phase timeline.
 *   - `resource` — each sub-resource fetch (island chunk, data fetch, image).
 *   - `largest-contentful-paint` — LCP, a Core Web Vital, emitted per entry.
 *   - `layout-shift` — each eligible shift, emitted RAW *and* windowed into CLS
 *     by {@link BrowserVitals}; the CLS span itself is emitted once, at page hide.
 *   - `first-input` — the page's first interaction. Emitted as its own honestly
 *     named vital AND folded into the interaction set, so a browser that reports
 *     no `event` entries still yields an INP.
 *   - `event` — the entries INP is actually defined over. `durationThreshold`
 *     lowers the browser's default reporting floor (104ms) to
 *     {@link INP_DURATION_THRESHOLD_MS} so a merely-slow interaction is visible;
 *     these feed the accumulator and emit no span of their own (one span per
 *     event would flood the wire for nothing).
 *
 * Each is `buffered: true` so an entry that fired before the observer attached is
 * still delivered.
 */
const OBSERVED_TYPES: readonly ObserveOptions[] = [
  { type: "navigation" },
  { type: "resource" },
  { type: "largest-contentful-paint" },
  { type: "layout-shift" },
  { type: "first-input" },
  { type: "event", durationThreshold: INP_DURATION_THRESHOLD_MS },
];

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
   * Map a Web Vital to a point-in-time `browser.web_vital` span. A vital is a
   * measurement, not a window, so its span is zero-width (start == end) and
   * carries the value as an attribute.
   *
   * `unit` rides ALONG with the value, because the two kinds of vital this
   * emits are not in the same units and the number alone cannot say which: a
   * duration is milliseconds, while a layout score is unitless and below 1, so it
   * is scaled by {@link VITAL_SCORE_SCALE} to survive the `Math.round` the flat
   * attribute bag requires. A consumer reads `browser.value_unit` instead of
   * having to know which vitals RUM happens to scale.
   */
  vitalSpan(name: string, value: number, at: number, unit: VitalUnit = "ms"): BrowserSpan {
    return this.span("browser.web_vital", at, at, {
      "browser.vital": name,
      "browser.value": Math.round(value),
      "browser.value_unit": unit,
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
    onPageHide: defaultOnPageHide,
  };
}

/**
 * The default page-hide registration: `visibilitychange` → hidden, plus `pagehide`.
 *
 * Both, because neither alone is reliable: Safari has historically missed
 * `visibilitychange` on a real teardown, while `pagehide` does not fire for a tab
 * the user merely switches away from and never returns to. NEVER `unload` or
 * `beforeunload` — registering either disqualifies the page from the back/forward
 * cache, the exact trap `@lesto/ui`'s `observePageLifecycle` documents.
 *
 * The TARGETS differ and that is not cosmetic: `visibilitychange` is dispatched at
 * the `document`, while `pagehide` is dispatched at the `Window` and never reaches
 * the document — registering it there is a listener that can never fire, which is
 * exactly the redundancy this pair exists to provide. Each is attached only when
 * its target exists, so SSR and a bare test are silent no-ops that still return an
 * unregister and a caller never has to branch.
 */
function defaultOnPageHide(callback: () => void): () => void {
  const doc = typeof document === "undefined" ? undefined : document;
  const win = typeof window === "undefined" ? undefined : window;

  const onVisibility = (): void => {
    if (doc?.visibilityState === "hidden") callback();
  };

  doc?.addEventListener("visibilitychange", onVisibility);
  win?.addEventListener("pagehide", callback);

  return () => {
    doc?.removeEventListener("visibilitychange", onVisibility);
    win?.removeEventListener("pagehide", callback);
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
 * Route one performance entry: feed the lifetime accumulator, and return the span
 * it emits NOW (or `undefined` when it only contributes to a lifetime metric).
 *
 * Pure routing plus one accumulator write, factored out so the observe loop stays
 * flat. The split between "emit now" and "accumulate" is the whole correction: an
 * entry-shaped vital (LCP, the first input) is a fact about that entry, while INP
 * and CLS are facts about the PAGE and cannot be published until it ends.
 */
function spanForEntry(
  tracer: BrowserTracer,
  vitals: BrowserVitals,
  entry: PerfEntryLike,
): BrowserSpan | undefined {
  if (entry.entryType === "navigation") {
    return tracer.navigationSpan(entry as NavEntryLike);
  }

  if (entry.entryType === "resource") {
    return tracer.resourceSpan(entry as ResourceEntryLike);
  }

  if (entry.entryType === "largest-contentful-paint") {
    return tracer.vitalSpan("LCP", entry.startTime, entry.startTime, "ms");
  }

  if (entry.entryType === "event") {
    // The entries INP is actually defined over. An event with no `interactionId`
    // (or `0`) is not part of a user interaction at all, so it never counts. No
    // span per event: one interaction emits several entries, and the wire would
    // carry hundreds of spans to say what one number says at page hide.
    const event = entry as EventTimingLike;

    if ((event.interactionId ?? 0) > 0) vitals.recordInteraction(entry.duration, entry.startTime);

    return undefined;
  }

  if (entry.entryType === "first-input") {
    // The page's FIRST interaction. It gets its own span — named for what it
    // actually is, not "INP", which it never was — and it also counts toward the
    // lifetime INP, so a browser reporting no `event` entries still yields one.
    vitals.recordInteraction(entry.duration, entry.startTime);

    return tracer.vitalSpan("first-input", entry.duration, entry.startTime, "ms");
  }

  // The last observed type, by elimination — every other member of OBSERVED_TYPES
  // has its own branch above, so ADDING a type there without adding a branch here
  // would land it in this one and feed CLS a shift that does not exist. Keep the
  // two lists in step.
  //
  // A layout-shift WITHOUT recent input is CLS-eligible; one right after an input
  // is user-initiated and excluded by spec (an excluded shift yields no span, and
  // never enters the CLS window). Each eligible shift still emits its RAW score —
  // the only per-event detail a debugger has — while the cumulative, session-
  // windowed CLS is accumulated here and emitted once at page hide.
  const shift = entry as LayoutShiftLike;

  if (shift.hadRecentInput) return undefined;

  vitals.recordLayoutShift(shift.value, shift.startTime);

  return tracer.vitalSpan(
    "layout-shift",
    shift.value * VITAL_SCORE_SCALE,
    shift.startTime,
    "score_x1000",
  );
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
 *   4. Observe navigation/resource/web-vital/event entries (buffered, so
 *      pre-attach entries still arrive), map each to a span, and POST batches.
 *   5. Register the page-hide seam, where the two LIFETIME vitals — INP and CLS —
 *      are computed and emitted. RUM owns that moment itself rather than trusting
 *      the caller: the disposer used to be documented as "called on page hide" and
 *      NO call site called it (`@lesto/assets`' synthesized entry and estate's
 *      `client.tsx` both dropped it), so a lifetime metric had nowhere to land.
 *
 * Returns a disposer that finalizes (once), flushes any pending spans, unregisters
 * the page-hide listener, and disconnects the observer — for an explicit teardown
 * (a client-side route unmount, a test). It is no longer load-bearing for the
 * vitals. Always returns a function, even on the no-op paths, so a caller can
 * dispose unconditionally.
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

  // The two LIFETIME vitals accumulate here and are published once, at page hide.
  const vitals = new BrowserVitals();

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
      const span = spanForEntry(tracer, vitals, entry);

      if (span !== undefined) pending.push(span);
    }

    flush();
  });

  for (const observed of OBSERVED_TYPES) {
    // A browser that lacks one entry type throws on `observe` for it; we tolerate
    // that per-type so the supported types still attach (a partial-support browser
    // still emits the vitals it can, rather than RUM failing wholesale).
    try {
      observer.observe({ ...observed, buffered: true });
    } catch {
      // unsupported entry type on this browser — skip it, keep the rest
    }
  }

  // Publish the lifetime vitals — on EVERY hide, but only when the value moved.
  //
  // A one-shot latch was the obvious thing and it is wrong: a hide is any tab
  // switch, so latching on the first one freezes INP and CLS at whatever the page
  // had achieved in its first few seconds and never reports the work the user
  // actually came to do. Emitting on every hide instead, gated on a CHANGE, keeps
  // the common page to exactly one span per vital while staying correct for a page
  // the user leaves and returns to (including a back/forward-cache restore, which
  // is a fresh `pageshow` on the same runtime).
  //
  // Both metrics are monotonic non-decreasing by construction — INP is a running
  // maximum and CLS a running maximum session — so when several spans do appear for
  // one page, the LAST is authoritative and taking either the last or the max is
  // correct.
  //
  // The gate compares the value AS THE WIRE CARRIES IT (rounded), not the raw
  // float: two readings that round to the same integer would otherwise emit two
  // spans a consumer cannot tell apart.
  //
  // One divergence from the reference `web-vitals`, stated: it resets both metrics
  // on a back/forward-cache restore and reports the restored view separately. This
  // does not — a restored page keeps accumulating, so its INP/CLS cover both views
  // and can only read HIGHER than either alone. Conservative, and the same
  // direction as the INP definition above, but it is not per-view.
  let lastInp: number | undefined;
  let lastCls: number | undefined;

  /** Publish `name` when its wire value moved since the last hide. */
  const publish = (
    name: string,
    measured: VitalMeasurement | undefined,
    scale: number,
    unit: VitalUnit,
    last: number | undefined,
  ): number | undefined => {
    if (measured === undefined) return last;

    const value = Math.round(measured.value * scale);

    if (value === last) return last;

    pending.push(tracer.vitalSpan(name, value, measured.at, unit));

    return value;
  };

  const finalize = (): void => {
    lastInp = publish("INP", vitals.inp(), 1, "ms", lastInp);
    lastCls = publish("CLS", vitals.cls(), VITAL_SCORE_SCALE, "score_x1000", lastCls);

    flush();
  };

  const stopPageHide = (environment.onPageHide ?? defaultOnPageHide)(finalize);

  return () => {
    // A caller that disposes without ever hiding still gets the vitals; one that
    // disposes right after a hide adds nothing, because nothing changed.
    finalize();

    stopPageHide();

    observer.disconnect();
  };
}

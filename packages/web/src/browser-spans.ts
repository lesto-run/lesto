/**
 * The browser-RUM span receiver — `POST /__lesto/browser-spans`.
 *
 * The browser-side RUM runtime (`@lesto/observability`'s `startBrowserRum`, inlined
 * into `@lesto/assets`' synthesized client entry) POSTs the spans it built from the
 * page's `PerformanceObserver` records: a `browser.navigation` span for the page
 * load's phases, a `browser.resource` span per same-origin fetch (the island chunk
 * and data fetch — the UI→API hop), and `browser.web_vital` spans for LCP/INP/CLS.
 * Each carries the SERVER trace id (adopted from the SSR-injected
 * `<meta name="lesto-traceparent">`) and parents on the server request span, so
 * this receiver is the seam that lands them in the SAME OTLP collector as the
 * server spans — UI → API → DB, one trace.
 *
 * This route is the mirror of the client-error beacon receiver, and shares its
 * posture exactly:
 *
 *   - The sink is a SEAM, injectable: this package's default sink logs one line,
 *     and the observability wiring wires it to `traces.seams.onBrowserSpan` so each
 *     span lands in the exporter beside the server spans — without this route
 *     depending on the tracer.
 *   - The body is BOUNDED: a coded 413 over {@link MAX_BROWSER_SPANS_BYTES}, far
 *     tighter than the runtime's 1 MiB body cap, so the public endpoint can't be
 *     grown into a log-spam or memory-pressure vector.
 *   - The shape is read LENIENTLY: the browser owns the payload shape (it evolves
 *     with the client runtime in another package), so this route extracts the
 *     fields it understands and drops the rest — a client-version skew degrades to
 *     fewer spans, never a 400. A body that is not a JSON object is the one hard
 *     refusal (a 400). A span missing the ids that make it joinable is dropped, not
 *     half-recorded.
 *
 * TRUST BOUNDARY — these spans are CLIENT-SUPPLIED and UNAUTHENTICATED. The
 * `traceId`/`parentSpanId` are chosen by the browser, because RUM stitching is
 * defined that way: to join the UI hop to the server trace, the client MUST echo
 * the server trace id the SSR page handed it (`<meta name="lesto-traceparent">`),
 * so the join key is inherently caller-controlled. Two consequences, and why each
 * is an ACCEPTED tradeoff rather than a defended one here:
 *
 *   - Trace grafting. A caller can POST spans under any 32-hex `traceId` and graft
 *     them onto a server trace. Targeted grafting onto a KNOWN server trace is not
 *     a realistic threat — trace ids are 128-bit and unguessable, so an attacker
 *     cannot name a victim's live trace; the residue is self-grafting (forging
 *     spans onto one's own trace), which corrupts nothing an operator relies on.
 *     Binding acceptance to a signed/nonce trace token (so only the page the
 *     server actually served may contribute) is the only real fix, but it is ruled
 *     out here: soft navigation (ADR 0024) emits spans long after the document's
 *     token would have gone stale, and enforcing it is a render-pipeline change —
 *     out of scope for this receiver. The `browser.*` span names already mark
 *     every span here as client-origin, so a collector can treat them as untrusted.
 *   - Ingestion-cost DoS. Unauthenticated + no built-in per-caller rate cap means a
 *     flood inflates OTLP/log ingestion. The per-request blast radius is already
 *     bounded (the byte cap above); the request RATE is bounded when the app wires
 *     `secureStack({ rateLimit })`, which covers this route (it rides `useChain`).
 *     A BUILT-IN cap independent of app middleware was considered and deferred: the
 *     repo's bounded limiter (`@lesto/ratelimit`) depends ON `@lesto/web`, so a
 *     `web → ratelimit` edge would be circular; and a hand-rolled global counter
 *     would silently drop legitimate RUM on a high-traffic app (every user's spans
 *     share one bucket), while a per-caller counter reintroduces the unbounded
 *     evicting-store DoS the repo already tracks (L-976b4302). Rate limiting stays
 *     an app-level `secureStack` concern until a bounded primitive can be reused
 *     without the cycle. The client-error beacon ({@link ./client-errors}) shares
 *     this unauthenticated-ingestion posture (it carries no trace id, so only this
 *     second point applies to it).
 */

import type { BrowserSpan } from "@lesto/observability";

import type { Context } from "./handler-context";
import { WebError } from "./errors";
import type { Handler } from "./lesto";
import type { LestoResponse } from "./types";

/** The built-in path the browser RUM runtime POSTs to. */
export const BROWSER_SPANS_ROUTE = "/__lesto/browser-spans";

/**
 * The largest browser-spans payload we accept, in bytes of its JSON form.
 *
 * A page load's RUM batch is a navigation span, a handful of resource spans, and
 * a few vitals — small, flat records of numbers and short same-origin paths. 64
 * KiB is generous for that (4× the client-error beacon's cap, since a batch
 * carries many spans where a beacon carries a few events) and still refuses an
 * attacker inflating the endpoint. Smaller than the runtime's 1 MiB body cap on
 * purpose — RUM has no reason to be large.
 */
export const MAX_BROWSER_SPANS_BYTES = 64 * 1024;

/**
 * A 32-hex trace id, lowercase (the width the server trace uses). A browser span
 * with a malformed trace id can't be joined to anything, so it is dropped.
 */
const TRACE_ID = /^[0-9a-f]{32}$/;

/** A 16-hex span/parent id, lowercase (the OTLP-wire + traceparent width). */
const SPAN_ID = /^[0-9a-f]{16}$/;

/**
 * Where normalized browser spans go.
 *
 * Injected so a test asserts without a console, and so the observability wiring
 * can route each span to `traces.seams.onBrowserSpan` (the exporter). Defaults to
 * {@link defaultBrowserSpanSink}: one structured JSON line per span. A sink must
 * not throw — the route swallows nothing on its behalf; keep it total.
 */
export type BrowserSpanSink = (span: BrowserSpan) => void;

/** A finite non-negative number, or `undefined` when the field is absent/garbage. */
function finiteNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;

  return value;
}

/** Read a lowercase-hex id matching `pattern`, or `undefined` when it is absent/malformed. */
function hexId(value: unknown, pattern: RegExp): string | undefined {
  if (typeof value !== "string" || !pattern.test(value)) return undefined;

  return value;
}

/** Read the OTLP status code (0 unset / 1 ok / 2 error), defaulting to `ok` when absent/garbage. */
function statusCode(value: unknown): 0 | 1 | 2 {
  if (value === 0 || value === 1 || value === 2) return value;

  // A browser span with no usable status is `ok` — RUM measures success timing,
  // and we never invent an error the browser did not report.
  return 1;
}

/**
 * A PII-free attribute bag: only finite-number and string values survive.
 *
 * The browser authors RUM attributes as numbers (timings, vital values) and short
 * same-origin path strings; anything else is malformed and dropped. A string is
 * length-capped so a skewed client can't smuggle an oversized value past the
 * whole-payload bound one attribute at a time.
 */
function attributeBag(value: unknown): Record<string, number | string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};

  const out: Record<string, number | string> = {};

  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === "number" && Number.isFinite(raw)) {
      out[key] = raw;
    } else if (typeof raw === "string") {
      out[key] = raw.slice(0, MAX_ATTRIBUTE_CHARS);
    }
  }

  return out;
}

/** The per-attribute string ceiling — a same-origin path is short; a long value is suspect. */
export const MAX_ATTRIBUTE_CHARS = 1024;

/**
 * Normalize one raw span into a {@link BrowserSpan}, or `undefined` if it lacks the
 * ids/timestamps that make it a joinable span.
 *
 * The HARD requirements are the join keys: a 32-hex `traceId`, a 16-hex `spanId`,
 * and two finite epoch-ms timestamps. Without them a span cannot be stitched to
 * the server trace, so it is dropped rather than exported as an orphan. The
 * `parentSpanId` is optional (a browser-rooted span has none) but, when present,
 * must be a valid 16-hex id — a malformed one is dropped, not carried. `name`
 * defaults to a generic marker so a skewed client's nameless span still records.
 * Pure and exported so every drop branch is unit-testable.
 */
export function normalizeBrowserSpan(raw: unknown): BrowserSpan | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;

  const span = raw as Record<string, unknown>;

  const traceId = hexId(span["traceId"], TRACE_ID);
  const spanId = hexId(span["spanId"], SPAN_ID);
  const startedAt = finiteNumber(span["startedAt"]);
  const endedAt = finiteNumber(span["endedAt"]);

  // Missing a join key (or a timestamp) → not a span we can stitch; drop it.
  if (
    traceId === undefined ||
    spanId === undefined ||
    startedAt === undefined ||
    endedAt === undefined
  ) {
    return undefined;
  }

  const parentSpanId = hexId(span["parentSpanId"], SPAN_ID);

  const name =
    typeof span["name"] === "string" ? span["name"].slice(0, MAX_ATTRIBUTE_CHARS) : "browser.span";

  return {
    traceId,
    spanId,
    ...(parentSpanId === undefined ? {} : { parentSpanId }),
    name,
    startedAt,
    endedAt,
    attributes: attributeBag(span["attributes"]),
    status: statusCode(span["status"]),
  };
}

/**
 * Normalize a raw payload body into the joinable browser spans it carries.
 *
 * Reads the `spans` array leniently — each entry through {@link normalizeBrowserSpan},
 * dropping any that lack their join keys — so a partial or skewed batch yields the
 * spans it CAN stitch rather than a 400. A body whose `spans` is not an array
 * yields an empty list. Pure and exported for direct unit testing.
 */
export function normalizeBrowserSpans(body: Record<string, unknown>): BrowserSpan[] {
  const raw = body["spans"];

  if (!Array.isArray(raw)) return [];

  const spans: BrowserSpan[] = [];

  for (const entry of raw) {
    const span = normalizeBrowserSpan(entry);

    if (span !== undefined) spans.push(span);
  }

  return spans;
}

/**
 * The default sink: one structured JSON line per browser span.
 *
 * Structured so a log pipeline branches on `name`/`trace_id` rather than scraping
 * a string — the posture every other Lesto sink takes. PII-free: only the span's
 * ids, name, timestamps, and its already-PII-free attribute bag are emitted.
 */
export function defaultBrowserSpanSink(span: BrowserSpan): void {
  console.info(
    JSON.stringify({
      level: "info",
      event: "browser.span",
      name: span.name,
      trace_id: span.traceId,
      span_id: span.spanId,
      parent_span_id: span.parentSpanId,
      started_at: span.startedAt,
      ended_at: span.endedAt,
      attributes: span.attributes,
    }),
  );
}

/** True iff `body` is a plain JSON object (the only shape a payload may take). */
function isObject(body: unknown): body is Record<string, unknown> {
  return typeof body === "object" && body !== null && !Array.isArray(body);
}

/**
 * The byte length of a value's JSON form, or `undefined` if it cannot serialize.
 *
 * The transport handed us the already-parsed body, so to size it we re-serialize
 * and measure UTF-8 bytes. A value that cannot serialize (a circular structure the
 * parser could never have produced, but defended anyway) is treated as un-sizeable.
 */
function jsonByteLength(body: unknown): number | undefined {
  let serialized: string;

  try {
    serialized = JSON.stringify(body);
  } catch {
    return undefined;
  }

  // `undefined`/a function serializes to `undefined`; size it as zero — the
  // `isObject` guard rejects it anyway.
  return serialized === undefined ? 0 : Buffer.byteLength(serialized, "utf8");
}

/**
 * Build the `POST /__lesto/browser-spans` handler over a {@link BrowserSpanSink}.
 *
 * Bounds the body (a coded 413 over {@link MAX_BROWSER_SPANS_BYTES}), refuses a
 * non-object body (a 400 — the one strict check), and otherwise normalizes the
 * batch and forwards each joinable span to `sink`, answering a bodiless 204 (the
 * browser only needs to know it was received). Exported so the route can be
 * registered as a built-in and unit-tested directly.
 */
export function browserSpansHandler(sink: BrowserSpanSink): Handler {
  return (c: Context): LestoResponse => {
    const body = c.req.body;

    const size = jsonByteLength(body);

    if (size !== undefined && size > MAX_BROWSER_SPANS_BYTES) {
      // Coded so a caller/test branches on the code, not the status; the response
      // body stays terse — a span sender does not read prose.
      const error = new WebError(
        "WEB_BROWSER_SPANS_BODY_TOO_LARGE",
        `browser-spans payload exceeds ${MAX_BROWSER_SPANS_BYTES} bytes`,
        { maxBytes: MAX_BROWSER_SPANS_BYTES, bytes: size },
      );

      return {
        status: 413,
        headers: { "content-type": "text/plain", "x-lesto-error": error.code },
        body: "Payload Too Large",
      };
    }

    if (!isObject(body)) {
      return { status: 400, headers: { "content-type": "text/plain" }, body: "Bad Request" };
    }

    for (const span of normalizeBrowserSpans(body)) {
      sink(span);
    }

    // A bodiless 204: the batch was received; there is nothing for the browser to
    // read back, and a body would only waste the round trip.
    return { status: 204, headers: {}, body: "" };
  };
}

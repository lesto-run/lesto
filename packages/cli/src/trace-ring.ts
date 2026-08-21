/**
 * The bounded dev-only TRACE ring (ADR 0048 Phase 0.2) — the queryable span store
 * ADR 0031 and ADR 0032 both declined to ship.
 *
 * ARCHITECTURE.md §7 says it plainly: spans go to your OTLP collector and nothing
 * else. ADR 0032's ring (`dev-state.ts`) holds `AccessEntry`s and says so — "this
 * plan mints no spans of its own". So an agent driving `lesto dev` can ask what was
 * SERVED but not what HAPPENED inside it: no db child spans, no browser RUM spans,
 * nothing a trace-shaped question needs.
 *
 * This is that store, and nothing more: a pure, fixed-size, in-memory record keyed
 * by `traceId`, filled from the ONE place every span already passes (the exporter
 * seam — server spans through the `Tracer`, browser spans through
 * `seams.onBrowserSpan`), and read by one read-only dev MCP tool. No socket, no fs,
 * no process — a struct builder exactly like `dev-state.ts`, so it is fully
 * unit-testable, and it is composed INTO `createDevState` so `@lesto/mcp` still
 * takes exactly one reader and the tool keeps ADR 0032's build-time gate.
 *
 * **Bounded twice, and honest about it.** A long dev session must never grow
 * memory, so both the number of retained TRACES and the number of spans per trace
 * are capped. Dropping is unavoidable; hiding it is not — a trace that lost spans
 * to the cap reports `truncated: true`, because a partial trace that reads as a
 * complete one is worse than no trace at all.
 *
 * **Untrusted content, and nothing keyed off it.** Browser spans arrive from the
 * public `POST /__lesto/browser-spans` receiver and are client-supplied by
 * construction (`web/src/browser-spans.ts` documents the trust boundary): their
 * name, their attributes, and even their `traceId` are chosen by the caller, so
 * NOTHING here reads them as authority. In particular this ring is keyed ONLY by
 * `traceId`: a `requestId` is resolved to one by {@link createDevState}, through the
 * `traceId` the runtime stamps on the access entry beside the request span — never
 * by scanning span attributes, which would let any caller point a developer's
 * `get_trace` wherever it liked. What a client CAN still do is add spans to a trace
 * it knows the id of, and
 * spend the ring's capacity; both are visible (a `browser.*` name, a `truncated`
 * flag) and both are bounded, and this ring invents no trust it does not have.
 */

import type { SpanData } from "@lesto/observability";

/**
 * How many distinct traces a DIRECTLY-constructed ring retains before the
 * least-recently-written is dropped.
 *
 * `createDevState` does not use it: it aligns the trace window to its own
 * `capacity` so the `get_recent_requests` → `get_trace` hop resolves for
 * everything the first tool reports. The dev ceiling is therefore
 * `DEFAULT_DEV_RING_CAPACITY` traces × {@link DEFAULT_TRACE_SPAN_CAPACITY} spans.
 */
export const DEFAULT_TRACE_RING_CAPACITY = 50;

/** How many spans one trace retains before its OLDEST spans are dropped. */
export const DEFAULT_TRACE_SPAN_CAPACITY = 200;

/** How a caller names the trace it wants. */
export interface TraceSelector {
  /** An explicit trace id — the direct lookup. */
  readonly traceId?: string | undefined;

  /**
   * A request id, as `get_recent_requests` reports it. Resolved by whoever holds
   * BOTH rings ({@link createDevState}) through the `traceId` the runtime stamps on
   * the access entry — never by scanning span attributes, which a client-supplied
   * span could set.
   */
  readonly requestId?: string | undefined;
}

/** What a lookup answers — an aged-out trace is a truthful `retained: false`, not an error. */
export interface TraceLookup {
  readonly retained: boolean;

  readonly traceId?: string;

  readonly spans: readonly SpanData[];

  readonly truncated: boolean;
}

/** The reader half the dev MCP tool consumes. */
export interface TraceRingReader {
  /**
   * The retained trace a selector names: an explicit `traceId`, else the trace
   * carrying `requestId`, else — with neither given — the most recently written
   * one (the "what just happened" read).
   */
  retainedTrace(selector: TraceSelector): TraceLookup;
}

/** The writer half the exporter tee feeds. */
export interface TraceRingWriter {
  /** Retain one finished span under its trace id. */
  recordSpan(span: SpanData): void;
}

/** The full trace ring — writer + reader over one doubly-bounded store. */
export interface TraceRing extends TraceRingReader, TraceRingWriter {}

/** Caps for {@link createTraceRing}; each defaults to its module constant. */
export interface TraceRingOptions {
  /** Distinct traces retained. Defaults to {@link DEFAULT_TRACE_RING_CAPACITY}. */
  readonly traceCapacity?: number;

  /** Spans retained per trace. Defaults to {@link DEFAULT_TRACE_SPAN_CAPACITY}. */
  readonly spanCapacity?: number;
}

/** A trace's mutable bucket while it is retained. */
interface TraceBucket {
  spans: SpanData[];
  truncated: boolean;
}

/** The empty answer — nothing retained under the name the caller asked for. */
export const NOT_RETAINED: TraceLookup = Object.freeze({
  retained: false,
  spans: Object.freeze([]) as readonly SpanData[],
  truncated: false,
});

/**
 * The lookup answer for a retained trace, reading its bucket.
 *
 * The spans are COPIED out: a caller holding the live array could push a span the
 * ring never recorded, or drop one it did.
 */
function retained(traceId: string, bucket: TraceBucket): TraceLookup {
  return {
    retained: true,
    traceId,
    spans: [...bucket.spans],
    truncated: bucket.truncated,
  };
}

/**
 * Build a bounded trace ring.
 *
 * Eviction is LEAST-RECENTLY-WRITTEN, not oldest-created: a `Map` keeps insertion
 * order, and every write re-inserts its trace at the end. That ordering is the
 * point — a long-lived trace (a slow request whose child spans keep arriving) must
 * survive a burst of short ones, which an oldest-created rule would evict it for.
 */
export function createTraceRing(options: TraceRingOptions = {}): TraceRing {
  const traceCapacity = options.traceCapacity ?? DEFAULT_TRACE_RING_CAPACITY;
  const spanCapacity = options.spanCapacity ?? DEFAULT_TRACE_SPAN_CAPACITY;

  const traces = new Map<string, TraceBucket>();

  /** Trace ids the cap has dropped, so a REBUILT bucket can admit what it lost. */
  const evicted = new Set<string>();

  const lookup = (traceId: string): TraceLookup => {
    const bucket = traces.get(traceId);

    return bucket === undefined ? NOT_RETAINED : retained(traceId, bucket);
  };

  return {
    recordSpan: (span) => {
      const existing = traces.get(span.traceId);

      // Re-insert on every write so Map order IS recency order (see the doc block).
      if (existing !== undefined) traces.delete(span.traceId);

      // A trace id the cap dropped is coming back — a browser's RUM batch arrives
      // at page hide, long after its request span. The rebuilt bucket is missing
      // everything the eviction took, so it must NOT read as a complete trace.
      const bucket: TraceBucket = existing ?? {
        spans: [],
        truncated: evicted.delete(span.traceId),
      };

      bucket.spans.push(span);

      if (bucket.spans.length > spanCapacity) {
        bucket.spans.shift();

        // Say it. A trace that quietly lost its head reads as a complete trace.
        bucket.truncated = true;
      }

      traces.set(span.traceId, bucket);

      if (traces.size > traceCapacity) {
        // Evict the least-recently-written trace — the Map's FIRST key. The size
        // guard guarantees one exists, so this loop always takes its single step.
        for (const oldest of traces.keys()) {
          traces.delete(oldest);
          evicted.add(oldest);

          break;
        }

        // Bound the eviction record too. A trace dropped so long ago that even its
        // record aged out rebuilds as `truncated: false` — the one hole in that
        // flag, and the reason the guarantee is stated as "lost spans WHILE
        // RETAINED" rather than "never silently partial".
        if (evicted.size > traceCapacity) {
          for (const stale of evicted) {
            evicted.delete(stale);

            break;
          }
        }
      }
    },

    retainedTrace: (selector) => {
      if (selector.traceId !== undefined) return lookup(selector.traceId);

      // Neither given: the most recently written trace — "what just happened". A
      // `requestId` is resolved to a `traceId` before it reaches here.
      let latest: string | undefined;

      for (const traceId of traces.keys()) latest = traceId;

      return latest === undefined ? NOT_RETAINED : lookup(latest);
    },
  };
}

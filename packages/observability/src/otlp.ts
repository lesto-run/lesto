/**
 * The OTLP/HTTP exporter — finished spans, shipped to a real collector.
 *
 * This is the adapter the rest of the package was shaped for: `SpanData`
 * mirrors OpenTelemetry on purpose, so exporting is a mapping, not a redesign.
 * `OtlpHttpExporter` buffers what `Tracer` hands it and `flush()` POSTs the
 * batch as OTLP/HTTP JSON (`/v1/traces`) — the wire format every OTel
 * collector, and the vendors behind one, accept.
 *
 * Telemetry must never take the app down: a failed flush (non-2xx, network
 * throw) is routed to `onError` and the batch is dropped — the deliberate
 * trade for a demo-grade exporter (no retry queue, no backpressure). The
 * mapping itself is exported pure ({@link otlpTraceRequest}) so tests pin the
 * exact bytes a collector would receive.
 */

import type { SpanData, SpanExporter } from "./types";

/** One OTLP attribute value, in the tagged-union shape the protocol wants. */
interface OtlpValue {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string;
  doubleValue?: number;
}

/** Map a span attribute to OTLP's tagged value union. Unknown shapes stringify. */
function otlpValue(value: unknown): OtlpValue {
  if (typeof value === "boolean") return { boolValue: value };

  if (typeof value === "number") {
    // OTLP carries 64-bit ints as strings; anything fractional is a double.
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }

  if (typeof value === "string") return { stringValue: value };

  return { stringValue: String(value) };
}

/** Epoch milliseconds → the unix-nano string OTLP timestamps are. */
function unixNano(ms: number): string {
  return `${Math.round(ms)}000000`;
}

/** OTLP status codes: 0 unset, 1 ok, 2 error. */
const STATUS_CODE = { unset: 0, ok: 1, error: 2 } as const;

/** OTLP span kind 2 — SERVER, which is what a per-request span is. */
const SPAN_KIND_SERVER = 2;

/**
 * Build the OTLP/HTTP JSON trace-export request body for a batch of spans.
 *
 * One resource (named by `serviceName`), one scope (this package), the spans.
 * Lesto's span ids are 32 hex chars (16 random bytes); OTLP's spanId field is
 * exactly 16 hex chars, so span ids are truncated to spec — still 8 random
 * bytes of identity, while the full-width traceId is carried verbatim.
 */
export function otlpTraceRequest(spans: readonly SpanData[], serviceName: string): unknown {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [{ key: "service.name", value: { stringValue: serviceName } }],
        },
        scopeSpans: [
          {
            scope: { name: "@lesto/observability" },
            spans: spans.map((span) => ({
              traceId: span.traceId,
              spanId: span.spanId.slice(0, 16),
              ...(span.parentSpanId === undefined
                ? {}
                : { parentSpanId: span.parentSpanId.slice(0, 16) }),
              name: span.name,
              kind: SPAN_KIND_SERVER,
              startTimeUnixNano: unixNano(span.startedAt),
              endTimeUnixNano: unixNano(span.endedAt ?? span.startedAt),
              attributes: Object.entries(span.attributes).map(([key, value]) => ({
                key,
                value: otlpValue(value),
              })),
              status: { code: STATUS_CODE[span.status] },
            })),
          },
        ],
      },
    ],
  };
}

/**
 * The default ceiling on the unbounded span buffer.
 *
 * A flush that never ran (the collector is down, no interval was started) used
 * to let the buffer grow without limit — a slow memory leak under load, exactly
 * the failure telemetry must never cause. We cap it at a generous default and
 * drop the OLDEST span when full (the newest signal is the one an operator most
 * wants), tallying every drop so the loss is observable, not silent.
 */
export const DEFAULT_MAX_BUFFERED_SPANS = 10_000;

/** What the OTLP exporter needs to reach a collector. Everything that varies is injected. */
export interface OtlpHttpExporterOptions {
  /** The collector's trace endpoint, e.g. `http://localhost:4318/v1/traces`. */
  readonly url: string;

  /** Extra request headers (an auth token, a tenant id). */
  readonly headers?: Record<string, string>;

  /** The `service.name` resource attribute. Defaults to `"lesto"`. */
  readonly serviceName?: string;

  /** The HTTP seam; defaults to the global `fetch`. */
  readonly fetchFn?: typeof fetch;

  /**
   * The most spans the buffer may hold between flushes. When full, the OLDEST is
   * dropped to admit the newest (and counted — see {@link OtlpHttpExporter.dropped}).
   * Defaults to {@link DEFAULT_MAX_BUFFERED_SPANS}.
   */
  readonly maxBufferedSpans?: number;

  /** Where a failed flush is reported. Defaults to `console.error`. */
  readonly onError?: (error: unknown) => void;
}

/**
 * Buffer finished spans; `flush()` ships the batch to the collector.
 *
 * Batching is the caller's cadence to own — flush at request end (an edge
 * worker's `waitUntil`), on an interval (a node service), or at shutdown. A
 * flush failure reports to `onError` and drops the batch; it never throws.
 *
 * The buffer is BOUNDED ({@link OtlpHttpExporterOptions.maxBufferedSpans}): if
 * spans pile up faster than they flush (a down collector, a missing interval),
 * the oldest are dropped to admit the newest and the loss is counted in
 * {@link dropped} — telemetry sheds load instead of leaking memory.
 */
export class OtlpHttpExporter implements SpanExporter {
  private readonly buffer: SpanData[] = [];

  private readonly url: string;

  private readonly headers: Record<string, string>;

  private readonly serviceName: string;

  private readonly fetchFn: typeof fetch;

  private readonly maxBufferedSpans: number;

  private readonly onError: (error: unknown) => void;

  /**
   * How many spans were dropped because the buffer was full when they arrived.
   *
   * A non-zero count means the exporter is shedding telemetry under backpressure
   * — the collector is unreachable, or no flush cadence is draining the buffer.
   * Read it to surface the loss (a periodic log, a metric) so dropped traces are
   * a known fact, not a silent gap.
   */
  dropped = 0;

  constructor(options: OtlpHttpExporterOptions) {
    this.url = options.url;
    this.headers = options.headers ?? {};
    this.serviceName = options.serviceName ?? "lesto";
    this.fetchFn = options.fetchFn ?? fetch;
    this.maxBufferedSpans = options.maxBufferedSpans ?? DEFAULT_MAX_BUFFERED_SPANS;
    this.onError = options.onError ?? ((error) => console.error("[lesto/observability]", error));
  }

  export(span: SpanData): void {
    // Drop-oldest at the ceiling: a backed-up buffer (down collector, no flush
    // cadence) sheds its stalest span to admit the freshest, and counts the loss
    // so it is observable rather than an unbounded memory leak.
    if (this.buffer.length >= this.maxBufferedSpans) {
      this.buffer.shift();
      this.dropped += 1;
    }

    this.buffer.push(span);
  }

  /** Ship everything buffered so far. An empty buffer is a no-op, not a request. */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const spans = this.buffer.splice(0);

    try {
      const response = await this.fetchFn(this.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...this.headers },
        body: JSON.stringify(otlpTraceRequest(spans, this.serviceName)),
      });

      if (!response.ok) {
        this.onError(
          new Error(`OTLP export failed: ${response.status} for ${spans.length} span(s)`),
        );
      }
    } catch (error) {
      this.onError(error);
    }
  }
}

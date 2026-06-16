/**
 * @keel/observability — an in-house distributed-tracing core.
 *
 *   const exporter = new InMemoryExporter();
 *   const tracer = new Tracer({ exporter });
 *
 *   const root = tracer.startSpan("handle_request");
 *   const child = tracer.startSpan("query_db", { parent: root });
 *   child.setAttribute("rows", 12).setStatus("ok").end();
 *   root.end();
 *
 *   await tracer.withSpan("charge_card", async (span) => {
 *     span.setAttribute("amount_cents", 4200);
 *     return charge();
 *   });
 *
 * The shape is OpenTelemetry-flavored, and the OTLP adapter is here: wire an
 * `OtlpHttpExporter` instead of the in-memory one and `flush()` ships every
 * finished span to a real collector over OTLP/HTTP JSON.
 *
 * The WIRING facade (`tracesFromEnv` / `createTraces`) is the env-driven entry
 * point an app constructs once — it reads the two-env-var setup, builds the
 * exporter + tracer, drives the flush lifecycle, and hands back the per-domain
 * seam hooks (`db.onQuery`, `identity.onEvent`, …) every battery terminates in:
 *
 *   // The two-env-var setup (KEEL_OTLP_URL is the on switch):
 *   //   KEEL_OTLP_URL=http://localhost:4318/v1/traces
 *   //   KEEL_OTLP_SERVICE=my-app            (service.name; default "keel")
 *   //   KEEL_OTLP_HEADERS=authorization=Bearer t   (optional, comma-separated)
 *   const traces = tracesFromEnv(process.env, { currentSpan });
 *   const db = createDb(sql, { onQuery: traces?.seams.onQuery });
 *   const stop = traces?.startInterval(5_000);   // flush cadence; stop on drain
 *
 * `traceparent` (parse/format) is the W3C propagation primitive — verbatim, never
 * an invented format — that joins a trace across a process boundary.
 */

export { InMemoryExporter } from "./exporter";

export { DEFAULT_MAX_BUFFERED_SPANS, OtlpHttpExporter, otlpTraceRequest } from "./otlp";
export type { OtlpHttpExporterOptions } from "./otlp";

export { randomHexId } from "./ids";

export { systemClock } from "./time";

export { Tracer } from "./tracer";
export type { InboundTrace, StartSpanOptions, TracerOptions } from "./tracer";

export { formatTraceparent, parseTraceparent, TRACEPARENT_HEADER } from "./traceparent";
export type { Traceparent } from "./traceparent";

export { createTraces, parseOtlpHeaders, tracesFromEnv } from "./traces";
export type { CurrentSpan, Traces, TracesEnv, TracesOptions, TraceSeams } from "./traces";

export type { Clock, Span, SpanData, SpanExporter, SpanStatus } from "./types";

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
 */

export { InMemoryExporter } from "./exporter";

export { OtlpHttpExporter, otlpTraceRequest } from "./otlp";
export type { OtlpHttpExporterOptions } from "./otlp";

export { randomHexId } from "./ids";

export { systemClock } from "./time";

export { Tracer } from "./tracer";
export type { StartSpanOptions, TracerOptions } from "./tracer";

export type { Clock, Span, SpanData, SpanExporter, SpanStatus } from "./types";

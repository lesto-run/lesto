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
 * The shape is OpenTelemetry-flavored; an OTel exporter is a future adapter.
 */

export { InMemoryExporter } from "./exporter";

export { randomHexId } from "./ids";

export { systemClock } from "./time";

export { Tracer } from "./tracer";
export type { StartSpanOptions, TracerOptions } from "./tracer";

export type { Clock, Span, SpanData, SpanExporter, SpanStatus } from "./types";

/**
 * @lesto/observability — an in-house distributed-tracing core.
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
 *   // The two-env-var setup (LESTO_OTLP_URL is the on switch):
 *   //   LESTO_OTLP_URL=http://localhost:4318/v1/traces
 *   //   LESTO_OTLP_SERVICE=my-app            (service.name; default "lesto")
 *   //   LESTO_OTLP_HEADERS=authorization=Bearer t   (optional, comma-separated)
 *   const traces = tracesFromEnv(process.env, { currentSpan });
 *   const db = createDb(sql, { onQuery: traces?.seams.onQuery });
 *   const stop = traces?.startInterval(5_000);   // flush cadence; stop on drain
 *
 * `traceparent` (parse/format) is the W3C propagation primitive — verbatim, never
 * an invented format — that joins a trace across a process boundary.
 *
 * ── The v1 observability cut: TRACES ONLY (said out loud) ───────────────────
 *
 * This package is distributed TRACING and nothing else. v1 ships NO metrics
 * pipeline (no counters, no latency histograms) and NO logs pipeline (no log
 * aggregation/shipping) from here. That is a deliberate scope line, not an
 * oversight: the operability plan defers metrics and logs post-1.0
 * (`docs/plans/operability-dx.md`), and the launch story is spans + the runtime's
 * structured access log. If you reach for a counter or a histogram here, it does
 * not exist on purpose — the seam to add one is a future increment, not a gap to
 * patch around.
 *
 * ── The `lesto.request_id` → trace join ──────────────────────────────────────
 *
 * Traces and the access log are two records of ONE request, joined by a shared
 * id. The runtime mints a per-request id, puts it on every access-log entry as
 * `requestId`, sets it on the request span as the `lesto.request_id` attribute,
 * and echoes it back on the `X-Request-Id` response header. So a span found in
 * the collector and an access-log line are correlated by an exact-match query on
 * that one value — the trace tells you the shape (parent/child spans, timings),
 * the access log tells you the outcome (method, path, status, ms), and
 * `lesto.request_id` is the key that lines them up. No metrics layer is needed to
 * bridge the two; the id is the join.
 *
 * ── The NIH boundary line: W3C `traceparent`, verbatim ──────────────────────
 *
 * Cross-process propagation is W3C Trace Context `traceparent` EXACTLY (see
 * `traceparent.ts`) — never a Lesto-invented header or format. That is a settled
 * decision: the W3C wire is what every collector, vendor, and sibling service
 * already speaks, so adopting it verbatim is the difference between joining the
 * world's traces and stranding ours. We do not extend it, we do not abbreviate
 * it, and we do not ship an alternative — if a hop needs propagation, it carries
 * `traceparent`.
 */

// The shared AI/agent span vocabulary (ADR 0031) — the one contract the covered
// `mcp.tool` span and the preview `ai.*` spans agree on. The mapper takes a
// STRUCTURAL record, so this gains no `@lesto/mcp`/`@lesto/ai` edge.
export {
  AI_GENERATE_SPAN,
  AI_MODEL_ATTR,
  AI_STOP_REASON_ATTR,
  AI_STREAMING_ATTR,
  AI_TOOL_NAME_ATTR,
  AI_TOOL_SPAN,
  AI_USAGE_INPUT_TOKENS_ATTR,
  AI_USAGE_OUTPUT_TOKENS_ATTR,
  MCP_DURATION_MS_ATTR,
  MCP_INPUT_HASH_ATTR,
  MCP_OUTCOME_ATTR,
  MCP_TOOL_ATTR,
  MCP_TOOL_SPAN,
  mcpAuditToSpanAttributes,
} from "./agent-vocabulary";
export type { McpAuditShape } from "./agent-vocabulary";

export { InMemoryExporter } from "./exporter";

export { DEFAULT_MAX_BUFFERED_SPANS, OtlpHttpExporter, otlpTraceRequest } from "./otlp";
export type { OtlpHttpExporterOptions } from "./otlp";

export { randomHexId } from "./ids";

export { systemClock } from "./time";

export { Tracer } from "./tracer";
export type { InboundTrace, StartSpanOptions, TracerOptions } from "./tracer";

export { formatTraceparent, parseTraceparent, TRACEPARENT_HEADER } from "./traceparent";
export type { Traceparent } from "./traceparent";

export { browserSpanToData, createTraces, parseOtlpHeaders, tracesFromEnv } from "./traces";
export type { CurrentSpan, Traces, TracesEnv, TracesOptions, TraceSeams } from "./traces";

// Browser RUM — the browser half of the UI→API→DB trace (ARCHITECTURE.md §7).
// `startBrowserRum` observes the page's performance and POSTs spans under the
// SSR-injected server trace id; `wrapFetch` carries an outbound `traceparent` on
// same-origin fetches so the server handler joins the same trace.
export {
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
} from "./rum";
export type { BrowserSpan, BrowserSpansPayload, RumEnvironment, RumOptions } from "./rum";

export type { Clock, Span, SpanData, SpanExporter, SpanStatus } from "./types";

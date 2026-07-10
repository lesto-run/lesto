/**
 * The wiring facade — one place an app turns env + seams into live traces.
 *
 * The pieces below it (`Tracer`, `OtlpHttpExporter`, the W3C `traceparent`
 * primitive) are deliberately small and unopinionated. THIS is where they meet
 * the rest of Lesto: it reads the two-env-var setup, builds the exporter and
 * tracer, drives the flush lifecycle (an interval for a long-lived node service,
 * an explicit `flush()` for an edge worker's `waitUntil` or a drain), and turns
 * every per-domain `on*` seam other packages exposed into a child span under the
 * request currently in flight.
 *
 * The contract this file defines is the one `@lesto/cloudflare` (edge-deploy #3)
 * mirrors: the env-var names + semantics, the exporter/tracer construction, and
 * the `flush()` API `waitUntil` calls. The node tier wires it here; the edge
 * adapter wires the SAME shape with its own `waitUntil` arity.
 */

import { OtlpHttpExporter } from "./otlp";
import type { OtlpHttpExporterOptions } from "./otlp";
import type { BrowserSpan } from "./rum";
import { Tracer } from "./tracer";
import type { InboundTrace } from "./tracer";
import type { Span, SpanData } from "./types";

/**
 * The environment a {@link tracesFromEnv} reads — the two-env-var setup, plus a
 * couple of optional knobs. Just the slice of `process.env` we need, so a test
 * passes a literal and a worker passes its `env` binding.
 *
 * THE CONTRACT (mirrored by the edge adapter):
 *
 *   - `LESTO_OTLP_URL`     — the collector's trace endpoint, e.g.
 *                           `http://localhost:4318/v1/traces`. ABSENT disables
 *                           tracing entirely (no exporter, no spans, zero cost) —
 *                           the safe default, so an app with no collector pays
 *                           nothing and an operator opts in by setting one var.
 *   - `LESTO_OTLP_SERVICE` — the `service.name` resource attribute. Defaults to
 *                           `"lesto"`.
 *   - `LESTO_OTLP_HEADERS` — extra request headers as a comma-separated
 *                           `key=value` list (an auth token, a tenant id), e.g.
 *                           `authorization=Bearer t,x-tenant=acme`. Absent = none.
 */
export interface TracesEnv {
  readonly LESTO_OTLP_URL?: string | undefined;
  readonly LESTO_OTLP_SERVICE?: string | undefined;
  readonly LESTO_OTLP_HEADERS?: string | undefined;
}

/**
 * Parse the `LESTO_OTLP_HEADERS` comma-separated `key=value` list into a header
 * map. A blank entry is skipped; an entry with no `=` is skipped (we never
 * invent a value); whitespace around the key and around the value is trimmed.
 * Pure and exported so the skip/trim branches are unit-testable.
 */
export function parseOtlpHeaders(raw: string | undefined): Record<string, string> {
  if (raw === undefined) return {};

  const headers: Record<string, string> = {};

  for (const entry of raw.split(",")) {
    const eq = entry.indexOf("=");

    // No `=` (a bare token) carries no value — we never guess one; skip it.
    if (eq === -1) continue;

    const key = entry.slice(0, eq).trim();
    const value = entry.slice(eq + 1).trim();

    // A blank key is meaningless as a header name; drop it.
    if (key === "") continue;

    headers[key] = value;
  }

  return headers;
}

/**
 * Reads the request span for the request currently in flight, so a seam hook can
 * parent its child span on it.
 *
 * Injected (rather than importing `@lesto/web`'s `currentContext` here) so this
 * tracing core stays dependency-free and the wiring site supplies the binding.
 * Returns `undefined` outside a request (a background job, startup) — the hook
 * then roots a standalone span instead of crashing.
 */
export type CurrentSpan = () => Span | undefined;

/** What {@link createTraces} needs: a tracer, a flushable exporter, the current-span seam. */
export interface TracesOptions {
  readonly tracer: Tracer;

  /** Flushed on the interval, on drain, and on an edge worker's `waitUntil`. */
  readonly flush: () => Promise<void>;

  /**
   * Reads the in-flight request span so seam hooks parent on it. Absent → seam
   * spans root their own trace (still exported, just unparented). The runtime
   * wires this to `currentContext()?.span`.
   */
  readonly currentSpan?: CurrentSpan;

  /**
   * Writes a pre-built {@link SpanData} straight to the exporter, bypassing the
   * tracer's id minting.
   *
   * The `onBrowserSpan` seam needs this: a browser span arrives with its OWN ids
   * (the page adopted the server trace id, the browser minted its span id) and its
   * OWN epoch-ms timestamps. Re-minting them through `tracer.startSpan` would
   * discard the join. So the wiring hands the raw `SpanData` to the exporter
   * directly — the same exporter the tracer feeds, so browser and server spans
   * share one collector and one trace id. Absent → `onBrowserSpan` drops the span
   * (no exporter to write to), the honest no-op when tracing was wired without it.
   */
  readonly exportSpan?: (span: SpanData) => void;
}

/**
 * The narrow tracer the runtime mints request spans through (its `RequestTracer`,
 * structurally): `startSpan(name, inbound?)` adopts an inbound `traceparent` join
 * and returns a span whose `data` carries the ids a child span and the outbound
 * `traceparent` read.
 */
export interface RequestTracer {
  startSpan(name: string, inbound?: InboundTrace): Span;
}

/**
 * The live tracing handle an app holds: the seam hooks to pass each battery, the
 * tracer the runtime mints request spans through, and the flush lifecycle.
 *
 * `seams` is the whole point — every `on*` hook another plan built terminates in
 * one of these, becoming a child span (or, for the fire-and-forget signals, a
 * standalone span) so a query/job/event/delivery shows up under the request that
 * caused it.
 */
export interface Traces {
  /** The tracer the runtime mints one `http.request` span per request through. */
  readonly tracer: Tracer;

  /**
   * The runtime-shaped tracer: `startSpan(name, inbound?)` joins an inbound
   * `traceparent` and returns the request span. Hand this to `serve({ tracer })`
   * so a request span continues the caller's trace and is published on the
   * request context for child spans.
   */
  readonly requestTracer: RequestTracer;

  /** The seam hooks to hand each battery (`db.onQuery`, `identity.onEvent`, …). */
  readonly seams: TraceSeams;

  /**
   * Ship every buffered span to the collector. Idempotent and safe to call
   * often — an empty buffer is a no-op. This is the API an edge worker's
   * `waitUntil(traces.flush())` and a node drain both call; it never throws.
   */
  flush(): Promise<void>;

  /**
   * Start flushing on an interval (a long-lived node service's cadence). Returns
   * a stop handle; call it on drain (after a final {@link flush}). A worker has
   * no steady process to run an interval on, so it skips this and flushes per
   * request instead.
   */
  startInterval(everyMs: number): () => void;
}

/**
 * A secret-free KDF-cost descriptor as carried by `@lesto/identity`'s
 * `password_rehashed` event (its `PasswordHashCost`). Structurally mirrored here —
 * this package depends on no battery — and only JSON-encoded, never branched on, so
 * the type names just the `algorithm` discriminant while every cost param (scrypt
 * `n`/`r`/`p`, pbkdf2 `iterations`, …) rides along verbatim at runtime.
 */
export type HashCostDescriptor = { readonly algorithm: string };

/**
 * The per-domain seam hooks, each shaped to slot straight into the battery that
 * raises it (see the Phase-1 signatures). Every one turns its event into a span:
 * a child of the in-flight request span when there is one, a root span when
 * there is not (a background worker, a startup task).
 */
export interface TraceSeams {
  /** `@lesto/db`'s `onQuery` — each executed query becomes a `db.query` child span. */
  onQuery(event: { readonly sql: string; readonly durationMs: number }): void;

  /** `@lesto/queue`'s `onJob` — each finished job becomes a `queue.job` span. */
  onJob(event: {
    readonly queue: string;
    readonly id: number;
    readonly name: string;
    readonly outcome: "done" | "retry" | "failed";
    readonly attempt: number;
    readonly durationMs: number;
  }): void;

  /**
   * `@lesto/identity`'s `onEvent` — each lifecycle event becomes an `identity.<type>` span.
   *
   * `from`/`to` ride only on the `password_rehashed` event: the secret-free KDF-cost
   * descriptors (`@lesto/identity`'s `PasswordHashCost` — an algorithm tag plus cost
   * params, never the salt or derived key) that let a monitor tell a cost UP-grade from
   * a strength-reducing DOWN-grade. Mirrored structurally, since this package keeps its
   * event seams dependency-free; only ever JSON-encoded downstream, so every cost field
   * rides along verbatim at runtime even though the type names just the discriminant.
   */
  onEvent(event: {
    readonly type: string;
    readonly userId?: string;
    readonly at: number;
    readonly from?: HashCostDescriptor;
    readonly to?: HashCostDescriptor;
  }): void;

  /** `@lesto/mail`'s `onDelivered` — a `mail.delivered` span per accepted email. */
  onDelivered(event: {
    readonly mailerName: string;
    readonly jobId: number;
    readonly attempt: number;
  }): void;

  /** `@lesto/mail`'s `onFailed` — a `mail.failed` (error-status) span per failed attempt. */
  onFailed(event: {
    readonly mailerName: string;
    readonly jobId: number;
    readonly attempt: number;
    readonly code: string;
  }): void;

  /** The `runWorker` `onError` sink — a `worker.poll_failed` error span per poll fault. */
  onWorkerError(error: { readonly code: string; readonly message: string }): void;

  /** `@lesto/web`'s `clientErrors` sink — a `client.island_error` span per browser beacon. */
  onClientError(event: {
    readonly failed: readonly string[];
    readonly missing: readonly string[];
    readonly failedCount: number;
    readonly missingCount: number;
  }): void;

  /**
   * `@lesto/web`'s browser-spans receiver sink — one EXPORTED span per browser RUM
   * span, joined to the server trace.
   *
   * Unlike every other seam (each turns a server-side EVENT into a freshly-minted
   * child span), this hands through a span the BROWSER already authored: its ids
   * (the adopted server trace id + the browser's span id), its epoch-ms
   * timestamps, and a PII-free attribute bag. The wiring writes it straight to the
   * exporter via {@link TracesOptions.exportSpan}, so a navigation/resource/vital
   * span lands in the SAME collector as the server `http.request` span, under one
   * trace id — the UI→API→DB join ARCHITECTURE.md §7 promises. With no
   * `exportSpan` wired, this is a no-op (nothing to export to).
   */
  onBrowserSpan(span: BrowserSpan): void;
}

/** OTLP status codes (0 unset, 1 ok, 2 error), the inverse of the exporter's map. */
const SPAN_STATUS_FOR_CODE = { 0: "unset", 1: "ok", 2: "error" } as const;

/**
 * Map a browser-authored {@link BrowserSpan} onto the internal {@link SpanData}.
 *
 * The browser already chose the ids (the adopted server trace id + its own span
 * id) and the epoch-ms timestamps, so this preserves them verbatim — that
 * preservation IS the cross-tier join. Only the status shape differs: the browser
 * speaks the OTLP code (0/1/2), the internal record speaks the named status, so we
 * translate. The attribute bag is copied into a fresh mutable record, since
 * `SpanData.attributes` is mutable by contract.
 */
export function browserSpanToData(span: BrowserSpan): SpanData {
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    ...(span.parentSpanId === undefined ? {} : { parentSpanId: span.parentSpanId }),
    name: span.name,
    startedAt: span.startedAt,
    endedAt: span.endedAt,
    attributes: { ...span.attributes },
    status: SPAN_STATUS_FOR_CODE[span.status],
  };
}

/**
 * Build the live tracing handle from a tracer, a flush, and the current-span seam.
 *
 * The seam hooks all funnel through one helper: open a span (parented on the
 * in-flight request span when one exists), stamp the event's attributes, set its
 * status, and end it immediately — a hook receives a finished event, so the span
 * is a point-in-time record, not a window we hold open.
 */
export function createTraces(options: TracesOptions): Traces {
  const { tracer } = options;

  const parentOf = (): Span | undefined => options.currentSpan?.();

  /** Record a finished event as a child span: open, stamp, status, end. */
  const record = (
    name: string,
    attributes: Record<string, unknown>,
    status: "ok" | "error",
  ): void => {
    const parent = parentOf();

    const span = tracer.startSpan(
      name,
      parent === undefined ? { attributes } : { parent, attributes },
    );

    span.setStatus(status);
    span.end();
  };

  const seams: TraceSeams = {
    onQuery: (event) =>
      record("db.query", { "db.statement": event.sql, "db.duration_ms": event.durationMs }, "ok"),

    onJob: (event) =>
      record(
        "queue.job",
        {
          "queue.name": event.queue,
          "queue.job_id": event.id,
          "queue.job_name": event.name,
          "queue.outcome": event.outcome,
          "queue.attempt": event.attempt,
          "queue.duration_ms": event.durationMs,
        },
        event.outcome === "failed" ? "error" : "ok",
      ),

    onEvent: (event) =>
      record(
        `identity.${event.type}`,
        {
          "identity.event": event.type,
          "identity.at": event.at,
          ...(event.userId === undefined ? {} : { "identity.user_id": event.userId }),
          // The `password_rehashed` cost pair — JSON-encoded so a monitor can tell an
          // up-rehash from a strength-reducing down-rehash. Secret-free by construction
          // (algorithm + cost params only); absent on every other event.
          ...(event.from === undefined
            ? {}
            : { "identity.rehash_from": JSON.stringify(event.from) }),
          ...(event.to === undefined ? {} : { "identity.rehash_to": JSON.stringify(event.to) }),
        },
        "ok",
      ),

    onDelivered: (event) =>
      record(
        "mail.delivered",
        {
          "mail.mailer": event.mailerName,
          "mail.job_id": event.jobId,
          "mail.attempt": event.attempt,
        },
        "ok",
      ),

    onFailed: (event) =>
      record(
        "mail.failed",
        {
          "mail.mailer": event.mailerName,
          "mail.job_id": event.jobId,
          "mail.attempt": event.attempt,
          "mail.code": event.code,
        },
        "error",
      ),

    onWorkerError: (error) =>
      record(
        "worker.poll_failed",
        { "error.code": error.code, "error.message": error.message },
        "error",
      ),

    onClientError: (event) =>
      record(
        "client.island_error",
        {
          "client.failed": event.failed.join(","),
          "client.missing": event.missing.join(","),
          "client.failed_count": event.failedCount,
          "client.missing_count": event.missingCount,
        },
        "error",
      ),

    // A browser span keeps its OWN ids and timestamps (the join), so it is written
    // straight to the exporter rather than re-minted through the tracer. With no
    // `exportSpan` wired this is the honest no-op — there is nowhere to export to.
    onBrowserSpan: (span) => {
      if (options.exportSpan === undefined) return;

      options.exportSpan(browserSpanToData(span));
    },
  };

  const requestTracer: RequestTracer = {
    // The runtime's `RequestTracer.startSpan(name, inbound?)`: an inbound trace
    // (parsed from `traceparent`) continues the caller's trace; absent, it roots
    // a fresh one. The returned `Span.data` is what the request context publishes
    // for child spans and the outbound `traceparent` reads.
    startSpan: (name, inbound) => tracer.startSpan(name, inbound === undefined ? {} : { inbound }),
  };

  return {
    tracer,
    requestTracer,
    seams,
    flush: options.flush,
    startInterval: (everyMs) => {
      const timer = setInterval(() => void options.flush(), everyMs);

      // A flush interval must never keep the process alive on its own — the app's
      // own open socket does that. `unref` is node-only; a runtime without it
      // (a worker, where this path is unused) simply skips the call.
      timer.unref?.();

      return () => clearInterval(timer);
    },
  };
}

/**
 * Build a {@link Traces} from the environment, or `undefined` when tracing is off.
 *
 * `LESTO_OTLP_URL` is the on switch: absent, we return `undefined` and the app
 * runs with NO tracer (zero spans, zero overhead). Present, we construct an
 * `OtlpHttpExporter` over the parsed headers + service name, a `Tracer` over it,
 * and the live handle. `currentSpan` and `fetchFn` are injected so the runtime
 * wires the request-span seam and a worker passes its own `fetch`.
 *
 * This is the construction the CLI calls for `lesto serve`/`dev`; the edge adapter
 * mirrors it with the worker `env` and `ctx.waitUntil(traces.flush())`.
 */
export function tracesFromEnv(
  env: TracesEnv,
  options: {
    readonly currentSpan?: CurrentSpan;
    readonly fetchFn?: typeof fetch;
    readonly onError?: (error: unknown) => void;
  } = {},
): Traces | undefined {
  const url = env.LESTO_OTLP_URL;

  // The on switch: no collector configured means no tracing at all.
  if (url === undefined || url === "") return undefined;

  const exporterOptions: OtlpHttpExporterOptions = {
    url,
    headers: parseOtlpHeaders(env.LESTO_OTLP_HEADERS),
    serviceName: env.LESTO_OTLP_SERVICE ?? "lesto",
    ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  };

  const exporter = new OtlpHttpExporter(exporterOptions);

  const tracer = new Tracer({ exporter });

  return createTraces({
    tracer,
    flush: () => exporter.flush(),
    // The browser-spans seam writes pre-built spans straight to this exporter, so
    // a RUM span shares the collector + trace id with the server spans the tracer
    // feeds. Wired here so the env-driven app gets the join for free.
    exportSpan: (span) => exporter.export(span),
    ...(options.currentSpan === undefined ? {} : { currentSpan: options.currentSpan }),
  });
}

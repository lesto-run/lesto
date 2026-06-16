/**
 * The wiring facade — one place an app turns env + seams into live traces.
 *
 * The pieces below it (`Tracer`, `OtlpHttpExporter`, the W3C `traceparent`
 * primitive) are deliberately small and unopinionated. THIS is where they meet
 * the rest of Keel: it reads the two-env-var setup, builds the exporter and
 * tracer, drives the flush lifecycle (an interval for a long-lived node service,
 * an explicit `flush()` for an edge worker's `waitUntil` or a drain), and turns
 * every per-domain `on*` seam other packages exposed into a child span under the
 * request currently in flight.
 *
 * The contract this file defines is the one `@keel/cloudflare` (edge-deploy #3)
 * mirrors: the env-var names + semantics, the exporter/tracer construction, and
 * the `flush()` API `waitUntil` calls. The node tier wires it here; the edge
 * adapter wires the SAME shape with its own `waitUntil` arity.
 */

import { OtlpHttpExporter } from "./otlp";
import type { OtlpHttpExporterOptions } from "./otlp";
import { Tracer } from "./tracer";
import type { InboundTrace } from "./tracer";
import type { Span } from "./types";

/**
 * The environment a {@link tracesFromEnv} reads — the two-env-var setup, plus a
 * couple of optional knobs. Just the slice of `process.env` we need, so a test
 * passes a literal and a worker passes its `env` binding.
 *
 * THE CONTRACT (mirrored by the edge adapter):
 *
 *   - `KEEL_OTLP_URL`     — the collector's trace endpoint, e.g.
 *                           `http://localhost:4318/v1/traces`. ABSENT disables
 *                           tracing entirely (no exporter, no spans, zero cost) —
 *                           the safe default, so an app with no collector pays
 *                           nothing and an operator opts in by setting one var.
 *   - `KEEL_OTLP_SERVICE` — the `service.name` resource attribute. Defaults to
 *                           `"keel"`.
 *   - `KEEL_OTLP_HEADERS` — extra request headers as a comma-separated
 *                           `key=value` list (an auth token, a tenant id), e.g.
 *                           `authorization=Bearer t,x-tenant=acme`. Absent = none.
 */
export interface TracesEnv {
  readonly KEEL_OTLP_URL?: string | undefined;
  readonly KEEL_OTLP_SERVICE?: string | undefined;
  readonly KEEL_OTLP_HEADERS?: string | undefined;
}

/**
 * Parse the `KEEL_OTLP_HEADERS` comma-separated `key=value` list into a header
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
 * Injected (rather than importing `@keel/web`'s `currentContext` here) so this
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
 * The per-domain seam hooks, each shaped to slot straight into the battery that
 * raises it (see the Phase-1 signatures). Every one turns its event into a span:
 * a child of the in-flight request span when there is one, a root span when
 * there is not (a background worker, a startup task).
 */
export interface TraceSeams {
  /** `@keel/db`'s `onQuery` — each executed query becomes a `db.query` child span. */
  onQuery(event: { readonly sql: string; readonly durationMs: number }): void;

  /** `@keel/queue`'s `onJob` — each finished job becomes a `queue.job` span. */
  onJob(event: {
    readonly queue: string;
    readonly id: number;
    readonly name: string;
    readonly outcome: "done" | "retry" | "failed";
    readonly attempt: number;
    readonly durationMs: number;
  }): void;

  /** `@keel/identity`'s `onEvent` — each lifecycle event becomes an `identity.<type>` span. */
  onEvent(event: { readonly type: string; readonly userId?: string; readonly at: number }): void;

  /** `@keel/mail`'s `onDelivered` — a `mail.delivered` span per accepted email. */
  onDelivered(event: {
    readonly mailerName: string;
    readonly jobId: number;
    readonly attempt: number;
  }): void;

  /** `@keel/mail`'s `onFailed` — a `mail.failed` (error-status) span per failed attempt. */
  onFailed(event: {
    readonly mailerName: string;
    readonly jobId: number;
    readonly attempt: number;
    readonly code: string;
  }): void;

  /** The `runWorker` `onError` sink — a `worker.poll_failed` error span per poll fault. */
  onWorkerError(error: { readonly code: string; readonly message: string }): void;

  /** `@keel/web`'s `clientErrors` sink — a `client.island_error` span per browser beacon. */
  onClientError(event: {
    readonly failed: readonly string[];
    readonly missing: readonly string[];
    readonly failedCount: number;
    readonly missingCount: number;
  }): void;
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
 * `KEEL_OTLP_URL` is the on switch: absent, we return `undefined` and the app
 * runs with NO tracer (zero spans, zero overhead). Present, we construct an
 * `OtlpHttpExporter` over the parsed headers + service name, a `Tracer` over it,
 * and the live handle. `currentSpan` and `fetchFn` are injected so the runtime
 * wires the request-span seam and a worker passes its own `fetch`.
 *
 * This is the construction the CLI calls for `keel serve`/`dev`; the edge adapter
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
  const url = env.KEEL_OTLP_URL;

  // The on switch: no collector configured means no tracing at all.
  if (url === undefined || url === "") return undefined;

  const exporterOptions: OtlpHttpExporterOptions = {
    url,
    headers: parseOtlpHeaders(env.KEEL_OTLP_HEADERS),
    serviceName: env.KEEL_OTLP_SERVICE ?? "keel",
    ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  };

  const exporter = new OtlpHttpExporter(exporterOptions);

  const tracer = new Tracer({ exporter });

  return createTraces({
    tracer,
    flush: () => exporter.flush(),
    ...(options.currentSpan === undefined ? {} : { currentSpan: options.currentSpan }),
  });
}

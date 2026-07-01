import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { App } from "@lesto/kernel";
import {
  bodyForStatus,
  DEFAULT_SECURITY_HEADERS,
  RECOMMENDED_CSP,
  runWithContext,
  securityDefaults,
  statusForError,
  withSecurityHeaders,
} from "@lesto/web";
import type {
  AnyLestoResponse,
  LestoResponse,
  RequestContext,
  SecurityHeaderOptions,
} from "@lesto/web";

// The hardening pieces now live in @lesto/web so the node server and the edge
// adapter share one source (see `@lesto/web/harden`). Re-exported here so the
// runtime's public surface and its tests keep reaching them at the same names.
export { DEFAULT_SECURITY_HEADERS, RECOMMENDED_CSP, securityDefaults, withSecurityHeaders };
export type { SecurityHeaderOptions };

import {
  applyResponse,
  encodeBuffered,
  encodeStreamHeaders,
  isCompressibleType,
  negotiateEncoding,
} from "./response";
import type { ContentEncoding } from "./response";
import { toLestoRequest } from "./request";
import { RuntimeError } from "./errors";
import { etagFor, etagMatches, respondNotModified } from "./http-cache";
import { peerIsTrusted, resolveClient } from "./trust-proxy";

import type { ForwardHeaders, TrustProxy } from "./trust-proxy";
import type { NotModifiedResponse } from "./http-cache";

/** A running http server bound to a port, with a graceful shutdown. */
export interface Server {
  readonly port: number;

  close(): Promise<void>;
}

/** Liveness/readiness endpoints, answered by the runtime before the app. */
export interface HealthOptions {
  /** The liveness path — a bare 200 proving the process is up. Defaults to `/health`. */
  readonly livePath?: string;

  /** The readiness path — 200 when {@link isReady} holds, else 503. Defaults to `/readyz`. */
  readonly readyPath?: string;

  /** Whether the app is ready to take traffic (DB reachable, warmed, …). Defaults to always-ready. */
  readonly isReady?: () => boolean | Promise<boolean>;

  /**
   * The longest the readiness probe may run before it is treated as not-ready
   * (a 503). A probe that pings a wedged database must not hold `/readyz` open —
   * an orchestrator needs a prompt "not ready", not a hung socket. Defaults to
   * 1s.
   */
  readonly readyTimeoutMs?: number;
}

/**
 * One span over one served request — the narrow tracing surface the server
 * mints through.
 *
 * Structurally satisfied by `@lesto/observability`'s `Span`/`Tracer`, so the
 * runtime records real traces without depending on the tracing package: what
 * varies is injected, as everywhere else in this file. `data` exposes the span's
 * trace + span ids so the request context can carry the span as the parent for
 * any child span a seam (a db query, a queue job) opens during the request, and
 * so the join with an inbound `traceparent` is recorded on the right trace id.
 */
export interface RequestSpan {
  setAttribute(key: string, value: unknown): unknown;

  setStatus(status: "ok" | "error"): unknown;

  end(): void;

  /**
   * The span's flat record — at minimum its `traceId`/`spanId`, the ids a child
   * span and the outbound `traceparent` read. `@lesto/observability`'s `Span.data`
   * satisfies this; the runtime reads only what it needs.
   */
  readonly data: { readonly traceId: string; readonly spanId: string };
}

/**
 * The inbound trace context the server adopts from a W3C `traceparent` header, so
 * the request's root span JOINS the upstream trace rather than starting a fresh
 * one. Structurally what `@lesto/observability`'s `parseTraceparent` returns.
 */
export interface InboundTrace {
  /** The 32-hex trace id this request belongs to — the root span adopts it. */
  readonly traceId: string;

  /** The 16-hex caller span id — the parent of the root span we mint. */
  readonly parentId: string;
}

/**
 * Mints {@link RequestSpan}s — `@lesto/observability`'s `Tracer`, structurally.
 *
 * `startSpan` optionally takes an {@link InboundTrace}: when an inbound
 * `traceparent` was parsed, the runtime passes it so the request span continues
 * that trace (same `traceId`, parented on the caller's span). Absent, the span
 * roots a new trace, as before.
 */
export interface RequestTracer {
  startSpan(name: string, inbound?: InboundTrace): RequestSpan;
}

/** Parses a W3C `traceparent` header — `@lesto/observability`'s parser, structurally. */
export type TraceparentParser = (header: string | undefined) => InboundTrace | undefined;

/** One served request, as the access log records it. */
export interface AccessEntry {
  readonly method: string;

  readonly path: string;

  readonly status: number;

  readonly ms: number;

  /**
   * The per-request id minted for this request (see {@link RequestContext}).
   *
   * The same id the request context carries, so an access line and any
   * context-tagged work the handler logged can be stitched into one trace.
   */
  readonly requestId: string;

  /**
   * Whether the response body was truncated — the stream tore down mid-flight
   * (the producer errored, or the client hung up) so the client received an
   * incomplete body. Present (`true`) only on a truncated streamed response;
   * absent on a clean response, which is the common case the log stays quiet
   * about. The runtime's tracer reads the same fact off the span attribute
   * `lesto.response.truncated`.
   */
  readonly truncated?: boolean;

  /**
   * The number of long-lived streams held open at the instant this access line
   * was emitted — the active-stream gauge (ADR 0040). A held stream logs at FIRST
   * BYTE (not at teardown, hours later), carrying this gauge, so a fleet of live
   * connections is visible in the log the moment each opens. Present only on a
   * long-lived-stream access line; absent on every ordinary request.
   */
  readonly activeStreams?: number;
}

/** Tuning for the long-lived-stream endpoint (ADR 0040 — see {@link ServeOptions.liveStream}). */
export interface LiveStreamOptions {
  /** The reserved topic-stream path a `GET` is recognized at (ADR 0040). Defaults to `/__lesto/live`. */
  readonly path?: string;

  /**
   * The reserved local-first **data**-stream path a `GET` is recognized at (ADR 0042
   * Tier 4). A second held-stream endpoint beside {@link path}, sharing the same stream
   * semaphore + per-IP ceiling. Defaults to `/__lesto/live-data`. Both paths are
   * recognized by default — an app mounts a handler at whichever it uses.
   */
  readonly dataPath?: string;

  /**
   * The global ceiling on concurrent held streams — the dedicated backstop that
   * replaces the in-flight gate for streams. Defaults to 10,000.
   */
  readonly maxConcurrent?: number;

  /**
   * The per-client-IP ceiling on concurrent held streams — the anonymous-flood
   * backstop, so one source cannot drain the global pool. Defaults to 100.
   */
  readonly maxPerIp?: number;
}

export interface ServeOptions {
  readonly port?: number;

  readonly host?: string;

  /**
   * The largest request body we will read off a socket, in bytes.
   *
   * A request that exceeds this is refused with a 413 and its socket torn down,
   * so an unauthenticated client cannot exhaust memory by streaming an
   * unbounded body. Defaults to 1 MiB.
   */
  readonly maxBodyBytes?: number;

  /**
   * A tighter cap for `application/json` bodies — the JSON limit is the smaller
   * of this and {@link maxBodyBytes}. Lets a deploy accept large uploads (raise
   * `maxBodyBytes`) while keeping JSON payloads — and thus `JSON.parse` blast
   * radius — bounded independently. Defaults to 1 MiB (so it changes nothing until
   * either knob moves); tune it down for an endpoint taking untrusted JSON.
   */
  readonly maxJsonBodyBytes?: number;

  /**
   * The longest a single handler may run before we answer 503 and free the
   * socket. On overrun the request's own `context.signal` is ABORTED (with a
   * coded `RUNTIME_HANDLER_TIMEOUT` reason), so a cooperative handler — a
   * streaming render, an upstream fetch that takes an `AbortSignal` — actually
   * stops rather than running on for a response no one will read; the socket and
   * client are freed regardless. JS cannot kill a non-cooperative running task,
   * so an uncooperative handler is still abandoned, but it can no longer
   * accumulate as a zombie holding live resources past the deadline. Defaults to
   * 30s.
   *
   * This bounds a slow *async* handler (one awaiting I/O): the deadline is a
   * `setTimeout`, so it can only fire when the event loop is free to run it. It
   * is NOT a defense against event-loop-*blocking* synchronous work — a
   * catastrophic regex (ReDoS), a `while(true)`, or a huge synchronous
   * `JSON.parse` — which starves the timer and every other request alike. That
   * class is defended by not writing it (e.g. the router refuses ambiguous
   * backtracking patterns), not by this timeout.
   */
  readonly handlerTimeoutMs?: number;

  /**
   * node:http socket-level limits, set below Node's defaults so a public tier
   * resists slow-loris / slow-body / oversized-header attacks out of the box.
   * See {@link applyServerLimits}. Defaults: request 30s, headers 15s,
   * keep-alive 5s, max header 16 KiB.
   */
  readonly requestTimeoutMs?: number;

  readonly headersTimeoutMs?: number;

  readonly keepAliveTimeoutMs?: number;

  readonly maxHeaderBytes?: number;

  /**
   * How long a graceful shutdown waits for in-flight requests to finish before
   * forcing the remaining sockets closed. Defaults to 10s.
   */
  readonly drainTimeoutMs?: number;

  /**
   * Backstop on connection/request VOLUME (the layer the per-request limits don't
   * cover). `maxConnections` caps live TCP connections (node refuses past it);
   * `maxInFlightRequests` sheds a graceful 503 once that many requests are in
   * flight. Defaults 10000 / 1000 — generous backstops, not edge flood control.
   */
  readonly maxConnections?: number;

  readonly maxInFlightRequests?: number;

  /**
   * Liveness/readiness endpoints, on by default at `/health` and `/readyz`.
   * Pass `false` to disable them (e.g. when an upstream owns those paths), or an
   * object to override the paths and supply a real readiness probe.
   */
  readonly health?: false | HealthOptions;

  /**
   * Default response headers merged *under* every response — the app's own
   * headers always win. Defaults to {@link DEFAULT_SECURITY_HEADERS}; pass
   * `false` to send none, or a map to replace the defaults wholesale.
   */
  readonly securityHeaders?: false | Record<string, string>;

  /**
   * A Content-Security-Policy, off by default.
   *
   * No enforcing CSP is sent unless one is configured: Lesto's island bootstrap
   * inlines JSON via a `<script>`, which a strict default policy would break.
   * Set `mode: "enforce"` to block violations or `mode: "report-only"` to
   * observe them without enforcement (the safe way to roll a policy out — emits
   * `Content-Security-Policy-Report-Only`). See {@link RECOMMENDED_CSP} for a
   * sane starting point. Merged under the response like every security header,
   * so a route may override it.
   */
  readonly csp?: { readonly policy: string; readonly mode: "enforce" | "report-only" };

  /**
   * Opt in to `Cross-Origin-Embedder-Policy: require-corp` (off by default).
   *
   * COEP unlocks cross-origin isolation (`SharedArrayBuffer`, precise timers)
   * but breaks any cross-origin subresource that does not opt in with CORP/CORS,
   * so it can never be a safe default — only an app that knows its subresources
   * comply should turn it on.
   */
  readonly crossOriginEmbedderPolicy?: boolean;

  /**
   * Conditional-GET behaviour for dynamic/HTML responses.
   *
   * When on (the default), the runtime hashes an HTML response body into an
   * `ETag`, and a request whose `If-None-Match` still matches is answered with a
   * bodiless 304 — the client reuses its cached copy. Pass `false` to disable,
   * or `{ weak: true }` to emit weak validators. Only responses without an ETag
   * of their own and without a body-changing status are tagged; the app may
   * always set its own `ETag` and opt a given response out.
   */
  readonly etag?: false | { readonly weak?: boolean };

  /**
   * Response compression, negotiated from the request's `Accept-Encoding`.
   *
   * On by default: a text-shaped response (HTML, JSON, JS, CSS, SVG — the
   * allowlist in `response.ts`) whose client accepts it is sent Brotli- or
   * gzip-compressed (Brotli preferred), with `Content-Encoding` and a
   * `Vary: Accept-Encoding`. A buffered body is compressed up front and gains an
   * accurate `Content-Length`; a streamed body is compressed on the fly through a
   * zlib transform. Already-encoded bodies and non-text types are left untouched,
   * and a client that accepts neither coding gets the body verbatim — but a
   * buffered body still gains its `Content-Length`. Pass `false` to disable
   * compression wholesale (e.g. when a CDN in front already compresses).
   */
  readonly compress?: false;

  /**
   * The long-lived streaming endpoints — ADR 0040's SSE topic fan-out (mounted by the
   * app at `/__lesto/live`) and ADR 0042's local-first data stream (`/__lesto/live-data`).
   * Both reserved paths are on by default.
   *
   * A `GET` on its path is recognized as a held stream BEFORE admission (a route
   * predicate, like the health-probe bypass), so it does **not** consume an
   * in-flight slot — a held SSE connection that took one would occupy it for its
   * whole life and self-DoS the node at the in-flight cap. It is bounded instead
   * by a dedicated global stream semaphore plus a per-client-IP ceiling (the
   * anonymous-flood backstop); over either is a coded 503. The handler is also
   * exempt from `handlerTimeoutMs` (a live stream must outlive it) and the access
   * line is logged at first byte with an active-stream gauge.
   *
   * Pass `false` to disable the special handling (the reserved path then falls
   * through the ordinary gate), or an object to override the path and the
   * ceilings. The per-PRINCIPAL connection cap lives in the SSE handler itself,
   * where the principal is resolved — not here.
   */
  readonly liveStream?: false | LiveStreamOptions;

  /**
   * Whom to believe about the client IP and protocol (see {@link TrustProxy}).
   *
   * Default: `false` — trust nothing. The client IP is the socket's own peer
   * address and the protocol is plain `http`. The `X-Forwarded-For` /
   * `X-Forwarded-Proto` headers are *trivially forged by any client*, so they
   * are believed only when the immediate peer is a proxy you put there: set this
   * to `true` (one trusted hop — the RIGHT-most XFF entry, the spoof-safe default
   * for `LB -> app`), a hop count `n` (peel `n` trusted hops from the right), a
   * predicate over the peer address (peels trusted hops right-to-left), or the
   * explicit `"all"` escape hatch (trust the whole client-supplied chain and take
   * the LEFT-most, forgeable, entry) when deployed behind a known load balancer.
   * The resolved identity lands on the request context for rate-limiting and
   * logging.
   */
  readonly trustProxy?: TrustProxy;

  /**
   * Where a one-line access record goes for each served request. Injected so a
   * test can assert without writing to the console; defaults to
   * {@link defaultLogRequest}, which now emits a structured JSON line (one object
   * per request: method, path, status, ms, request_id, and `truncated` when the
   * body was torn down mid-stream) so a log pipeline parses it rather than
   * scraping a string. The seam signature is unchanged — a custom sink still
   * receives the {@link AccessEntry} and formats it however it likes.
   */
  readonly logRequest?: (entry: AccessEntry) => void;

  /**
   * Mints one span per served request — the trace counterpart of the access
   * log. Off by default (no tracer, no spans, zero overhead); pass
   * `@lesto/observability`'s request tracer (it satisfies this structurally, so
   * the runtime takes no dependency) and every request records a `http.request`
   * span carrying method, path, status, and the request id, with `error`
   * status on a 5xx. The span is also published on the request context
   * (`context.span`), so a seam fired during the request — a db query, an inline
   * queue job — parents its child span on it.
   */
  readonly tracer?: RequestTracer;

  /**
   * Parses a W3C `traceparent` request header into the inbound trace the root
   * span joins, so a cross-service request continues ONE trace rather than
   * starting a fresh one per hop. Injected (not imported) so the runtime stays
   * free of the tracing package — pass `@lesto/observability`'s `parseTraceparent`.
   * Absent (or no inbound header) roots a new trace, as before. Only consulted
   * when a {@link tracer} is also set.
   */
  readonly parseTraceparent?: TraceparentParser;

  /**
   * A drain hook run once during a graceful shutdown, AFTER in-flight requests
   * finish — where the tracer flushes its last buffered spans to the collector
   * so a deploy's rolling restart does not drop the final batch. Injected so the
   * runtime takes no dependency on the tracer; the CLI wires it to
   * `traces.flush()`. Awaited (its rejection is contained) before `close()`
   * resolves. Absent → nothing extra runs on drain.
   */
  readonly onDrain?: () => Promise<void>;

  /** The clock used for request latency. Injected for tests; defaults to `Date.now`. */
  readonly now?: () => number;

  /**
   * Mints the per-request id put on the request context. Injected so a test can
   * assert a stable id; defaults to `node:crypto.randomUUID`.
   */
  readonly newRequestId?: () => string;

  /**
   * Where uncaught server-level failures are reported.
   *
   * Injected so a test can assert the process safety-net logged without writing
   * to the real console. Defaults to `console.error`.
   */
  readonly logError?: (message: string, error: unknown) => void;
}

/** A body we refuse to read past 1 MiB unless the caller raises the bar. */
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

/**
 * A SEPARATE, tighter-by-intent cap for `application/json` bodies — the effective
 * JSON limit is `min(maxBodyBytes, maxJsonBodyBytes)`. The body cap already bounds
 * how much we read, so a giant sync `JSON.parse` is already blunted at 1 MiB; the
 * value here is that JSON stays bounded INDEPENDENTLY of the general cap. Raise
 * `maxBodyBytes` to accept large file uploads and a request's JSON payload is
 * still capped at 1 MiB (parse-stall blast radius does not grow with the upload
 * limit). Tune it DOWN for an endpoint taking untrusted JSON. Default 1 MiB, so a
 * deploy that never touches either knob behaves exactly as before.
 */
const DEFAULT_MAX_JSON_BODY_BYTES = 1024 * 1024;

/** Handler/socket budgets, tightened below Node's defaults for a public tier. */
const DEFAULT_HANDLER_TIMEOUT_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_HEADERS_TIMEOUT_MS = 15_000;
const DEFAULT_KEEP_ALIVE_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_HEADER_BYTES = 16 * 1024;
const DEFAULT_DRAIN_TIMEOUT_MS = 10_000;

/**
 * Backstop caps on connection and in-flight-request VOLUME — the layer the
 * per-request limits don't cover. The body cap and handler timeout stop one
 * request from crashing or hanging the process, but a cheap unauthenticated
 * flood of *many* connections/requests can still exhaust sockets and memory
 * beneath them. `maxConnections` refuses TCP past the cap (node-native); the
 * in-flight semaphore sheds a graceful 503 once that many requests are in flight.
 * Both are generous enough not to touch normal traffic and tune UP via
 * `LESTO_MAX_CONNECTIONS` / `LESTO_MAX_IN_FLIGHT_REQUESTS`. Heavy edge flood
 * protection is still the CF/LB's job; this is the node's own backstop.
 */
const DEFAULT_MAX_CONNECTIONS = 10_000;
const DEFAULT_MAX_IN_FLIGHT_REQUESTS = 1_000;

const DEFAULT_LIVE_PATH = "/health";
const DEFAULT_READY_PATH = "/readyz";

/**
 * The reserved path the long-lived-stream (SSE) realtime fan-out is mounted at
 * (ADR 0040). A `GET` here is recognized as a held stream BEFORE admission, so it
 * is exempt from the in-flight gate and bounded by its own stream semaphore.
 */
const DEFAULT_LIVE_STREAM_PATH = "/__lesto/live";

/**
 * The reserved path the local-first **data** stream is mounted at (ADR 0042 Tier 4).
 * A second long-lived-stream endpoint beside the ADR 0040 topic fan-out: same held-
 * stream handling (no in-flight slot, no compression, its own semaphore), a different
 * wire — it carries auth-scoped row data, not invalidation topics.
 */
const DEFAULT_LIVE_DATA_PATH = "/__lesto/live-data";

/**
 * Default ceilings for held streams. The global cap is the dedicated backstop the
 * in-flight gate (1,000) no longer provides for streams — generous, aligned with
 * the connection cap, since a stream IS a connection. The per-IP cap is the
 * anonymous-flood backstop: one client IP can hold at most this many streams, so
 * a single source cannot drain the global pool (a browser opens at most a handful
 * of SSE per origin, so 100 leaves ample room for many tabs).
 */
const DEFAULT_MAX_CONCURRENT_STREAMS = 10_000;
const DEFAULT_MAX_STREAMS_PER_IP = 100;

/**
 * The method and path of an incoming request.
 *
 * Node types `method`/`url` as optional, yet a *server* request always carries
 * both. We still default them — defensively, and so the narrowing is honest
 * rather than a cast — and unit-test both branches with a fake message.
 */
export function requestLineOf(req: Pick<IncomingMessage, "method" | "url">): {
  method: string;
  url: string;
} {
  return {
    method: req.method ?? "GET",
    url: req.url ?? "/",
  };
}

/**
 * The pathname of a raw request URL — the query stripped off.
 *
 * Computed from the request line BEFORE the body is read, so a 413 (body over the
 * limit, which rejects mid-`readBody`) is still attributed to the real path in
 * the access log rather than a default. Mirrors `toLestoRequest`'s pathname
 * extraction (same throwaway base, same `URL.pathname`) so the early-attributed
 * path is byte-identical to the one a successfully-parsed request would carry.
 */
export function pathOf(url: string): string {
  return new URL(url, "http://localhost").pathname;
}

/**
 * Read the `If-None-Match` validator from request headers as a single string.
 *
 * node:http delivers most request headers as a string, but a header sent more
 * than once can arrive as a string array; we join such a list back into the
 * comma-separated form {@link etagMatches} already splits on, so a client that
 * (oddly) sent two `If-None-Match` lines still matches. Absent means absent.
 *
 * We take the broad raw-header shape rather than node's narrowed
 * `IncomingHttpHeaders` (which types this one header as a bare string): the
 * array case is real at runtime, so we handle it honestly and test it.
 */
export function ifNoneMatch(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  const value = headers["if-none-match"];

  if (value === undefined) return undefined;

  return Array.isArray(value) ? value.join(", ") : value;
}

/**
 * The slice of an `IncomingMessage` {@link readBody} drives.
 *
 * Narrow on purpose: a fake `EventEmitter`-shaped object satisfies it, so the
 * size-limit and stream-error branches are unit-testable without a live socket.
 */
export interface BodyStream {
  on(event: "data", listener: (chunk: Buffer) => void): unknown;

  on(event: "end", listener: () => void): unknown;

  on(event: "error", listener: (error: Error) => void): unknown;
}

/**
 * Read the full request body off the socket as a UTF-8 string, bounded.
 *
 * We tally bytes as chunks arrive and reject the moment the running total would
 * exceed `maxBytes` — dropping what we have buffered so memory stays bounded,
 * and ignoring every later chunk so a client streaming gigabytes can never grow
 * our heap. We do NOT destroy the socket here: the caller still needs to flush a
 * 413 back, and tearing the connection down first races that write. A stream
 * `error` (a client that hangs up mid-body, a reset connection) also rejects,
 * rather than leaving the promise to dangle forever.
 *
 * The invariant: this promise always settles, and never holds more than
 * `maxBytes` of body in memory.
 */
export function readBody(req: BodyStream, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let chunks: Buffer[] = [];

    let total = 0;

    let aborted = false;

    req.on("data", (chunk: Buffer) => {
      // Already over the limit: discard, do not buffer, do not reject twice.
      if (aborted) {
        return;
      }

      total += chunk.length;

      if (total > maxBytes) {
        aborted = true;

        // Free what we held — the body is refused, the bytes are dead weight.
        chunks = [];

        reject(
          new RuntimeError("RUNTIME_BODY_TOO_LARGE", "Request body exceeds the size limit.", {
            maxBytes,
          }),
        );

        return;
      }

      chunks.push(chunk);
    });

    req.on("end", () => {
      if (aborted) {
        return;
      }

      resolve(Buffer.concat(chunks).toString("utf8"));
    });

    req.on("error", (error) => reject(error));
  });
}

/**
 * The narrow slice of a request body {@link drainBody} touches — a `Readable`'s
 * `resume()`. Narrow on purpose, so a fake satisfies it without a live socket.
 */
export interface DrainableBody {
  resume(): void;
}

/**
 * Drain and discard a request body without buffering it.
 *
 * The long-lived-stream path ({@link handleStream}) never READS its request body —
 * an SSE `GET` carries none by contract. But a client MAY legally attach one, and
 * an unread body then sits in the socket's receive buffer for the stream's whole
 * life. TCP backpressure caps that at ~one socket buffer (so this is hygiene, not
 * a DoS), yet over the global stream ceiling it is a needless amplification — so we
 * drain it: `resume()` puts the body into flowing mode and throws every chunk on
 * the floor, so the kernel buffer empties and nothing accumulates on our heap.
 *
 * Fire-and-forget BY DESIGN — we must NOT `await` the body's `end` here: a
 * dribbled/slow body would hang the stream's opening behind a body no one reads.
 * We only let it flow; we never wait for it (unlike {@link readBody}, which the
 * ordinary path awaits because it needs the bytes).
 */
export function drainBody(req: DrainableBody): void {
  req.resume();
}

/**
 * Race a promise against a deadline.
 *
 * On overrun we reject with a coded {@link RuntimeError} (mapped to a 503) and
 * leave `work` to settle whenever it eventually does — we attach handlers to it
 * so its late resolution or rejection is swallowed, never surfacing as an
 * unhandled rejection. The timer is `unref`'d so a pending deadline never keeps
 * the process alive on its own.
 *
 * `onTimeout`, when given, fires once at the deadline BEFORE the rejection — the
 * transport passes the request's `abortTimeout` here, so the deadline both frees
 * the socket (the 503) AND aborts the handler's `context.signal`: a cooperative
 * handler stops working rather than running on as a zombie. It is called at most
 * once (only if the timer wins the race); a handler that settles first clears the
 * timer and `onTimeout` never runs.
 */
export function withTimeout<T>(work: Promise<T>, ms: number, onTimeout?: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout?.();

      reject(
        new RuntimeError("RUNTIME_HANDLER_TIMEOUT", "Request handler exceeded its time limit.", {
          ms,
        }),
      );
    }, ms);

    timer.unref();

    work.then(
      (value) => {
        clearTimeout(timer);
        return resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        return reject(error);
      },
    );
  });
}

/** How long a readiness probe may run before the probe itself is treated as not-ready. */
const DEFAULT_READY_TIMEOUT_MS = 1_000;

/**
 * Run the readiness probe, but never let it hang the endpoint.
 *
 * A readiness probe typically pings the database; if that ping wedges (a
 * connection pool exhausted, a network partition) an unbounded `await` would
 * hold the `/readyz` request open forever — and an orchestrator polling readiness
 * would see a hung socket rather than the "not ready" it needs to stop routing
 * traffic. So we race the probe against a short deadline: an overrun is itself a
 * "not ready" signal (a probe that cannot answer in a second is not healthy),
 * returning `false` rather than throwing, so the endpoint always answers 503
 * promptly. A probe that loses the race is left to settle on its own (its result
 * is ignored). Pure over the injected `now`-free timer so the overrun branch is
 * testable without real waiting.
 */
export function probeReady(
  isReady: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  // The deadline: a `false` (not-ready) that wins the race when the probe hangs.
  // `unref`'d so a pending probe deadline never keeps the process alive on its own.
  const deadline = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);

    timer.unref();
  });

  // The probe, run through `Promise.resolve().then` so a *synchronous* throw is
  // funneled into the same rejected-promise path as an async one; a throw (sync
  // or async) is "not ready", never a crash of the endpoint.
  const probe = Promise.resolve()
    .then(isReady)
    .catch(() => false);

  return Promise.race([probe, deadline]);
}

/**
 * Answer a liveness/readiness probe, or `undefined` to let the app handle it.
 *
 * Liveness (`/health`) is a bare 200 — the process is up. Readiness (`/readyz`)
 * consults the injected probe — bounded by {@link probeReady}, so a wedged probe
 * answers 503 rather than hanging the endpoint — and is a 503 when the app is not
 * ready to take traffic. Both answer only GET/HEAD; anything else falls through
 * to the app so a real route at the same path still works.
 */
export async function healthResponse(
  method: string,
  path: string,
  options: HealthOptions,
  readyTimeoutMs: number = DEFAULT_READY_TIMEOUT_MS,
): Promise<LestoResponse | undefined> {
  if (method !== "GET" && method !== "HEAD") return undefined;

  const headers = { "content-type": "text/plain; charset=utf-8" };

  if (path === (options.livePath ?? DEFAULT_LIVE_PATH)) {
    return { status: 200, headers, body: "ok" };
  }

  if (path === (options.readyPath ?? DEFAULT_READY_PATH)) {
    const ready = await probeReady(options.isReady ?? (() => true), readyTimeoutMs);

    return ready
      ? { status: 200, headers, body: "ready" }
      : { status: 503, headers, body: "not ready" };
  }

  return undefined;
}

/** Whether ETag is on, and whether it emits weak validators. */
export type EtagConfig = false | { readonly weak?: boolean };

/**
 * A response with an `ETag` attached, when conditional GET applies to it.
 *
 * We only tag a response that is *cacheable and validatable*: a 200 with an HTML
 * body, where the app has not already set its own `ETag`. Anything else passes
 * through untouched — a redirect, an error, a non-HTML payload, or a response
 * whose handler took ownership of caching. The returned response always carries
 * the headers to write; `etag` is the value to compare `If-None-Match` against,
 * or `undefined` when no tag was added (so the caller skips the 304 check).
 *
 * Pure and exported so every branch — disabled, already-tagged, non-200,
 * non-HTML, the happy strong/weak tag — is unit-testable without a socket.
 */
export function withEtag(
  response: AnyLestoResponse,
  config: EtagConfig,
): { response: AnyLestoResponse; etag: string | undefined } {
  if (config === false) {
    return { response, etag: undefined };
  }

  // The app owns caching for this response if it set its own validator; never
  // overwrite it. Header names arrive lowercased through the stack, but an app
  // may set any casing, so match case-insensitively.
  const hasOwnEtag = Object.keys(response.headers).some((name) => name.toLowerCase() === "etag");

  if (hasOwnEtag) {
    return { response, etag: undefined };
  }

  // Only a 200 is safely revalidatable as a whole entity; a redirect or error
  // carries no cacheable body to 304 against.
  if (response.status !== 200) {
    return { response, etag: undefined };
  }

  // ETag-for-304 is about HTML pages (the dynamic/SSR path); other content types
  // either carry their own caching (static assets, below) or are one-shot.
  if (!isHtml(response.headers)) {
    return { response, etag: undefined };
  }

  // A streamed body cannot be tagged: an ETag is a hash of the bytes, and
  // hashing a stream means draining it — consuming the very body we still owe
  // the client. So a stream (the streaming-SSR path, later) is sent untagged;
  // only a fully-buffered body (string or bytes) can be hashed and 304'd.
  if (response.body instanceof ReadableStream) {
    return { response, etag: undefined };
  }

  const etag = etagFor(response.body, { weak: config.weak });

  return { response: { ...response, headers: { ...response.headers, ETag: etag } }, etag };
}

/** True iff a header map declares an HTML content-type (any header casing). */
function isHtml(headers: Record<string, string | string[]>): boolean {
  return Object.entries(headers).some(
    ([name, value]) =>
      name.toLowerCase() === "content-type" &&
      // Content-Type is single-valued in practice; collapse a (degenerate) list
      // before the check so the function is total over the widened header map.
      (Array.isArray(value) ? value.join(", ") : value).toLowerCase().includes("text/html"),
  );
}

/**
 * Apply the negotiated content encoding to a response just before it is written.
 *
 * The single decision point that ties together the pure pieces in `response.ts`:
 *
 *   - Compression off (`enabled` is `false`): the response goes out untouched —
 *     no encoding, no `Content-Length` added. Disabling means hands-off, for a
 *     deployment whose CDN already compresses.
 *   - A BUFFERED body (string or bytes): always re-emitted through
 *     {@link encodeBuffered}, so it gains an accurate `Content-Length`. When the
 *     type is compressible and the client accepts a coding, that body is
 *     Brotli/gzip-compressed (the length is the compressed size); otherwise it is
 *     left as bytes with its uncompressed length. `streamEncoding` is absent.
 *   - A STREAMED body: when the type is compressible and a coding is accepted,
 *     {@link encodeStreamHeaders} stamps `Content-Encoding`/`Vary` and the chosen
 *     coding is returned as `streamEncoding` for {@link applyResponse} to insert
 *     the zlib transform; a stream has no known length, so no `Content-Length`.
 *     Otherwise the stream passes through verbatim.
 *
 * Pure over its inputs and exported, so the whole negotiation matrix — each
 * coding × {buffered, stream, non-compressible, already-encoded, disabled} — is
 * unit-testable without a socket. The returned `streamEncoding`, when present, is
 * the coding `applyResponse` compresses the stream with.
 */
export function compressResponse(
  response: AnyLestoResponse,
  acceptEncoding: string | undefined,
  enabled: boolean,
): { response: AnyLestoResponse; streamEncoding?: ContentEncoding } {
  if (!enabled) return { response };

  const { body } = response;

  // A streamed body: compress on the fly when worth it, else pass it through. No
  // `Content-Length` either way — a stream's size is unknown until it ends.
  if (body instanceof ReadableStream) {
    if (!isCompressibleType(response.headers)) return { response };

    const encoding = negotiateEncoding(acceptEncoding);

    if (encoding === "identity") return { response };

    return { response: encodeStreamHeaders(response, encoding), streamEncoding: encoding };
  }

  // A buffered body (string or bytes): always re-emitted with an accurate
  // `Content-Length`. Compressible-and-accepted → the negotiated coding; anything
  // else → `identity` (just the length), so even an image gains its length.
  const encoding = isCompressibleType(response.headers)
    ? negotiateEncoding(acceptEncoding)
    : "identity";

  return { response: encodeBuffered(response, body, encoding) };
}

/**
 * Harden a handler's response into the bytes we put on the wire: merge the default
 * security headers UNDER it (the app's own headers win) and echo the `X-Request-Id`
 * so a client and the server logs share one correlation id. The single place both
 * serving paths ({@link handleAdmitted}, {@link handleStream}) turn a handler's
 * response into a hardened one, so a future change to what "hardened" means lands
 * once. Kept separate from {@link writeNegotiated} because the 304 fast path needs
 * these hardened headers WITHOUT a body encoding (a bodiless 304 must not carry a
 * `Content-Encoding`), so hardening must be callable before that split.
 */
function hardenResponse(
  response: AnyLestoResponse,
  securityHeaders: Record<string, string> | false,
  requestId: string,
): AnyLestoResponse {
  return withRequestId(withSecurityHeaders(response, securityHeaders), requestId);
}

/**
 * Negotiate an already-hardened response's content encoding and write it to the
 * socket — the shared tail both serving paths run once they hold a response to
 * deliver (the ordinary path after its ETag/304 split, the stream path after its
 * limiter admission). Compresses per the request's `Accept-Encoding` (a buffered
 * body up front with an accurate `Content-Length`; a stream through a zlib transform
 * {@link applyResponse} inserts), then awaits delivery so the caller's access line
 * describes the real outcome — a buffered body resolves at once, a stream only once
 * fully flushed or torn down (a mid-stream truncation routed to `onTruncated`).
 *
 * `beforeFirstByte`, when given, fires AFTER compression (the last step that can
 * throw) and BEFORE the body is flushed: the stream path passes its first-byte
 * access log here, so a throw in compression still lands in the caller's `catch`
 * (which logs) without the line being logged twice, while a held stream is visible
 * in the log the instant it opens. The ordinary path passes no hook — it logs once
 * in its own `finally`.
 */
async function writeNegotiated(
  res: ServerResponse,
  hardened: AnyLestoResponse,
  acceptEncoding: string | undefined,
  compress: boolean,
  onTruncated: (reason: unknown) => void,
  beforeFirstByte?: () => void,
): Promise<void> {
  const encoded = compressResponse(hardened, acceptEncoding, compress);

  beforeFirstByte?.();

  await applyResponse(res, encoded.response, {
    onTruncated,
    ...(encoded.streamEncoding === undefined ? {} : { streamEncoding: encoded.streamEncoding }),
  });
}

/** The socket-level timeouts {@link applyServerLimits} sets — the slice it writes. */
export interface ServerLimits {
  requestTimeout: number;

  headersTimeout: number;

  keepAliveTimeout: number;
}

/**
 * Set node:http's per-socket timeouts on a server.
 *
 * Pulled out as a pure function over the minimal shape so the values we choose
 * are unit-testable without a live socket. `maxHeaderSize` is not here: it is a
 * construction-time option, set on `createServer`.
 */
export function applyServerLimits(
  server: ServerLimits,
  limits: { requestTimeoutMs: number; headersTimeoutMs: number; keepAliveTimeoutMs: number },
): void {
  server.requestTimeout = limits.requestTimeoutMs;
  server.headersTimeout = limits.headersTimeoutMs;
  server.keepAliveTimeout = limits.keepAliveTimeoutMs;
}

/**
 * Cap the connections a server will hold open. node:http refuses (and closes) a
 * new connection once `maxConnections` are live, bounding a connection-volume
 * flood at the socket layer. Pulled out like {@link applyServerLimits} so the
 * wiring is unit-testable without a live socket.
 */
export function applyConnectionLimit(server: { maxConnections: number }, max: number): void {
  server.maxConnections = max;
}

/**
 * Bounds the number of requests in flight at once, shedding a 503 past the cap.
 *
 * Where the body cap and handler timeout protect against ONE bad request, this
 * protects against MANY cheap ones piling up: a request-volume flood is sloughed
 * off as a fast 503 before it can grow the node's per-request state without
 * bound. A counting semaphore — `tryAcquire` admits and counts, `release` frees a
 * slot when the request settles.
 */
export interface ConcurrencyLimiter {
  /** Admit a request and count it, or return `false` (caller sheds 503) at capacity. */
  tryAcquire(): boolean;

  /** Free a slot once a request settles. */
  release(): void;
}

/** A {@link ConcurrencyLimiter} bounded at `max` in-flight requests. */
export function concurrencyLimiter(max: number): ConcurrencyLimiter {
  let inFlight = 0;

  return {
    tryAcquire(): boolean {
      if (inFlight >= max) return false;

      inFlight += 1;

      return true;
    },

    release(): void {
      // Guard against underflow: `release` is only ever called after a successful
      // `tryAcquire` (the handler's `finally`), so this never trips in normal flow.
      if (inFlight > 0) inFlight -= 1;
    },
  };
}

/**
 * Bounds long-lived streams (ADR 0040) two ways at once — a GLOBAL ceiling and a
 * PER-KEY (client-IP) ceiling — and exposes a live gauge.
 *
 * A held stream is exempt from the in-flight gate ({@link ConcurrencyLimiter}): it
 * would otherwise occupy an in-flight slot for its whole life and self-DoS the
 * node at the in-flight cap (~1k idle users). That exemption removes the only
 * global backstop, so streams get their OWN dedicated semaphore here. The per-key
 * ceiling is the anonymous-flood backstop — keyed on the resolved client IP, it
 * stops one source from draining the whole global pool (a single shared cap would
 * either let one IP hold every slot, or — keyed on the lone anonymous principal —
 * throttle every anonymous user at once). The per-PRINCIPAL cap, which needs the
 * resolved principal, lives in the app-wired SSE handler, not here.
 *
 * {@link active} is the gauge the access log stamps at first byte, so a held
 * stream is visible in the log the moment it opens rather than only at teardown.
 */
export interface StreamLimiter {
  /** Admit a stream for `key` (the client IP), or return `false` at the global or per-key ceiling. */
  tryAcquire(key: string): boolean;

  /** Free a stream's slot for `key` once it tears down. */
  release(key: string): void;

  /** The number of streams currently held open — the active-stream gauge. */
  active(): number;
}

/**
 * The per-client-IP bucket key for the stream limiter: the resolved client IP, or
 * a single sentinel `"-"` bucket when no IP resolved (no socket peer). Pure and
 * exported so the resolved/unresolved branches are unit-testable without a socket.
 * An unresolved-IP stream is rare (a real TCP peer always has an address), but it
 * must share ONE anonymous bucket rather than key on `undefined`.
 */
export function streamBucketKey(ip: string | undefined): string {
  return ip ?? "-";
}

/** A {@link StreamLimiter} bounded at `maxGlobal` total and `maxPerKey` per client IP. */
export function streamLimiter(maxGlobal: number, maxPerKey: number): StreamLimiter {
  let global = 0;

  // Per-key counts, pruned to zero on release so a churn of one-shot IPs can't
  // grow the map without bound.
  const perKey = new Map<string, number>();

  return {
    tryAcquire(key: string): boolean {
      if (global >= maxGlobal) return false;

      const held = perKey.get(key) ?? 0;

      if (held >= maxPerKey) return false;

      global += 1;
      perKey.set(key, held + 1);

      return true;
    },

    release(key: string): void {
      // Guard underflow: `release` only follows a successful `tryAcquire` (the
      // stream's `finally`), so neither branch trips in normal flow.
      if (global > 0) global -= 1;

      const held = perKey.get(key);

      if (held === undefined) return;

      // Drop the entry at zero so the map stays bounded by LIVE distinct IPs.
      if (held <= 1) {
        perKey.delete(key);

        return;
      }

      perKey.set(key, held - 1);
    },

    active(): number {
      return global;
    },
  };
}

/** The slice of a node server {@link drainServer} drives — fakeable in a test. */
export interface ClosableServer {
  close(callback: () => void): void;

  closeIdleConnections(): void;

  closeAllConnections(): void;
}

/** The timer seam {@link drainServer} uses — injected so a test drives the clock. */
export interface DrainTimers {
  set(callback: () => void, ms: number): unknown;

  clear(handle: unknown): void;
}

const realDrainTimers: DrainTimers = {
  set: (callback, ms) => {
    const timer = setTimeout(callback, ms);

    timer.unref();

    return timer;
  },

  clear: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

/**
 * Drain a server gracefully: stop accepting, let in-flight requests finish,
 * then force what is left.
 *
 * `close` stops accepting new connections and resolves once the live ones end;
 * `closeIdleConnections` frees keep-alive sockets that are sitting idle so they
 * do not hold the drain open; and if the grace window expires first,
 * `closeAllConnections` forces the stragglers so a deploy restart cannot hang
 * forever. Resolves exactly once, whichever path settles it.
 */
export function drainServer(
  server: ClosableServer,
  graceMs: number,
  timers: DrainTimers = realDrainTimers,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;

    const graceTimer = timers.set(() => server.closeAllConnections(), graceMs);

    const finish = (): void => {
      if (settled) return;

      settled = true;
      timers.clear(graceTimer);
      resolve();
    };

    server.close(() => finish());

    server.closeIdleConnections();
  });
}

/**
 * Boot a node:http server that serves a Lesto {@link App}.
 *
 * Each request is read in full, normalized into a transport-free `LestoRequest`,
 * dispatched through `app.handle`, and its response written back. The server is
 * stateless: all durable state lives in the app's database, so multiple
 * instances scale horizontally and deploys are rolling restarts.
 *
 * Resolves once the socket is listening, carrying the bound port — so a caller
 * that passed `port: 0` (the default) learns which ephemeral port it got. The
 * returned `close()` drains gracefully (see {@link drainServer}).
 */
export function serve(app: App, options: ServeOptions = {}): Promise<Server> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  const drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
  const logError = options.logError ?? defaultLogError;

  // The long-lived-stream endpoint, on by default; `false` disables it (the
  // reserved path then falls through the ordinary gate). Its dedicated limiter is
  // minted once here, shared across every connection like the in-flight gate.
  const liveStreamOptions = options.liveStream === false ? undefined : (options.liveStream ?? {});

  const deps: HandleDeps = {
    maxBodyBytes: options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    maxJsonBodyBytes: options.maxJsonBodyBytes ?? DEFAULT_MAX_JSON_BODY_BYTES,
    handlerTimeoutMs: options.handlerTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS,
    health: options.health === false ? undefined : (options.health ?? {}),
    securityHeaders: securityDefaults(options.securityHeaders ?? DEFAULT_SECURITY_HEADERS, {
      csp: options.csp,
      crossOriginEmbedderPolicy: options.crossOriginEmbedderPolicy,
    }),
    etag: options.etag ?? {},
    compress: options.compress !== false,
    trustProxy: options.trustProxy ?? false,
    newRequestId: options.newRequestId ?? randomUUID,
    logRequest: options.logRequest ?? defaultLogRequest,
    logError,
    now: options.now ?? Date.now,
    concurrency: concurrencyLimiter(options.maxInFlightRequests ?? DEFAULT_MAX_IN_FLIGHT_REQUESTS),
    ...(liveStreamOptions === undefined
      ? {}
      : {
          liveStream: {
            // Both reserved held-stream paths — the ADR 0040 topic fan-out and the
            // ADR 0042 local-first data stream — are recognized by default and share
            // one stream semaphore + per-IP ceiling.
            paths: [
              liveStreamOptions.path ?? DEFAULT_LIVE_STREAM_PATH,
              liveStreamOptions.dataPath ?? DEFAULT_LIVE_DATA_PATH,
            ],
            limiter: streamLimiter(
              liveStreamOptions.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_STREAMS,
              liveStreamOptions.maxPerIp ?? DEFAULT_MAX_STREAMS_PER_IP,
            ),
          },
        }),
    ...(options.tracer === undefined ? {} : { tracer: options.tracer }),
    ...(options.parseTraceparent === undefined
      ? {}
      : { parseTraceparent: options.parseTraceparent }),
  };

  installProcessSafetyNet(logError);

  const server = createServer(
    { maxHeaderSize: options.maxHeaderBytes ?? DEFAULT_MAX_HEADER_BYTES },
    (req: IncomingMessage, res: ServerResponse) => {
      // `handle` swallows every throw internally and always answers the socket,
      // so this `void` can never leak a rejected promise into the process.
      void handle(app, req, res, deps);
    },
  );

  applyServerLimits(server, {
    requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    headersTimeoutMs: options.headersTimeoutMs ?? DEFAULT_HEADERS_TIMEOUT_MS,
    keepAliveTimeoutMs: options.keepAliveTimeoutMs ?? DEFAULT_KEEP_ALIVE_TIMEOUT_MS,
  });

  applyConnectionLimit(server, options.maxConnections ?? DEFAULT_MAX_CONNECTIONS);

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      // listen() resolved, so address() is a bound AddressInfo, not null.
      const address = server.address() as AddressInfo;

      resolve({
        port: address.port,

        // Drain in-flight requests, THEN run the drain hook (the tracer's final
        // flush) — so the last buffered spans reach the collector before the
        // process exits. The hook's rejection is contained: a failed flush must
        // never wedge a shutdown.
        close: () => closeWithDrain(server, drainTimeoutMs, options.onDrain, logError),
      });
    });
  });
}

/**
 * Drain the server, then run an optional drain hook (the tracer's final flush).
 *
 * The order is the contract: let in-flight requests finish FIRST (they may emit
 * their last spans), then flush. A rejecting hook is logged and swallowed — a
 * telemetry flush that fails on shutdown must not block the deploy's restart.
 * Pure over its injected pieces so both the with-hook and without-hook paths are
 * testable without a real socket.
 */
export async function closeWithDrain(
  server: ClosableServer,
  drainTimeoutMs: number,
  onDrain: (() => Promise<void>) | undefined,
  logError: (message: string, error: unknown) => void,
): Promise<void> {
  await drainServer(server, drainTimeoutMs);

  if (onDrain === undefined) return;

  try {
    await onDrain();
  } catch (error) {
    logError("drain hook failed (kept shutting down)", error);
  }
}

interface HandleDeps {
  readonly maxBodyBytes: number;

  /** Tighter cap for `application/json` bodies; the JSON limit is the min of the two. */
  readonly maxJsonBodyBytes: number;

  readonly handlerTimeoutMs: number;

  /** Health endpoints, or `undefined` when disabled. */
  readonly health: HealthOptions | undefined;

  readonly securityHeaders: Record<string, string> | false;

  /** Conditional-GET ETag behaviour for HTML responses; `false` disables it. */
  readonly etag: EtagConfig;

  /** Whether to negotiate response compression from `Accept-Encoding`; `false` disables it. */
  readonly compress: boolean;

  /** Whom to believe about the client IP/protocol; `false` trusts nothing. */
  readonly trustProxy: TrustProxy;

  /** Mints the per-request id for the request context. */
  readonly newRequestId: () => string;

  readonly logRequest: (entry: AccessEntry) => void;

  readonly logError: (message: string, error: unknown) => void;

  readonly now: () => number;

  /** Bounds requests in flight at once; sheds a 503 past the cap. */
  readonly concurrency: ConcurrencyLimiter;

  /**
   * The long-lived-stream endpoint (its reserved path + dedicated limiter), or
   * absent when disabled. A `GET` on `path` bypasses the in-flight gate and is
   * admitted under `limiter` instead (ADR 0040).
   */
  readonly liveStream?: { readonly paths: readonly string[]; readonly limiter: StreamLimiter };

  /** Mints one span per request, or absent for the zero-overhead default. */
  readonly tracer?: RequestTracer;

  /** Parses an inbound `traceparent` for the cross-process join; absent → fresh trace. */
  readonly parseTraceparent?: TraceparentParser;
}

/**
 * The slice of a request we need to establish the context: the socket peer and
 * the raw forwarding headers (as node delivers them — a header sent twice can
 * arrive as a list). Narrow on purpose, so a fake satisfies it without a socket.
 */
export interface ContextSource {
  readonly socket?: { readonly remoteAddress?: string | undefined } | undefined;

  readonly headers: Record<string, string | string[] | undefined>;
}

/** The first value of a possibly-repeated header, as a single string or absent. */
function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The shape of a request id we are willing to ADOPT from an inbound header.
 *
 * An upstream that mints request ids (a load balancer, an API gateway) sends
 * them on `X-Request-Id` so one id spans the whole hop chain. We adopt such an
 * id only when {@link establishContext}'s trust policy already believes the peer
 * (the SAME gate that guards the forwarding headers — a client we do not trust
 * can forge this header just as easily as `X-Forwarded-For`), AND only when it
 * is well-formed: a bounded, conservative token charset. An id that fails either
 * test is dropped and we mint our own, so a hostile value can never poison a log
 * line or a downstream system that keys on the id.
 */
const REQUEST_ID_SHAPE = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * The request id to use: an adopted inbound id, or `undefined` to mint a fresh
 * one.
 *
 * `trusted` is whether the trust-proxy policy believes the immediate peer (so an
 * inbound id is the upstream's, not a forgery). Only a trusted, well-formed
 * (see {@link REQUEST_ID_SHAPE}) `X-Request-Id` is adopted; everything else
 * yields `undefined` and the caller mints its own. Pure and exported so the
 * adopt / reject-malformed / reject-untrusted branches are unit-testable.
 */
export function adoptRequestId(inbound: string | undefined, trusted: boolean): string | undefined {
  if (!trusted) return undefined;

  if (inbound === undefined) return undefined;

  return REQUEST_ID_SHAPE.test(inbound) ? inbound : undefined;
}

/**
 * Build the per-request context: the request id, plus the trust-proxy-resolved
 * client IP and protocol.
 *
 * The id is the one to TAG this request with (logs, the `X-Request-Id` echo,
 * tracing): a well-formed inbound `X-Request-Id` is adopted when the trust policy
 * believes the peer — the same gate that guards the forwarding headers, since a
 * client we do not trust can forge either — otherwise the minted `fallbackId`
 * stands. The IP/protocol come from {@link resolveClient}, which believes the
 * forwarding headers only when the policy trusts the socket peer (see the
 * spoofing hazard there). The trust decision is computed once and reused for both
 * the id adoption and the header resolution, so they can never disagree. We
 * collapse a repeated forwarding header to its first value before handing it
 * over. Pure over its inputs and exported so id adoption and trust resolution are
 * testable without a socket.
 *
 * `exactOptionalPropertyTypes` is on, so we attach `ip` only when one resolved —
 * an absent IP is the key absent, not present-and-`undefined`.
 */
export function establishContext(
  source: ContextSource,
  trustProxy: TrustProxy,
  fallbackId: string,
): RequestContext {
  const peerAddress = source.socket?.remoteAddress;

  // One trust decision, reused below for BOTH the forwarding headers and the
  // inbound request id — a client we do not trust can forge either alike.
  const trusted = peerIsTrusted(trustProxy, peerAddress);

  const requestId =
    adoptRequestId(firstHeader(source.headers["x-request-id"]), trusted) ?? fallbackId;

  const xff = firstHeader(source.headers["x-forwarded-for"]);
  const xfp = firstHeader(source.headers["x-forwarded-proto"]);

  // `exactOptionalPropertyTypes`: carry each forwarding header only when present,
  // never as present-and-`undefined`, so `resolveClient` sees a clean shape.
  const forwarded: ForwardHeaders = {
    ...(xff !== undefined && { "x-forwarded-for": xff }),
    ...(xfp !== undefined && { "x-forwarded-proto": xfp }),
  };

  const client = resolveClient(trustProxy, peerAddress, forwarded);

  return {
    requestId,
    protocol: client.protocol,
    ...(client.ip !== undefined && { ip: client.ip }),
  };
}

/**
 * The slice of a `ServerResponse` {@link requestAbortSignal} watches — narrow on
 * purpose, so a fake `EventEmitter`-shaped object drives both branches without a
 * live socket.
 */
export interface AbortableResponse {
  on(event: "close", listener: () => void): unknown;

  /** node sets this `true` once the response has been fully written. */
  readonly writableFinished: boolean;
}

/**
 * A per-request cancellation: the `AbortSignal` the handler reads, plus the
 * `abortTimeout` the transport calls when the handler overruns its deadline.
 *
 * The signal fires on EITHER of two events, whichever comes first:
 *
 *   - the client hangs up before the response finished — `close` fires while
 *     `writableFinished` is still `false` (a clean completion sets it `true`, so
 *     the disconnect branch is the discriminator), aborting with a coded
 *     `RUNTIME_CLIENT_DISCONNECTED`;
 *   - the handler exceeds `handlerTimeoutMs` — the transport calls
 *     `abortTimeout()`, aborting with a coded `RUNTIME_HANDLER_TIMEOUT`.
 *
 * Both abort the SAME controller, so a streaming render or an upstream fetch that
 * reads `context.signal` stops on whichever happens — it no longer keeps working
 * for a response no one will read, and a wedged handler is actively cancelled
 * rather than left to accumulate as a zombie holding live resources. `abortTimeout`
 * is idempotent (an already-aborted controller ignores a second abort), so the
 * disconnect-then-timeout race is harmless.
 */
export function requestCancellation(res: AbortableResponse): {
  signal: AbortSignal;
  abortTimeout: () => void;
} {
  const aborter = new AbortController();

  res.on("close", () => {
    if (!res.writableFinished) {
      aborter.abort(
        new RuntimeError(
          "RUNTIME_CLIENT_DISCONNECTED",
          "Client disconnected before the response finished.",
        ),
      );
    }
  });

  const abortTimeout = (): void => {
    aborter.abort(
      new RuntimeError("RUNTIME_HANDLER_TIMEOUT", "Request handler exceeded its time limit."),
    );
  };

  return { signal: aborter.signal, abortTimeout };
}

/**
 * A per-request `AbortSignal` that fires if the client hangs up before the
 * response finished — the disconnect-only half of {@link requestCancellation},
 * kept as a focused export for callers that want only that signal.
 */
export function requestAbortSignal(res: AbortableResponse): AbortSignal {
  return requestCancellation(res).signal;
}

/**
 * Drive one request through the app and write its response — and never throw.
 *
 * This is the per-request error boundary, the primary defense against an
 * unauthenticated client crashing the server. ANY failure — a malformed body,
 * a controller that throws, a rejected promise, a handler that overruns its
 * deadline — is caught here, mapped to a status, and answered with a safe
 * generic body; a liveness/readiness probe is answered before the app is even
 * reached. Every request is access-logged once, success or failure. An attacker
 * can degrade their own request to a 4xx/5xx; they can never take the process
 * down or hold a socket open past the handler deadline.
 */
async function handle(
  app: App,
  req: IncomingMessage,
  res: ServerResponse,
  deps: HandleDeps,
): Promise<void> {
  const line = requestLineOf(req);

  // A malformed request target (`GET //`, `GET /\`) cannot be parsed into a path —
  // `new URL(...)` throws. Answer 400 here, at the very top: this runs in handle's
  // pre-gate preamble, OUTSIDE the request boundary's try/catch, so an unhandled
  // throw would escape into `void handle(...)` and leave the socket unanswered
  // until the request timeout (a cheap unauthenticated socket-hold). A clean 400 is
  // logged like any other request. Past this point `pathOf`/`toLestoRequest` share
  // the same parse, so the URL is known-good.
  let path: string;

  try {
    path = pathOf(line.url);
  } catch {
    const requestId = deps.newRequestId();

    respondWithError(res, 400, deps.securityHeaders, requestId);
    deps.logRequest({ method: line.method, path: line.url, status: 400, ms: 0, requestId });

    return;
  }

  // Liveness/readiness probes BYPASS the concurrency gate: an orchestrator polling
  // `/readyz` must get the node's true readiness even while it sheds load — a 503
  // here would pull a merely-busy node out of rotation and amplify a spike into an
  // outage. The probe is the cheapest path anyway (no app dispatch), so admitting
  // it unconditionally is safe. The bypass is intentionally UN-accounted (a probe
  // takes no slot); a probe is still bounded per-call by `readyTimeoutMs`, and a
  // probe flood is the edge/LB's job to shed, not this backstop's. (`line`/`path`
  // are computed once here and threaded in, so the admitted path does not re-parse.)
  if (deps.health !== undefined && isHealthProbe(line.method, path, deps.health)) {
    return handleAdmitted(app, req, res, deps, line, path);
  }

  // A long-lived stream (SSE) is recognized as a ROUTE PREDICATE here, BEFORE the
  // in-flight gate — exactly like the health-probe bypass above. It must not take
  // an in-flight slot: a held connection would occupy one for its whole life and
  // self-DoS the node at the in-flight cap (ADR 0040). `handleStream` admits it
  // instead under its own dedicated stream semaphore. Recognizing it as a
  // predicate (not a response flag) keeps the in-flight `finally` release
  // unconditional below — a flag flipped mid-response would double-free the slot.
  if (deps.liveStream !== undefined && isLongLivedStream(line.method, path, deps.liveStream.paths)) {
    return handleStream(app, req, res, deps, line, path, deps.liveStream);
  }

  // Shed before any work when too many requests are already in flight: a
  // request-volume flood is answered with the cheapest possible 503 — no context,
  // no body read — so it cannot push the node past its in-flight budget. The shed
  // is still recorded on the access log (one structured line per request, like
  // every other), so the backstop firing is VISIBLE — it shows as status 503 with
  // ms 0, distinct from a handler that ran and timed out. A successful acquire is
  // freed in the `finally` below, so every admitted request returns its slot.
  if (!deps.concurrency.tryAcquire()) {
    const requestId = deps.newRequestId();

    respondWithError(res, 503, deps.securityHeaders, requestId);
    deps.logRequest({ method: line.method, path, status: 503, ms: 0, requestId });

    return;
  }

  try {
    return await handleAdmitted(app, req, res, deps, line, path);
  } finally {
    deps.concurrency.release();
  }
}

/**
 * True iff this is a liveness/readiness probe — exactly the GET/HEAD requests
 * {@link healthResponse} answers. Probes bypass the concurrency gate so an
 * orchestrator's `/readyz` poll reflects the node's real readiness under load
 * instead of a load-shed 503; a non-probe at the same path (a POST, or a real
 * route) is gated as normal.
 */
export function isHealthProbe(method: string, path: string, health: HealthOptions): boolean {
  if (method !== "GET" && method !== "HEAD") return false;

  return (
    path === (health.livePath ?? DEFAULT_LIVE_PATH) ||
    path === (health.readyPath ?? DEFAULT_READY_PATH)
  );
}

/**
 * True iff this is a long-lived streaming request — a `GET` on one of the reserved
 * live paths (ADR 0040's topic SSE fan-out and ADR 0042's local-first data stream).
 * Decided as a route predicate BEFORE admission, like {@link isHealthProbe}, so a held
 * stream never takes an in-flight slot. `EventSource` always issues a `GET`, so a
 * non-GET at a reserved path (or any other path) falls through to the ordinary gated
 * path. Exported so the predicate is unit-testable without a socket.
 */
export function isLongLivedStream(
  method: string,
  path: string,
  livePaths: readonly string[],
): boolean {
  return method === "GET" && livePaths.includes(path);
}

/** The request path proper, run only after a concurrency slot is acquired (or a probe). */
async function handleAdmitted(
  app: App,
  req: IncomingMessage,
  res: ServerResponse,
  deps: HandleDeps,
  line: { method: string; url: string },
  path: string,
): Promise<void> {
  // Establish the per-request context up front and run the whole request inside
  // it. `runWithContext` uses `AsyncLocalStorage.run`, so everything the handler
  // does — through every `await` — sees this exact context, and nothing leaks
  // into the next request: the context is torn down when this call settles. The
  // id and resolved client identity are decided here, before the app runs, so a
  // middleware (rate-limit) and the access log both read the same values. The id
  // is a fresh mint UNLESS a trusted upstream sent a well-formed `X-Request-Id`,
  // which `establishContext` adopts behind the trust-proxy gate.
  const context = establishContext(req, deps.trustProxy, deps.newRequestId());

  const requestId = context.requestId;

  // Publish a per-request abort signal on the context: it fires if the client
  // hangs up OR the handler overruns its deadline, so a streaming render or a
  // long handler stops rather than work for a response no one will read.
  // `abortTimeout` is the deadline half, called by `withTimeout` on overrun.
  const cancellation = requestCancellation(res);

  context.signal = cancellation.signal;

  return runWithContext(context, async () => {
    const start = deps.now();

    // A W3C `traceparent` on the inbound request joins this hop to the caller's
    // trace: the root span continues the SAME trace id, parented on the caller's
    // span, so one request crossing services is one trace — not a fresh trace per
    // hop. Parsed only when a tracer is wired (no tracer, no parse), and the
    // parser is injected so the runtime takes no dependency on the tracing
    // package. A malformed/absent header parses to `undefined` and roots a fresh
    // trace, the safe default.
    const inbound =
      deps.tracer === undefined
        ? undefined
        : deps.parseTraceparent?.(firstHeader(req.headers["traceparent"]));

    // The request's span opens with the work and closes beside the access line,
    // so trace timing and the logged latency describe the same window.
    const span = deps.tracer?.startSpan("http.request", inbound);

    // Publish the span on the request context so a seam fired DURING the request
    // (a `@lesto/db` query, an inline `@lesto/queue` job) parents its child span on
    // it — a query shows up under the request that ran it. Absent when no tracer
    // is wired (the zero-overhead default).
    if (span !== undefined) context.span = span;

    // `line`/`path` were computed once in `handle` (before the gate) and threaded
    // in, so a 413 (body over the limit) is still attributed to the right
    // method+path rather than the `GET /` default — an oversized POST to /upload
    // logs as exactly that.
    const method = line.method;
    let status = 500;

    // Set true when a streamed body tears down mid-flight; rides the access entry
    // and the span so an operator sees the client got an incomplete response.
    let truncated = false;

    const onTruncated = (reason: unknown): void => {
      truncated = true;

      // A truncation is the server failing to deliver what it promised; surface
      // it like an unhandled error so it is not silently swallowed.
      deps.logError("response body truncated mid-stream", reason);
    };

    try {
      // A JSON body is held to the tighter of the two caps, so its `JSON.parse`
      // blast radius stays bounded even when the general body cap is raised for
      // uploads. Other content types use the general cap unchanged.
      const contentType = firstHeader(req.headers["content-type"]);

      const bodyCap =
        contentType !== undefined && contentType.startsWith("application/json")
          ? Math.min(deps.maxBodyBytes, deps.maxJsonBodyBytes)
          : deps.maxBodyBytes;

      const body = await readBody(req, bodyCap);

      const request = toLestoRequest({
        method: line.method,
        url: line.url,
        headers: req.headers,
        body,
      });

      // `path` was already set from the same URL before the body read (so a 413
      // is attributed correctly); `request.path` is the identical pathname.

      const probe =
        deps.health === undefined
          ? undefined
          : await healthResponse(
              request.method,
              request.path,
              deps.health,
              deps.health.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
            );

      const response =
        probe ??
        (await withTimeout(
          app.handle(request.method, request.path, {
            query: request.query,
            headers: request.headers,
            body: request.body,
          }),
          deps.handlerTimeoutMs,
          cancellation.abortTimeout,
        ));

      // Attach an ETag to a cacheable HTML response, then harden it, then echo the
      // request id. Security headers go on before the 304 split so they cover both
      // paths; the `X-Request-Id` echo rides every response so a client and the
      // server logs share one correlation id (an adopted upstream id is echoed
      // back verbatim, closing the trace loop).
      const tagged = withEtag(response, deps.etag);

      const hardened = hardenResponse(tagged.response, deps.securityHeaders, requestId);

      // A conditional GET whose validator still matches gets a bodiless 304: the
      // client already holds these bytes. We echo the same headers (ETag and all)
      // and send nothing on the wire.
      if (tagged.etag !== undefined && etagMatches(ifNoneMatch(req.headers), tagged.etag)) {
        status = 304;

        respondNotModified(res as NotModifiedResponse, hardened.headers);
      } else {
        status = hardened.status;

        // Negotiate compression and write the body (the shared `writeNegotiated`
        // tail). It runs AFTER the 304 split, so a not-modified response stays
        // bodiless and never carries a body encoding. The ETag above was computed
        // over the uncompressed body, and `Vary: Accept-Encoding` keeps a shared
        // cache from cross-serving codings. Awaiting delivery makes the access
        // entry and span below describe the real outcome (truncation included).
        await writeNegotiated(
          res,
          hardened,
          firstHeader(req.headers["accept-encoding"]),
          deps.compress,
          onTruncated,
        );
      }
    } catch (error) {
      status = statusForError(error);

      // A 500 is ours to explain in the log; client errors (4xx) are not.
      if (status === 500) {
        deps.logError("unhandled error serving request", error);
      }

      respondWithError(res, status, deps.securityHeaders, requestId);
    } finally {
      // The request id rides on the access line too, so a log and any
      // context-tagged work the handler emitted share one correlation id. A
      // truncated body is flagged only when it happened — the common clean case
      // leaves the field absent.
      deps.logRequest({
        method,
        path,
        status,
        ms: deps.now() - start,
        requestId,
        ...(truncated ? { truncated: true } : {}),
      });

      if (span !== undefined) {
        span.setAttribute("http.method", method);
        span.setAttribute("http.path", path);
        span.setAttribute("http.status_code", status);
        span.setAttribute("lesto.request_id", requestId);

        // The tracer reads this to mark a delivered-but-incomplete response; set
        // only when it happened, so a clean response carries no attribute.
        if (truncated) span.setAttribute("lesto.response.truncated", true);

        // A 5xx is the server's failure; everything else (4xx included) is a
        // request the server answered as designed.
        span.setStatus(status >= 500 ? "error" : "ok");
        span.end();
      }
    }
  });
}

/**
 * Drive a long-lived streaming request (an SSE connection on the reserved live
 * path) and never throw — the streaming counterpart of {@link handleAdmitted},
 * built for the ways ADR 0040 says a held stream differs from a normal request:
 *
 *   - **No in-flight slot.** Admission is the dedicated {@link StreamLimiter}
 *     (global + per-client-IP), NOT `deps.concurrency`. A stream that held an
 *     in-flight slot for hours would self-DoS the node at the in-flight cap. Over
 *     either ceiling is the cheapest possible coded 503 — no context run, no
 *     dispatch — logged like the in-flight shed so the backstop firing is visible.
 *   - **No handler timeout.** `app.handle` is dispatched WITHOUT {@link withTimeout}:
 *     a live stream must outlive `handlerTimeoutMs`. The handler's contract is to
 *     return its `ReadableStream` promptly and use `context.signal` purely for
 *     teardown, which fires only on client disconnect (`RUNTIME_CLIENT_DISCONNECTED`),
 *     never a timeout — there is no `abortTimeout` wired on this path.
 *   - **Logged at first byte.** The access line is emitted the instant the response
 *     is produced — carrying the live {@link StreamLimiter.active} gauge — not at
 *     teardown hours later, so a held stream is visible in the log for its whole
 *     life. (A mid-stream truncation, which happens after first byte, is still
 *     surfaced through `logError`; it can no longer ride the already-emitted line.)
 *   - **No span.** A held stream does not fit the per-request span model (it would
 *     hold one `http.request` span open for hours); its observability is the
 *     first-byte access line + the active-stream gauge.
 *
 * `text/event-stream` is never compressed (excluded in `isCompressibleType`), so
 * the negotiated {@link compressResponse} leaves an SSE body untouched.
 */
async function handleStream(
  app: App,
  req: IncomingMessage,
  res: ServerResponse,
  deps: HandleDeps,
  line: { method: string; url: string },
  path: string,
  liveStream: { limiter: StreamLimiter },
): Promise<void> {
  const context = establishContext(req, deps.trustProxy, deps.newRequestId());

  const requestId = context.requestId;

  // The per-IP bucket key is the resolved client IP — the anonymous-flood
  // backstop. An unresolved IP (no socket peer) shares one sentinel bucket.
  const ipKey = streamBucketKey(context.ip);

  // Admit under the dedicated stream semaphore, NOT the in-flight gate. Over the
  // global ceiling OR this IP's ceiling is a cheap coded 503, recorded on the
  // access log (ms 0, no slot taken) so the backstop is visible.
  if (!liveStream.limiter.tryAcquire(ipKey)) {
    respondWithError(res, 503, deps.securityHeaders, requestId);
    deps.logRequest({ method: line.method, path, status: 503, ms: 0, requestId });

    return;
  }

  // Publish a per-request abort signal: a held stream reads `context.signal` to
  // tear down when the client hangs up (`RUNTIME_CLIENT_DISCONNECTED`). The
  // deadline half is deliberately never wired here — the stream is timeout-exempt.
  const cancellation = requestCancellation(res);

  context.signal = cancellation.signal;

  return runWithContext(context, async () => {
    const start = deps.now();

    const method = line.method;
    let status = 500;

    // One access line per request, carrying the live active-stream gauge. It is
    // emitted at FIRST BYTE on the success path (so a held stream is visible the
    // instant it opens, not at teardown hours later) and at the failure on the
    // error path. The two never both fire: everything that can throw runs BEFORE
    // the first-byte log, and `applyResponse` for a stream never rejects — so a
    // `catch` means we had not yet logged.
    const logStream = (): void => {
      deps.logRequest({
        method,
        path,
        status,
        ms: deps.now() - start,
        requestId,
        activeStreams: liveStream.limiter.active(),
      });
    };

    const onTruncated = (reason: unknown): void => {
      // The access line already went out at first byte, so a truncation cannot
      // ride it — surface it like an unhandled error so it is not swallowed.
      deps.logError("response body truncated mid-stream", reason);
    };

    try {
      // This connection is admitted and will be HELD: drain any request body so it
      // cannot sit unread in the socket buffer for the stream's whole life (see
      // {@link drainBody}). Fire-and-forget — never awaited, so a slow/dribbled body
      // cannot delay the stream opening. Kept INSIDE the try so that on the off-chance
      // `resume()` throws, the `catch` answers and the `finally` still releases the
      // dedicated stream slot — a leak otherwise, since the slot was acquired above.
      // (A refused 503 never reaches here; it closes its own socket, like the in-flight
      // shed, so there is nothing unread to hold.)
      drainBody(req);

      // A GET stream carries no body to read; dispatch straight through with an
      // empty body.
      const request = toLestoRequest({
        method: line.method,
        url: line.url,
        headers: req.headers,
        body: "",
      });

      // `withTimeout` bounds ONLY response PRODUCTION — the time the handler may
      // take to RETURN its `ReadableStream` — not the stream's lifetime. It
      // resolves (and clears the timer) the instant `app.handle` returns the
      // response object, so a well-behaved stream that then lives for hours is
      // never guillotined (the long-lived exemption). But a handler that hangs
      // BEFORE returning its stream would otherwise hold a dedicated stream slot
      // forever — a slot leak that, repeated, DoSes the endpoint — so the
      // production phase keeps the deadline as defense-in-depth (ADR 0040): on
      // overrun `abortTimeout` fires `context.signal` with `RUNTIME_HANDLER_TIMEOUT`
      // and the dispatch is freed with a 503, the slot released in `finally`.
      const response = await withTimeout(
        app.handle(request.method, request.path, {
          query: request.query,
          headers: request.headers,
          body: request.body,
        }),
        deps.handlerTimeoutMs,
        cancellation.abortTimeout,
      );

      const hardened = hardenResponse(response, deps.securityHeaders, requestId);

      status = hardened.status;

      // Negotiate encoding + write through the shared `writeNegotiated` tail. SSE
      // (`text/event-stream`) is excluded from compression so it no-ops here; a
      // non-SSE body at this path is negotiated as usual. `logStream` is passed as
      // the `beforeFirstByte` hook: it fires AFTER compression (the last step that
      // can throw) and BEFORE the body is flushed — so a held stream is logged the
      // instant it opens with the live active-stream gauge, yet a compression throw
      // still lands in `catch` (logging exactly once, never twice). Awaiting
      // resolves only once the stream is fully flushed or torn down, so the
      // `finally` frees the dedicated slot exactly when the connection ends.
      await writeNegotiated(
        res,
        hardened,
        firstHeader(req.headers["accept-encoding"]),
        deps.compress,
        onTruncated,
        logStream,
      );
    } catch (error) {
      status = statusForError(error);

      // A 500 is ours to explain in the log; client errors (4xx) are not.
      if (status === 500) {
        deps.logError("unhandled error serving request", error);
      }

      respondWithError(res, status, deps.securityHeaders, requestId);

      logStream();
    } finally {
      // Free the dedicated stream slot the instant the connection ends, so the
      // gauge and both ceilings reflect reality the moment a stream closes.
      liveStream.limiter.release(ipKey);
    }
  });
}

/**
 * Merge an `X-Request-Id` echo onto a response, without disturbing a header the
 * app set itself.
 *
 * The runtime owns the request-id correlation, so every response carries the id
 * it logged and traced — but an app that set its own `X-Request-Id` (an
 * unusual but legitimate override) wins, matched case-insensitively so any
 * casing is respected. Returns a fresh response object; the input is never
 * mutated (the per-request-object invariant the response factories protect).
 */
export function withRequestId(response: AnyLestoResponse, requestId: string): AnyLestoResponse {
  const hasOwn = Object.keys(response.headers).some(
    (name) => name.toLowerCase() === "x-request-id",
  );

  if (hasOwn) return response;

  return { ...response, headers: { ...response.headers, "X-Request-Id": requestId } };
}

/** The slice of a response the error path needs — narrow, so a test can fake it. */
export interface ErrorResponse {
  readonly headersSent: boolean;

  writeHead(status: number, headers: Record<string, string | string[]>): void;

  end(body?: string): void;
}

/**
 * Answer a failed request with a safe, generic body.
 *
 * Best-effort: if the headers already went out (a handler that wrote then
 * threw) we cannot send a fresh status, so we just end the socket — the
 * invariant we protect is that the socket never hangs open, not that every
 * failure becomes a clean status line. Default response headers are merged in
 * so an error response is hardened like any other, and the `X-Request-Id` is
 * echoed (when one is given) so even a 500 carries the id the logs and trace
 * recorded — an operator pivots from the client's failed response straight to
 * the server-side record.
 *
 * The body is always a known string (see {@link bodyForStatus}), so we write it
 * directly via `writeHead` + `end` rather than through {@link applyResponse}:
 * that keeps {@link ErrorResponse} narrow — it needs no stream-piping surface,
 * because an error is never a stream — and leaves its fakes unchanged.
 */
export function respondWithError(
  res: ErrorResponse,
  status: number,
  securityHeaders: Record<string, string> | false = false,
  requestId?: string,
): void {
  if (!res.headersSent) {
    const body = bodyForStatus(status);

    const hardened = withSecurityHeaders(
      { status, headers: { "content-type": "text/plain; charset=utf-8" }, body },
      securityHeaders,
    );

    const headers =
      requestId === undefined
        ? hardened.headers
        : { ...hardened.headers, "X-Request-Id": requestId };

    res.writeHead(hardened.status, headers);

    // The local `body` is the string we just built; no cast, no narrowing.
    res.end(body);

    return;
  }

  res.end();
}

/** The default error sink: structured-enough for a server log. */
function defaultLogError(message: string, error: unknown): void {
  console.error(message, error);
}

/**
 * The default access log: one structured JSON line per request.
 *
 * Structured (a single JSON object) so a log pipeline parses it rather than
 * scraping a string — `status`/`request_id`/`truncated` are queryable fields,
 * the posture the worker error sink takes too. `truncated` is emitted only when
 * the body was torn down mid-stream, so a clean line stays compact. A custom
 * `logRequest` sink overrides this wholesale; the {@link AccessEntry} it receives
 * is unchanged.
 */
export function defaultLogRequest(entry: AccessEntry): void {
  console.log(
    JSON.stringify({
      level: "info",
      event: "http.access",
      method: entry.method,
      path: entry.path,
      status: entry.status,
      ms: entry.ms,
      request_id: entry.requestId,
      ...(entry.truncated === true ? { truncated: true } : {}),
      ...(entry.activeStreams === undefined ? {} : { active_streams: entry.activeStreams }),
    }),
  );
}

/** The slice of `process` the safety net listens on — injectable for tests. */
export interface SafetyNetTarget {
  on(event: "unhandledRejection", listener: (reason: unknown) => void): unknown;
}

// Installed at most once per target, no matter how many servers we boot.
const netted = new WeakSet<SafetyNetTarget>();

/**
 * Install a process-level last line of defense.
 *
 * The per-request try/catch in {@link handle} is the real fix; this is
 * defense-in-depth for a stray rejection that somehow escapes it (a timer
 * callback, a background task). We log and keep serving rather than let one bad
 * request exit the process — but we deliberately do NOT touch
 * `uncaughtException`: Node's guidance is that an uncaught *synchronous* throw
 * leaves the process in an unknown state, and swallowing it can corrupt
 * subsequent requests. So we only net the async case.
 *
 * Idempotent: booting many servers in one process registers one listener, not
 * a leaking pile of them.
 */
export function installProcessSafetyNet(
  logError: (message: string, error: unknown) => void,
  target: SafetyNetTarget = process,
): void {
  if (netted.has(target)) {
    return;
  }

  netted.add(target);

  target.on("unhandledRejection", (reason) => {
    logError("unhandled rejection (kept serving)", reason);
  });
}

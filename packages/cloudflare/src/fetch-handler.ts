/**
 * Run a Volo app inside a Cloudflare Worker.
 *
 * A Worker is a single function: `fetch(Request) => Response`. Volo's dispatcher
 * is already a pure `(method, path, options) => VoloResponse` — no node:http, no
 * sockets — so putting Volo on the edge is *adapting the shapes*: a Web `Request`
 * in, a Web `Response` out, the same dispatch in between.
 *
 * But "the same dispatch" is not "the same request handling". The node server
 * (`@volo/runtime`) wraps every request in a per-request context, default security
 * headers, and an error boundary; an edge adapter that skipped them would be a
 * second, weaker front door to the same app — exactly the kind of adapter gap the
 * field's SSR CVEs keep landing in. So this handler runs the SAME transport-neutral
 * hardening the node server does (from `@volo/web`): it establishes a per-request
 * context (id, client identity, an abort signal that fires on client disconnect),
 * catches any dispatch throw and maps it to a safe coded status, and merges the
 * default security headers under every response.
 *
 * One node-only piece is deliberately not mirrored yet: the ETag/304 conditional
 * GET, whose hash is computed over `node:crypto`. Doing it on the edge needs an
 * async Web-Crypto hash; until then a streamed/HTML edge response simply carries no
 * ETag, exactly as a streamed node response does.
 */

import {
  bodyForStatus,
  DEFAULT_SECURITY_HEADERS,
  runWithContext,
  securityDefaults,
  statusForError,
  withSecurityHeaders,
} from "@volo/web";
import type { AnyVoloResponse, VoloBody, RequestContext, RequestContextSpan } from "@volo/web";

import { CloudflareError } from "./errors";

/** The per-request inputs the dispatcher reads, the same shape the node server passes. */
export interface EdgeRequestOptions {
  readonly query: Record<string, string>;

  readonly headers: Record<string, string>;

  readonly body: unknown;
}

/**
 * The pure dispatcher a Worker fronts — `dispatchSites` / `app.handle` satisfy it.
 *
 * Its response carries any {@link VoloBody} arm (string, bytes, or stream): the
 * site dispatcher can serve a binary file as bytes, and the edge `Response` takes
 * each natively. A string-bodied `app.handle` satisfies it, since a string body
 * is one arm of the wider type.
 */
export type EdgeDispatch = (
  method: string,
  path: string,
  options: EdgeRequestOptions,
) => Promise<AnyVoloResponse>;

/** One served edge request, as the access log records it (mirrors the node `AccessEntry`). */
export interface EdgeAccessEntry {
  readonly method: string;

  readonly path: string;

  readonly status: number;

  readonly ms: number;

  /** The per-request id minted for this request — the same id the context carries. */
  readonly requestId: string;
}

/**
 * One span over one served edge request — the same narrow tracing surface the
 * node server mints through, so a deployment wires one `Tracer` to both tiers.
 * Structurally satisfied by `@volo/observability`'s `Span`; no dependency.
 *
 * `data` carries the trace + span ids the runtime publishes on the request
 * context: it makes this assignable to `@volo/web`'s {@link RequestContextSpan},
 * so a seam fired DURING the edge request (a `@volo/db` query, an inline
 * `@volo/queue` job) parents its child span on the request span exactly as the
 * node tier does — completing op#3's "same tracing contract, both tiers".
 */
export interface EdgeRequestSpan {
  readonly data: { readonly traceId: string; readonly spanId: string };

  setAttribute(key: string, value: unknown): unknown;

  setStatus(status: "ok" | "error"): unknown;

  end(): void;
}

/**
 * An inbound W3C trace context the edge request joins — the ids parsed off the
 * `traceparent` header. Structurally what `@volo/observability`'s
 * `parseTraceparent` returns (and what its `RequestTracer.startSpan` accepts), so
 * a Worker passes the SAME parser the node server does and one request crossing
 * services stays one trace. No dependency on the tracing package.
 */
export interface EdgeInboundTrace {
  readonly traceId: string;

  readonly parentId: string;
}

/**
 * Mints {@link EdgeRequestSpan}s — `@volo/observability`'s request tracer,
 * structurally. `startSpan(name, inbound?)` adopts an inbound `traceparent` join
 * when one was parsed (the cross-process continuation), exactly as the node
 * server's `RequestTracer` does; absent, it roots a fresh trace.
 */
export interface EdgeRequestTracer {
  startSpan(name: string, inbound?: EdgeInboundTrace): EdgeRequestSpan;
}

/**
 * Parses a W3C `traceparent` header into the inbound trace the request span
 * continues — `@volo/observability`'s `parseTraceparent`, structurally. Injected
 * so the adapter takes no dependency on the tracing package; a Worker passes the
 * SAME parser the node server gets, so the propagation format never diverges.
 */
export type EdgeTraceparentParser = (header: string | undefined) => EdgeInboundTrace | undefined;

/**
 * The slice of Cloudflare's `ExecutionContext` the adapter uses: `waitUntil`,
 * which extends the Worker's lifetime past the returned `Response` until the
 * given promise settles. The edge has no steady process to flush traces on an
 * interval (the node tier's cadence), so it schedules the exporter's `flush`
 * here — the spans drain AFTER the response is sent, never on its critical path
 * and never lost when the isolate would otherwise be frozen at `return`.
 *
 * Structurally Cloudflare's `ExecutionContext`; optional on the handler so a
 * node-shaped caller (a test, the local dev server) can drive the same handler
 * with no second argument.
 */
export interface EdgeExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

/** The largest request body the edge reads before refusing it with 413. Defaults to 1 MiB (node parity). */
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

/**
 * The default edge access log: one structured JSON line per request.
 *
 * Mirrors the node server's `defaultLogRequest` shape exactly (`level`, `event`,
 * `method`, `path`, `status`, `ms`, `request_id`) so one log pipeline parses both
 * tiers identically — a queryable object, not a string to scrape. A custom
 * `logRequest` sink overrides this wholesale; the {@link EdgeAccessEntry} it
 * receives is unchanged.
 */
function defaultEdgeLogRequest(entry: EdgeAccessEntry): void {
  console.log(
    JSON.stringify({
      level: "info",
      event: "http.access",
      method: entry.method,
      path: entry.path,
      status: entry.status,
      ms: entry.ms,
      request_id: entry.requestId,
    }),
  );
}

/**
 * How the edge handler hardens a response — the same knobs `serve` exposes on the
 * node server, so a deployment configures one security posture for both runtimes.
 */
export interface EdgeOptions {
  /**
   * The largest request body the edge will read before refusing it with 413.
   *
   * The node server enforces this on the socket; the edge enforces it here so an
   * unauthenticated client cannot stream an unbounded body into a worker's
   * memory, instead of leaning on the platform's coarse ceiling. Defaults to 1 MiB.
   */
  readonly maxBodyBytes?: number;

  /**
   * Where each served request is logged — method, path, status, latency, id. The
   * real prod target logged errors only; this gives it the per-request access log
   * the node server has. Defaults to one line per request on `console.log`; pass
   * your own sink to ship structured logs, or a no-op to silence it.
   */
  readonly logRequest?: (entry: EdgeAccessEntry) => void;

  /** The clock the access log times requests against. Injected for tests; defaults to `Date.now`. */
  readonly now?: () => number;

  /**
   * Mints one span per served request, mirroring the node server's `tracer`
   * option. Off by default; pair with an `OtlpHttpExporter` flushed through the
   * Worker's `waitUntil` (see {@link flush}) to ship traces without holding the
   * response. The minted span is published on the request context, so a seam
   * fired during the request parents its child span on it.
   */
  readonly tracer?: EdgeRequestTracer;

  /**
   * Parses an inbound `traceparent` header into the trace the request span
   * joins, so a request crossing services stays one trace. Pass
   * `@volo/observability`'s `parseTraceparent` (it satisfies this structurally).
   * Absent — or a malformed/missing header — roots a fresh trace, the safe
   * default. Only consulted when a {@link tracer} is also set.
   */
  readonly parseTraceparent?: EdgeTraceparentParser;

  /**
   * Drains buffered telemetry after the response is sent. When a `ctx`
   * (Cloudflare's `ExecutionContext`) is passed to the handler, this is scheduled
   * via `ctx.waitUntil(flush())` so the spans this request produced ship AFTER
   * the `Response` returns — off the request's critical path, and never lost to
   * the isolate freezing at `return` (the failure mode the edge has no interval
   * to cover). Pair it with the exporter behind {@link tracer}, e.g.
   * `flush: () => exporter.flush()`. Idempotent and must never throw — a flush
   * fault is the exporter's to swallow, never the request's to fail on.
   *
   * No-op without a `ctx` (a node-shaped caller has no `waitUntil`); the node
   * tier flushes on its own interval + drain instead.
   */
  readonly flush?: () => Promise<void>;

  /**
   * Default response headers merged under every response — the app's own headers
   * always win. Defaults to the shared {@link DEFAULT_SECURITY_HEADERS}; pass
   * `false` to send none, or a map to replace the defaults wholesale.
   */
  readonly securityHeaders?: false | Record<string, string>;

  /**
   * Conditional-GET ETag/304 for buffered dynamic edge responses.
   *
   * On by default: a buffered (string/bytes) HTML 200 without its own `ETag` is
   * hashed (async Web-Crypto SHA-256), and a request whose `If-None-Match` still
   * matches is answered with a bodiless 304 — the edge twin of the node server's
   * `etag`, finally mirrored now that a Worker can hash asynchronously. A streamed
   * body cannot be tagged (hashing drains it) and is sent untagged, exactly as on
   * node. Pass `false` to disable.
   */
  readonly etag?: false;

  /**
   * The longest a single dispatch may run before the edge answers 503 and frees
   * the request. The platform enforces a coarse CPU ceiling; this is a
   * cooperative app-level cap (the edge twin of the node server's
   * `handlerTimeoutMs`) so a slow upstream answers a clean coded 503 rather than
   * letting the isolate be killed mid-flight. On overrun the request's
   * `context.signal` is aborted so a cooperative handler stops. Off by default
   * (no timer, no overhead).
   */
  readonly timeoutMs?: number;

  /** A Content-Security-Policy, off by default (see the node server's `csp`). */
  readonly csp?: { readonly policy: string; readonly mode: "enforce" | "report-only" };

  /** Opt in to `Cross-Origin-Embedder-Policy: require-corp` (off by default). */
  readonly crossOriginEmbedderPolicy?: boolean;

  /** Mints the per-request id put on the context. Injected for tests; defaults to `crypto.randomUUID`. */
  readonly newRequestId?: () => string;

  /** Where an uncaught dispatch failure is reported. Injected for tests; defaults to `console.error`. */
  readonly logError?: (message: string, error: unknown) => void;
}

/** Flatten a URL's search params to a record; the last value wins on repeats. */
function queryFrom(params: URLSearchParams): Record<string, string> {
  const query: Record<string, string> = {};

  for (const [key, value] of params) {
    query[key] = value;
  }

  return query;
}

/** Flatten Web `Headers` to a record. Keys arrive already lowercased. */
function headersFrom(headers: Headers): Record<string, string> {
  const flat: Record<string, string> = {};

  headers.forEach((value, key) => {
    flat[key] = value;
  });

  return flat;
}

/**
 * A decoded body, or the client-error status the caller answers with: 413 when
 * the body exceeds the cap, 400 when a declared-JSON body did not parse.
 */
type Decoded =
  | { readonly ok: true; readonly body: unknown }
  | { readonly ok: false; readonly status: 400 | 413 };

/**
 * Read a request body, stopping the moment it exceeds `maxBytes`.
 *
 * The read is bounded *while streaming* — over the cap, the stream is cancelled
 * and the bytes already buffered are dropped — so an unbounded client body can
 * never occupy more than the cap in worker memory. Buffering it whole and
 * checking afterwards would defend nothing. Mirrors the node server's `readBody`.
 */
async function readBounded(request: Request, maxBytes: number): Promise<Uint8Array | undefined> {
  if (request.body === null) return new Uint8Array(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) break;

    received += value.byteLength;

    if (received > maxBytes) {
      await reader.cancel();

      return undefined;
    }

    chunks.push(value);
  }

  const all = new Uint8Array(received);
  let offset = 0;

  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return all;
}

/**
 * Decode the request body the way a controller expects it, bounded by `maxBytes`.
 *
 * The read is refused with 413 the moment it passes the cap (see
 * {@link readBounded}). Empty is `undefined` (no body, not an empty string); a
 * JSON content-type is parsed, and a parse failure is a *client* error the
 * caller turns into a 400 — never an exception. Anything else stays the raw text.
 */
async function decodeBody(
  request: Request,
  contentType: string | undefined,
  maxBytes: number,
): Promise<Decoded> {
  const bytes = await readBounded(request, maxBytes);

  if (bytes === undefined) {
    return { ok: false, status: 413 };
  }

  if (bytes.byteLength === 0) {
    return { ok: true, body: undefined };
  }

  const text = new TextDecoder().decode(bytes);

  if (contentType !== undefined && contentType.startsWith("application/json")) {
    try {
      return { ok: true, body: JSON.parse(text) as unknown };
    } catch {
      return { ok: false, status: 400 };
    }
  }

  return { ok: true, body: text };
}

/**
 * Adapt a Volo body to the Web `Response`'s `BodyInit`.
 *
 * A Web `Response` natively accepts all three Volo body arms — a string, raw
 * bytes (a `BufferSource`), and a `ReadableStream`. The cast is only a *types*
 * bridge between the DOM lib and `@types/node`; at runtime they are the same
 * bytes / the same stream, so a widened Volo body flows to the edge untouched.
 */
function toBodyInit(body: VoloBody): BodyInit {
  return body as BodyInit;
}

/**
 * Build a Web `Headers` from a Volo header map, emitting one line per value.
 *
 * A `VoloResponse` header map carries a single string OR a list of values, and
 * the list is load-bearing for `Set-Cookie`: per RFC 6265 each cookie is its own
 * `Set-Cookie` line and they cannot be comma-joined (a cookie's `Expires` date
 * contains a comma). Workers' `Headers` models this exactly — `append` adds a
 * line without replacing — so a list value is appended element by element while a
 * single value is set once. A naive `new Response(body, { headers: map })` cannot
 * express a list at all (its init type is `Record<string, string>`), which is
 * precisely why the seam builds `Headers` itself: two cookies reach the browser
 * as two lines, not one mangled line.
 */
function toHeaders(map: Record<string, string | string[]>): Headers {
  const headers = new Headers();

  for (const [name, value] of Object.entries(map)) {
    if (Array.isArray(value)) {
      for (const line of value) headers.append(name, line);
    } else {
      headers.set(name, value);
    }
  }

  return headers;
}

/** Lowercase-hex a digest's bytes — the textual form an ETag wraps in quotes. */
function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Compute a strong ETag for a buffered edge body via async Web-Crypto SHA-256.
 *
 * The node tier hashes over `node:crypto` (synchronous SHA-1); a Worker has no
 * `node:crypto`, so the edge uses the platform's `crypto.subtle.digest` — which
 * is async, the reason this could not be mirrored until now. SHA-256 truncated to
 * 32 hex chars (128 bits) is ample to distinguish bodies; this is a cache key for
 * change detection, never a security boundary. A `string` body is UTF-8 encoded
 * first; raw bytes are hashed as-is.
 */
async function edgeEtag(body: string | Uint8Array): Promise<string> {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;

  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);

  return `"${toHex(digest).slice(0, 32)}"`;
}

/** Drop a leading `W/` so weak and strong forms of one tag compare equal. */
function stripWeak(etag: string): string {
  return etag.startsWith("W/") ? etag.slice(2) : etag;
}

/**
 * Whether a request's `If-None-Match` matches the response's ETag.
 *
 * The edge twin of the node `etagMatches` (RFC 7232's weak compare): the list is
 * comma-split so a client offering several cached tags still matches, `W/"x"` and
 * `"x"` compare equal (a 304 only promises semantic equivalence), and a literal
 * `*` matches any current representation. Self-contained because the edge package
 * does not depend on `@volo/runtime` where the node copy lives.
 */
function ifNoneMatchMatches(ifNoneMatch: string | null, etag: string): boolean {
  if (ifNoneMatch === null) return false;

  const wanted = stripWeak(etag);

  return ifNoneMatch
    .split(",")
    .map((candidate) => candidate.trim())
    .some((candidate) => candidate === "*" || stripWeak(candidate) === wanted);
}

/** True iff a header map declares an HTML content-type (any header casing). */
function declaresHtml(headers: Record<string, string | string[]>): boolean {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== "content-type") continue;

    const text = Array.isArray(value) ? value.join(", ") : value;

    if (text.toLowerCase().includes("text/html")) return true;
  }

  return false;
}

/** Whether a header map already carries a header named `name` (any casing). */
function hasHeader(headers: Record<string, string | string[]>, name: string): boolean {
  const lower = name.toLowerCase();

  return Object.keys(headers).some((key) => key.toLowerCase() === lower);
}

/**
 * Attach a conditional-GET ETag to a buffered, cacheable HTML edge response.
 *
 * The edge half of the node server's `withEtag`, gated to exactly the same shape:
 * a 200 with a buffered (string/bytes) HTML body, where the app has not set its
 * own `ETag`. A streamed body cannot be tagged (hashing would drain it), a
 * non-200 carries no cacheable entity, and a non-HTML payload owns its own
 * caching — each passes through untagged. Returns the (possibly tagged) response
 * and the tag to compare `If-None-Match` against, or `undefined` when none was
 * added. Async because {@link edgeEtag} is.
 */
async function withEdgeEtag(
  response: AnyVoloResponse,
): Promise<{ response: AnyVoloResponse; etag: string | undefined }> {
  if (response.status !== 200) return { response, etag: undefined };

  if (hasHeader(response.headers, "etag")) return { response, etag: undefined };

  if (!declaresHtml(response.headers)) return { response, etag: undefined };

  const { body } = response;

  // Only a fully-buffered body can be hashed; a stream would have to be drained.
  if (typeof body !== "string" && !(body instanceof Uint8Array)) {
    return { response, etag: undefined };
  }

  const etag = await edgeEtag(body);

  return { response: { ...response, headers: { ...response.headers, ETag: etag } }, etag };
}

/**
 * Race a dispatch against a deadline, refusing with a coded 503 on overrun.
 *
 * A Worker has a platform CPU ceiling, but a cooperative `timeoutMs` lets an app
 * cap a slow upstream itself and answer a clean 503 rather than letting the
 * isolate be killed — the edge twin of the node server's `handlerTimeoutMs`. On
 * overrun we throw a coded {@link CloudflareError} (mapped to 503 by
 * `statusForError`), and the request's `context.signal` is aborted so a
 * cooperative handler stops working for a response no one will read. The timer is
 * cleared whichever way the race settles, so a fast dispatch leaves nothing
 * pending.
 */
function raceTimeout(
  work: Promise<AnyVoloResponse>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<AnyVoloResponse> {
  return new Promise<AnyVoloResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();

      reject(
        new CloudflareError(
          "CLOUDFLARE_DISPATCH_TIMEOUT",
          "Edge dispatch exceeded its time limit.",
          { timeoutMs },
        ),
      );
    }, timeoutMs);

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

/**
 * Build the per-request context for the edge.
 *
 * Mirrors the node server's context: a fresh id, the client identity, and an
 * abort signal. On Cloudflare the trustworthy client IP is `cf-connecting-ip`
 * (set by the edge, not forgeable by the client), the protocol comes from the
 * request URL, and the `signal` fires when the client disconnects OR (when a
 * `timeoutMs` is configured) the dispatch overruns — so streaming/long work
 * reads `currentContext()?.signal` and cancels for free.
 */
function edgeContext(
  url: URL,
  headers: Record<string, string>,
  requestId: string,
  signal: AbortSignal,
): RequestContext {
  const context: RequestContext = {
    requestId,
    protocol: url.protocol === "https:" ? "https" : "http",
    signal,
  };

  const ip = headers["cf-connecting-ip"];

  if (ip !== undefined) {
    context.ip = ip;
  }

  return context;
}

/**
 * A per-request abort signal that fires on EITHER the client disconnecting or the
 * dispatch deadline (when one is set) — the edge twin of the node server's
 * `requestCancellation`.
 *
 * `request.signal` already aborts when the client hangs up, but it is read-only:
 * we cannot also abort it on a timeout. So we mint our own controller, forward the
 * client's disconnect onto it, and return an `abortTimeout` the deadline calls —
 * both feed the SAME signal, so a cooperative handler stops on whichever happens.
 * When the request is already aborted (a disconnect that beat us here), we adopt
 * the reason immediately so the signal is correct from the first read.
 */
function edgeCancellation(request: Request): {
  signal: AbortSignal;
  abortTimeout: () => void;
} {
  const controller = new AbortController();

  const onClientAbort = (): void => controller.abort(request.signal.reason);

  if (request.signal.aborted) {
    onClientAbort();
  } else {
    request.signal.addEventListener("abort", onClientAbort, { once: true });
  }

  const abortTimeout = (): void => {
    controller.abort(
      new CloudflareError("CLOUDFLARE_DISPATCH_TIMEOUT", "Edge dispatch exceeded its time limit."),
    );
  };

  return { signal: controller.signal, abortTimeout };
}

/**
 * Decode the body and run the dispatcher under an error boundary.
 *
 * A malformed declared-JSON body is a 400 before dispatch. Any throw from the
 * dispatcher is caught and mapped to a coded status with a safe, generic body —
 * an attacker can degrade their own request, never crash the worker or read an
 * internal error off the wire. A 500 (an unexpected throw) is logged; a coded
 * client error is the client's to own, not ours to explain.
 */
async function dispatchHardened(
  request: Request,
  url: URL,
  headers: Record<string, string>,
  dispatch: EdgeDispatch,
  logError: (message: string, error: unknown) => void,
  maxBodyBytes: number,
  timeoutMs: number | undefined,
  abortTimeout: () => void,
): Promise<AnyVoloResponse> {
  const decoded = await decodeBody(request, headers["content-type"], maxBodyBytes);

  if (!decoded.ok) {
    return {
      status: decoded.status,
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: bodyForStatus(decoded.status),
    };
  }

  try {
    const work = dispatch(request.method, url.pathname, {
      query: queryFrom(url.searchParams),
      headers,
      body: decoded.body,
    });

    // A configured `timeoutMs` races the dispatch: on overrun the race rejects
    // with the coded timeout (mapped to 503 below) AND aborts `context.signal` via
    // `abortTimeout`, so a cooperative handler stops. Absent, the dispatch is
    // awaited directly — no timer, no overhead.
    return await (timeoutMs === undefined ? work : raceTimeout(work, timeoutMs, abortTimeout));
  } catch (error) {
    const status = statusForError(error);

    if (status === 500) {
      logError("unhandled error serving request", error);
    }

    return {
      status,
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: bodyForStatus(status),
    };
  }
}

/**
 * Adapt a Volo dispatcher into a hardened Worker `fetch` handler.
 *
 * Establishes a per-request context (so `currentContext()` works on the edge as
 * on the node server), runs the dispatcher inside it under an error boundary, and
 * merges the default security headers under the response — the same hardening the
 * node `serve` applies. The body passes through in whatever arm the dispatcher
 * produced (string, bytes, or stream), each accepted natively by a `Response`.
 *
 * The returned handler takes Cloudflare's `(request, ctx?)`: the optional second
 * argument is the Worker `ExecutionContext`. When tracing is wired and a `ctx` is
 * passed, the exporter's `flush` is scheduled through `ctx.waitUntil` so the
 * spans this request produced drain AFTER the `Response` returns — the edge has
 * no steady process to flush on an interval, so this is how no span is lost once
 * the isolate freezes at `return` (edge-deploy #3). The `ctx` is OPTIONAL so a
 * node-shaped caller (a test, the local dev server) drives the same handler with
 * one argument — the arity is purely additive.
 */
export function toFetchHandler(
  dispatch: EdgeDispatch,
  options: EdgeOptions = {},
): (request: Request, ctx?: EdgeExecutionContext) => Promise<Response> {
  const securityHeaders = securityDefaults(options.securityHeaders ?? DEFAULT_SECURITY_HEADERS, {
    csp: options.csp,
    crossOriginEmbedderPolicy: options.crossOriginEmbedderPolicy,
  });

  const newRequestId = options.newRequestId ?? (() => crypto.randomUUID());

  const logError =
    options.logError ?? ((message: string, error: unknown) => console.error(message, error));

  const logRequest = options.logRequest ?? defaultEdgeLogRequest;

  const now = options.now ?? (() => Date.now());

  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  const tracer = options.tracer;

  const flush = options.flush;

  const timeoutMs = options.timeoutMs;

  const etagEnabled = options.etag !== false;

  return async (request, ctx) => {
    const start = now();

    // A W3C `traceparent` on the inbound request joins this hop to the caller's
    // trace, exactly as the node server does: parsed only when a tracer is wired
    // (no tracer, no parse), and the parser is injected so the adapter takes no
    // dependency on the tracing package. A malformed/absent header parses to
    // `undefined` and roots a fresh trace — the safe default.
    const inbound =
      tracer === undefined
        ? undefined
        : options.parseTraceparent?.(request.headers.get("traceparent") ?? undefined);

    // The request's span opens with the work and closes beside the access line,
    // exactly as the node server does — one tracing contract across both tiers.
    const span = tracer?.startSpan("http.request", inbound);

    const url = new URL(request.url);

    const headers = headersFrom(request.headers);

    const requestId = newRequestId();

    // A per-request signal that fires on client disconnect OR (when configured) a
    // dispatch overrun — both feed the one signal the context publishes.
    const cancellation = edgeCancellation(request);

    const context = edgeContext(url, headers, requestId, cancellation.signal);

    // Publish the span on the request context so a seam fired DURING the request
    // (a `@volo/db` query, an inline `@volo/queue` job) parents its child span on
    // it — a query shows up under the request that ran it, the same as the node
    // tier. `EdgeRequestSpan.data` is exactly the slice `RequestContextSpan`
    // reads, so this is the structural assignment, not a cast.
    if (span !== undefined) {
      context.span = span as RequestContextSpan;
    }

    return runWithContext(context, async () => {
      try {
        const response = await dispatchHardened(
          request,
          url,
          headers,
          dispatch,
          logError,
          maxBodyBytes,
          timeoutMs,
          cancellation.abortTimeout,
        );

        // Tag a cacheable HTML response (async SHA-256), then harden it. A
        // conditional GET whose validator still matches is answered with a
        // bodiless 304 — the client already holds the bytes. The tag is computed
        // on the body BEFORE hardening adds security headers, exactly as the node
        // tier does. Disabled responses (and non-HTML/streamed/non-200) skip it.
        const tagged = etagEnabled ? await withEdgeEtag(response) : { response, etag: undefined };

        const hardened = withSecurityHeaders(tagged.response, securityHeaders);

        const notModified =
          tagged.etag !== undefined &&
          ifNoneMatchMatches(request.headers.get("if-none-match"), tagged.etag);

        const status = notModified ? 304 : hardened.status;

        // One access line per served request — the same shape the node server logs,
        // stitched to the request id so an edge log and any context-tagged work line up.
        logRequest({
          method: request.method,
          path: url.pathname,
          status,
          ms: now() - start,
          requestId,
        });

        if (span !== undefined) {
          span.setAttribute("http.method", request.method);
          span.setAttribute("http.path", url.pathname);
          span.setAttribute("http.status_code", status);
          span.setAttribute("volo.request_id", requestId);
          // A 5xx is the server's failure; everything else was answered as designed.
          span.setStatus(status >= 500 ? "error" : "ok");
          span.end();
        }

        // A 304 carries the validators but no body; a normal response carries its
        // body. Headers go out through `toHeaders` so a multi-valued `Set-Cookie`
        // becomes one line per cookie (never a comma-joined line a browser drops).
        if (notModified) {
          return new Response(null, { status: 304, headers: toHeaders(hardened.headers) });
        }

        return new Response(toBodyInit(hardened.body), {
          status: hardened.status,
          headers: toHeaders(hardened.headers),
        });
      } finally {
        // Drain the spans this request produced AFTER the response is sent. The
        // edge has no flush interval, so `waitUntil` extends the isolate's life
        // past `return` until the exporter has shipped the batch — the contract
        // that makes "no span lost after return" true. Scheduled in `finally` so
        // the error path flushes too; the no-op when there is no `ctx`/`flush`
        // keeps a node-shaped caller and an untraced worker free of cost.
        if (ctx !== undefined && flush !== undefined) {
          ctx.waitUntil(flush());
        }
      }
    });
  };
}

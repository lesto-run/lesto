/**
 * Run a Keel app inside a Cloudflare Worker.
 *
 * A Worker is a single function: `fetch(Request) => Response`. Keel's dispatcher
 * is already a pure `(method, path, options) => KeelResponse` — no node:http, no
 * sockets — so putting Keel on the edge is *adapting the shapes*: a Web `Request`
 * in, a Web `Response` out, the same dispatch in between.
 *
 * But "the same dispatch" is not "the same request handling". The node server
 * (`@keel/runtime`) wraps every request in a per-request context, default security
 * headers, and an error boundary; an edge adapter that skipped them would be a
 * second, weaker front door to the same app — exactly the kind of adapter gap the
 * field's SSR CVEs keep landing in. So this handler runs the SAME transport-neutral
 * hardening the node server does (from `@keel/web`): it establishes a per-request
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
} from "@keel/web";
import type { AnyKeelResponse, KeelBody, RequestContext } from "@keel/web";

/** The per-request inputs the dispatcher reads, the same shape the node server passes. */
export interface EdgeRequestOptions {
  readonly query: Record<string, string>;

  readonly headers: Record<string, string>;

  readonly body: unknown;
}

/**
 * The pure dispatcher a Worker fronts — `dispatchSites` / `app.handle` satisfy it.
 *
 * Its response carries any {@link KeelBody} arm (string, bytes, or stream): the
 * site dispatcher can serve a binary file as bytes, and the edge `Response` takes
 * each natively. A string-bodied `app.handle` satisfies it, since a string body
 * is one arm of the wider type.
 */
export type EdgeDispatch = (
  method: string,
  path: string,
  options: EdgeRequestOptions,
) => Promise<AnyKeelResponse>;

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
 * Structurally satisfied by `@keel/observability`'s `Tracer`; no dependency.
 */
export interface EdgeRequestSpan {
  setAttribute(key: string, value: unknown): unknown;

  setStatus(status: "ok" | "error"): unknown;

  end(): void;
}

/** Mints {@link EdgeRequestSpan}s — `@keel/observability`'s `Tracer`, structurally. */
export interface EdgeRequestTracer {
  startSpan(name: string): EdgeRequestSpan;
}

/** The largest request body the edge reads before refusing it with 413. Defaults to 1 MiB (node parity). */
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

/** The default edge access log: one line per request, method · path · status · latency · id. */
function defaultEdgeLogRequest(entry: EdgeAccessEntry): void {
  console.log(`${entry.method} ${entry.path} ${entry.status} ${entry.ms}ms ${entry.requestId}`);
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
   * Worker's `waitUntil` to ship traces without holding the response.
   */
  readonly tracer?: EdgeRequestTracer;

  /**
   * Default response headers merged under every response — the app's own headers
   * always win. Defaults to the shared {@link DEFAULT_SECURITY_HEADERS}; pass
   * `false` to send none, or a map to replace the defaults wholesale.
   */
  readonly securityHeaders?: false | Record<string, string>;

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
 * Adapt a Keel body to the Web `Response`'s `BodyInit`.
 *
 * A Web `Response` natively accepts all three Keel body arms — a string, raw
 * bytes (a `BufferSource`), and a `ReadableStream`. The cast is only a *types*
 * bridge between the DOM lib and `@types/node`; at runtime they are the same
 * bytes / the same stream, so a widened Keel body flows to the edge untouched.
 */
function toBodyInit(body: KeelBody): BodyInit {
  return body as BodyInit;
}

/**
 * Build the per-request context for the edge.
 *
 * Mirrors the node server's context: a fresh id, the client identity, and an
 * abort signal. On Cloudflare the trustworthy client IP is `cf-connecting-ip`
 * (set by the edge, not forgeable by the client), the protocol comes from the
 * request URL, and `request.signal` already fires when the client disconnects —
 * so streaming/long work reads `currentContext()?.signal` and cancels for free.
 */
function edgeContext(
  request: Request,
  url: URL,
  headers: Record<string, string>,
  requestId: string,
): RequestContext {
  const context: RequestContext = {
    requestId,
    protocol: url.protocol === "https:" ? "https" : "http",
    signal: request.signal,
  };

  const ip = headers["cf-connecting-ip"];

  if (ip !== undefined) {
    context.ip = ip;
  }

  return context;
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
): Promise<AnyKeelResponse> {
  const decoded = await decodeBody(request, headers["content-type"], maxBodyBytes);

  if (!decoded.ok) {
    return {
      status: decoded.status,
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: bodyForStatus(decoded.status),
    };
  }

  try {
    return await dispatch(request.method, url.pathname, {
      query: queryFrom(url.searchParams),
      headers,
      body: decoded.body,
    });
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
 * Adapt a Keel dispatcher into a hardened Worker `fetch` handler.
 *
 * Establishes a per-request context (so `currentContext()` works on the edge as
 * on the node server), runs the dispatcher inside it under an error boundary, and
 * merges the default security headers under the response — the same hardening the
 * node `serve` applies. The body passes through in whatever arm the dispatcher
 * produced (string, bytes, or stream), each accepted natively by a `Response`.
 */
export function toFetchHandler(
  dispatch: EdgeDispatch,
  options: EdgeOptions = {},
): (request: Request) => Promise<Response> {
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

  return async (request) => {
    const start = now();

    // The request's span opens with the work and closes beside the access line,
    // exactly as the node server does — one tracing contract across both tiers.
    const span = tracer?.startSpan("http.request");

    const url = new URL(request.url);

    const headers = headersFrom(request.headers);

    const requestId = newRequestId();

    const context = edgeContext(request, url, headers, requestId);

    return runWithContext(context, async () => {
      const response = await dispatchHardened(
        request,
        url,
        headers,
        dispatch,
        logError,
        maxBodyBytes,
      );

      const hardened = withSecurityHeaders(response, securityHeaders);

      // One access line per served request — the same shape the node server logs,
      // stitched to the request id so an edge log and any context-tagged work line up.
      logRequest({
        method: request.method,
        path: url.pathname,
        status: hardened.status,
        ms: now() - start,
        requestId,
      });

      if (span !== undefined) {
        span.setAttribute("http.method", request.method);
        span.setAttribute("http.path", url.pathname);
        span.setAttribute("http.status_code", hardened.status);
        span.setAttribute("keel.request_id", requestId);
        // A 5xx is the server's failure; everything else was answered as designed.
        span.setStatus(hardened.status >= 500 ? "error" : "ok");
        span.end();
      }

      return new Response(toBodyInit(hardened.body), {
        status: hardened.status,
        headers: hardened.headers,
      });
    });
  };
}

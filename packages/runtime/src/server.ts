import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { App } from "@keel/kernel";
import {
  bodyForStatus,
  DEFAULT_SECURITY_HEADERS,
  RECOMMENDED_CSP,
  runWithContext,
  securityDefaults,
  statusForError,
  withSecurityHeaders,
} from "@keel/web";
import type {
  AnyKeelResponse,
  KeelResponse,
  RequestContext,
  SecurityHeaderOptions,
} from "@keel/web";

// The hardening pieces now live in @keel/web so the node server and the edge
// adapter share one source (see `@keel/web/harden`). Re-exported here so the
// runtime's public surface and its tests keep reaching them at the same names.
export { DEFAULT_SECURITY_HEADERS, RECOMMENDED_CSP, securityDefaults, withSecurityHeaders };
export type { SecurityHeaderOptions };

import { applyResponse } from "./response";
import { toKeelRequest } from "./request";
import { RuntimeError } from "./errors";
import { etagFor, etagMatches, respondNotModified } from "./http-cache";
import { resolveClient } from "./trust-proxy";

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
}

/**
 * One span over one served request — the narrow tracing surface the server
 * mints through.
 *
 * Structurally satisfied by `@keel/observability`'s `Span`/`Tracer`, so the
 * runtime records real traces without depending on the tracing package: what
 * varies is injected, as everywhere else in this file.
 */
export interface RequestSpan {
  setAttribute(key: string, value: unknown): unknown;

  setStatus(status: "ok" | "error"): unknown;

  end(): void;
}

/** Mints {@link RequestSpan}s — `@keel/observability`'s `Tracer`, structurally. */
export interface RequestTracer {
  startSpan(name: string): RequestSpan;
}

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
   * The longest a single handler may run before we answer 503 and free the
   * socket. The handler is abandoned, not cancelled — JS cannot kill a running
   * task — but the client and its socket are released rather than held forever
   * by a hung or pathologically slow controller. Defaults to 30s.
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
   * No enforcing CSP is sent unless one is configured: Keel's island bootstrap
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
   * test can assert without writing to the console; defaults to `console.log`.
   */
  readonly logRequest?: (entry: AccessEntry) => void;

  /**
   * Mints one span per served request — the trace counterpart of the access
   * log. Off by default (no tracer, no spans, zero overhead); pass
   * `@keel/observability`'s `Tracer` (it satisfies this structurally, so the
   * runtime takes no dependency) and every request records a `http.request`
   * span carrying method, path, status, and the request id, with `error`
   * status on a 5xx.
   */
  readonly tracer?: RequestTracer;

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

/** Handler/socket budgets, tightened below Node's defaults for a public tier. */
const DEFAULT_HANDLER_TIMEOUT_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_HEADERS_TIMEOUT_MS = 15_000;
const DEFAULT_KEEP_ALIVE_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_HEADER_BYTES = 16 * 1024;
const DEFAULT_DRAIN_TIMEOUT_MS = 10_000;

const DEFAULT_LIVE_PATH = "/health";
const DEFAULT_READY_PATH = "/readyz";

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
 * Race a promise against a deadline.
 *
 * On overrun we reject with a coded {@link RuntimeError} (mapped to a 503) and
 * leave `work` to settle whenever it eventually does — we attach handlers to it
 * so its late resolution or rejection is swallowed, never surfacing as an
 * unhandled rejection. The timer is `unref`'d so a pending deadline never keeps
 * the process alive on its own.
 */
export function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
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

/**
 * Answer a liveness/readiness probe, or `undefined` to let the app handle it.
 *
 * Liveness (`/health`) is a bare 200 — the process is up. Readiness (`/readyz`)
 * consults the injected probe and is a 503 when the app is not ready to take
 * traffic. Both answer only GET/HEAD; anything else falls through to the app so
 * a real route at the same path still works.
 */
export async function healthResponse(
  method: string,
  path: string,
  options: HealthOptions,
): Promise<KeelResponse | undefined> {
  if (method !== "GET" && method !== "HEAD") return undefined;

  const headers = { "content-type": "text/plain; charset=utf-8" };

  if (path === (options.livePath ?? DEFAULT_LIVE_PATH)) {
    return { status: 200, headers, body: "ok" };
  }

  if (path === (options.readyPath ?? DEFAULT_READY_PATH)) {
    const ready = await (options.isReady ?? (() => true))();

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
  response: AnyKeelResponse,
  config: EtagConfig,
): { response: AnyKeelResponse; etag: string | undefined } {
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
function isHtml(headers: Record<string, string>): boolean {
  return Object.entries(headers).some(
    ([name, value]) =>
      name.toLowerCase() === "content-type" && value.toLowerCase().includes("text/html"),
  );
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
 * Boot a node:http server that serves a Keel {@link App}.
 *
 * Each request is read in full, normalized into a transport-free `KeelRequest`,
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

  const deps: HandleDeps = {
    maxBodyBytes: options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    handlerTimeoutMs: options.handlerTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS,
    health: options.health === false ? undefined : (options.health ?? {}),
    securityHeaders: securityDefaults(options.securityHeaders ?? DEFAULT_SECURITY_HEADERS, {
      csp: options.csp,
      crossOriginEmbedderPolicy: options.crossOriginEmbedderPolicy,
    }),
    etag: options.etag ?? {},
    trustProxy: options.trustProxy ?? false,
    newRequestId: options.newRequestId ?? randomUUID,
    logRequest: options.logRequest ?? defaultLogRequest,
    logError,
    now: options.now ?? Date.now,
    ...(options.tracer === undefined ? {} : { tracer: options.tracer }),
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

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      // listen() resolved, so address() is a bound AddressInfo, not null.
      const address = server.address() as AddressInfo;

      resolve({
        port: address.port,

        close: () => drainServer(server, drainTimeoutMs),
      });
    });
  });
}

interface HandleDeps {
  readonly maxBodyBytes: number;

  readonly handlerTimeoutMs: number;

  /** Health endpoints, or `undefined` when disabled. */
  readonly health: HealthOptions | undefined;

  readonly securityHeaders: Record<string, string> | false;

  /** Conditional-GET ETag behaviour for HTML responses; `false` disables it. */
  readonly etag: EtagConfig;

  /** Whom to believe about the client IP/protocol; `false` trusts nothing. */
  readonly trustProxy: TrustProxy;

  /** Mints the per-request id for the request context. */
  readonly newRequestId: () => string;

  readonly logRequest: (entry: AccessEntry) => void;

  readonly logError: (message: string, error: unknown) => void;

  readonly now: () => number;

  /** Mints one span per request, or absent for the zero-overhead default. */
  readonly tracer?: RequestTracer;
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
 * Build the per-request context: a fresh id, plus the trust-proxy-resolved
 * client IP and protocol.
 *
 * The id is minted here (one per request, for tracing); the IP/protocol come
 * from {@link resolveClient}, which believes the forwarding headers only when
 * the policy trusts the socket peer (see the spoofing hazard there). We collapse
 * a repeated forwarding header to its first value before handing it over. Pure
 * over its inputs and exported so the id-stamping and the trust resolution are
 * testable without a socket.
 *
 * `exactOptionalPropertyTypes` is on, so we attach `ip` only when one resolved —
 * an absent IP is the key absent, not present-and-`undefined`.
 */
export function establishContext(
  source: ContextSource,
  trustProxy: TrustProxy,
  requestId: string,
): RequestContext {
  const xff = firstHeader(source.headers["x-forwarded-for"]);
  const xfp = firstHeader(source.headers["x-forwarded-proto"]);

  // `exactOptionalPropertyTypes`: carry each forwarding header only when present,
  // never as present-and-`undefined`, so `resolveClient` sees a clean shape.
  const forwarded: ForwardHeaders = {
    ...(xff !== undefined && { "x-forwarded-for": xff }),
    ...(xfp !== undefined && { "x-forwarded-proto": xfp }),
  };

  const client = resolveClient(trustProxy, source.socket?.remoteAddress, forwarded);

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
 * A per-request `AbortSignal` that fires if the client hangs up before the
 * response finished.
 *
 * `close` fires on *every* response end, so it cannot mean "disconnect" on its
 * own; `writableFinished` is the discriminator — `true` is a clean completion we
 * leave alone, `false` is the client gone while we were still writing, which
 * aborts the signal with a coded reason. Long-running or streaming work reads
 * this off the request context to cancel rather than render into a dead socket.
 * It only ever aborts — a finished response simply never fires it — so it adds no
 * teardown the caller must remember.
 */
export function requestAbortSignal(res: AbortableResponse): AbortSignal {
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

  return aborter.signal;
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
  // Establish the per-request context up front and run the whole request inside
  // it. `runWithContext` uses `AsyncLocalStorage.run`, so everything the handler
  // does — through every `await` — sees this exact context, and nothing leaks
  // into the next request: the context is torn down when this call settles. The
  // id and resolved client identity are decided here, before the app runs, so a
  // middleware (rate-limit) and the access log both read the same values.
  const requestId = deps.newRequestId();

  const context = establishContext(req, deps.trustProxy, requestId);

  // Publish a per-request abort signal on the context: it fires if the client
  // hangs up before the response finished, so a streaming render or a long
  // handler can stop rather than work for a response no one will read.
  context.signal = requestAbortSignal(res);

  return runWithContext(context, async () => {
    const start = deps.now();

    // The request's span opens with the work and closes beside the access line,
    // so trace timing and the logged latency describe the same window.
    const span = deps.tracer?.startSpan("http.request");

    let method = "GET";
    let path = "/";
    let status = 500;

    try {
      const body = await readBody(req, deps.maxBodyBytes);

      const line = requestLineOf(req);
      method = line.method;

      const request = toKeelRequest({
        method: line.method,
        url: line.url,
        headers: req.headers,
        body,
      });
      path = request.path;

      const probe =
        deps.health === undefined
          ? undefined
          : await healthResponse(request.method, request.path, deps.health);

      const response =
        probe ??
        (await withTimeout(
          app.handle(request.method, request.path, {
            query: request.query,
            headers: request.headers,
            body: request.body,
          }),
          deps.handlerTimeoutMs,
        ));

      // Attach an ETag to a cacheable HTML response, then harden it. Security
      // headers go on last so they cover the 304 path too — a Not-Modified
      // response is hardened exactly like the full one it stands in for.
      const tagged = withEtag(response, deps.etag);

      const hardened = withSecurityHeaders(tagged.response, deps.securityHeaders);

      // A conditional GET whose validator still matches gets a bodiless 304: the
      // client already holds these bytes. We echo the same headers (ETag and all)
      // and send nothing on the wire.
      if (tagged.etag !== undefined && etagMatches(ifNoneMatch(req.headers), tagged.etag)) {
        status = 304;

        respondNotModified(res as NotModifiedResponse, hardened.headers);
      } else {
        status = hardened.status;

        applyResponse(res, hardened);
      }
    } catch (error) {
      status = statusForError(error);

      // A 500 is ours to explain in the log; client errors (4xx) are not.
      if (status === 500) {
        deps.logError("unhandled error serving request", error);
      }

      respondWithError(res, status, deps.securityHeaders);
    } finally {
      // The request id rides on the access line too, so a log and any
      // context-tagged work the handler emitted share one correlation id.
      deps.logRequest({ method, path, status, ms: deps.now() - start, requestId });

      if (span !== undefined) {
        span.setAttribute("http.method", method);
        span.setAttribute("http.path", path);
        span.setAttribute("http.status_code", status);
        span.setAttribute("keel.request_id", requestId);
        // A 5xx is the server's failure; everything else (4xx included) is a
        // request the server answered as designed.
        span.setStatus(status >= 500 ? "error" : "ok");
        span.end();
      }
    }
  });
}

/** The slice of a response the error path needs — narrow, so a test can fake it. */
export interface ErrorResponse {
  readonly headersSent: boolean;

  writeHead(status: number, headers: Record<string, string>): void;

  end(body?: string): void;
}

/**
 * Answer a failed request with a safe, generic body.
 *
 * Best-effort: if the headers already went out (a handler that wrote then
 * threw) we cannot send a fresh status, so we just end the socket — the
 * invariant we protect is that the socket never hangs open, not that every
 * failure becomes a clean status line. Default response headers are merged in
 * so an error response is hardened like any other.
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
): void {
  if (!res.headersSent) {
    const body = bodyForStatus(status);

    const hardened = withSecurityHeaders(
      { status, headers: { "content-type": "text/plain; charset=utf-8" }, body },
      securityHeaders,
    );

    res.writeHead(hardened.status, hardened.headers);

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

/** The default access log: one line per request, method · path · status · latency · id. */
function defaultLogRequest(entry: AccessEntry): void {
  console.log(`${entry.method} ${entry.path} ${entry.status} ${entry.ms}ms ${entry.requestId}`);
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

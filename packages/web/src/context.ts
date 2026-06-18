/**
 * The per-request context: a value that follows a request through the whole
 * call tree without being prop-drilled.
 *
 * Backed by `node:async_hooks` `AsyncLocalStorage`, a cross-runtime primitive
 * (node, bun, and workers all ship it) that belongs in this transport-free core
 * so BOTH ends can reach it without a circular dependency: the transport tier
 * (`@volo/runtime`, which already depends on `@volo/web`) *establishes* a fresh
 * context per request, and a controller or any app code *reads* it — neither
 * importing the other.
 *
 * The invariant that earns the whole module its keep: a context is strictly
 * per-request. Each request runs its handler inside {@link runWithContext},
 * which uses `AsyncLocalStorage.run` — so the store is scoped to that async
 * execution and is torn down when it ends. A value set for request A can never
 * be observed by request B, even in a long-lived worker handling thousands of
 * requests on the same event loop. This is the precise hazard ALS exists to
 * defeat (the cross-request state leak the PHP/Octane world spent years
 * learning to contain); Node inherits the win for free, and this module makes
 * it the framework default.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The slice of a tracing span the request context publishes — just what a seam
 * needs to parent a child span on the in-flight request and to read its trace
 * ids. Structurally satisfied by `@volo/observability`'s `Span`, so this
 * transport-free core stays dependency-free.
 */
export interface RequestContextSpan {
  readonly data: { readonly traceId: string; readonly spanId: string };

  setAttribute(key: string, value: unknown): unknown;

  setStatus(status: "ok" | "error"): unknown;

  end(): void;
}

/**
 * What every request carries, plus room to grow.
 *
 * `requestId` is always present — the transport mints one per request so every
 * log line and downstream call can be stitched into one trace. `ip` and
 * `protocol` are the trust-proxy-resolved client identity (see `@volo/runtime`):
 * present once the transport has decided whom to believe, absent in a bare
 * `runWithContext` call (a test, a background task) that never set them.
 *
 * The index signature is the extension seam: later tiers stash a user, a
 * tenant, a request-scoped memo cache here under their own keys without this
 * type having to enumerate them. It is the open shape a context wants to be —
 * a typed core plus an open bag — rather than a closed record that every
 * feature must edit.
 */
export interface RequestContext {
  /** A unique id for this request, for tracing and log correlation. */
  requestId: string;

  /** The resolved client IP, once the transport has decided whom to trust. */
  ip?: string;

  /** The resolved request protocol (`"http"` / `"https"`), trust-proxy-aware. */
  protocol?: string;

  /**
   * Fires when the request is abandoned — the client disconnected, or the
   * transport tore the socket down. Long-running or streaming work (an SSR
   * stream, a slow handler, an upstream fetch) reads this to cancel rather than
   * burn CPU and hold resources for a response no one will receive. The
   * transport publishes it per request; absent in a bare `runWithContext` call
   * (a test, a background task) that never wired one.
   */
  signal?: AbortSignal;

  /**
   * The request's root tracing span, published by the transport when a tracer is
   * wired. A seam fired DURING the request (a `@volo/db` query, a `@volo/queue`
   * job drained inline) parents its child span on this, so a query/job shows up
   * under the request that caused it — and the span's `data.traceId`/`data.spanId`
   * are the ids an outbound `traceparent` continues. Absent when no tracer is
   * configured (the zero-overhead default) or outside a served request.
   *
   * Typed structurally — just the slice a consumer reads — so this transport-free
   * core takes no dependency on `@volo/observability`; the runtime publishes a
   * value the tracing package's `Span` satisfies.
   */
  span?: RequestContextSpan;

  /** Room to grow: a user, a tenant, a request-scoped cache — keyed by feature. */
  [key: string]: unknown;
}

/**
 * The one storage instance for the whole process.
 *
 * Module-private on purpose: callers go through {@link runWithContext} and
 * {@link currentContext}, never touch the store directly. One instance is
 * correct — `AsyncLocalStorage` keys its value to the *async execution*, not to
 * the instance, so a single store cleanly isolates every concurrent request.
 */
const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Run `fn` with `context` as the active request context.
 *
 * Everything `fn` does — synchronously, or across any `await` it performs —
 * sees this exact context through {@link currentContext}, and nothing outside
 * this call can. When `fn` settles, the context is gone: it does not bleed into
 * the next thing the event loop runs. This is the single chokepoint the
 * transport wraps each request in.
 */
export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

/**
 * The context for the request currently in flight, or `undefined` outside one.
 *
 * A controller reads `currentContext()?.requestId` to tag its work; a helper
 * deep in the call tree reads the same without any argument having threaded it
 * down. `undefined` is the honest answer when there is no request — code run at
 * startup, in a test, or in a background task that never opened a context — so
 * callers handle "no request" explicitly rather than crash.
 */
export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * The tracing span for the request currently in flight, or `undefined` outside
 * one (or when no tracer is wired).
 *
 * The shared seam the observability wiring reads: a battery's `on*` hook (a
 * `@volo/db` query, a `@volo/queue` job drained inline, a `@volo/identity` event)
 * parents its child span on this, so the work shows up under the request that
 * caused it. Both the CLI's `serve`/`dev` wiring and an app's bespoke wiring
 * (estate) pass this as the tracer's `currentSpan` — one definition, so they can
 * never read the context's span differently. `undefined` is the honest answer
 * outside a request, so the hook roots a standalone span rather than crashing.
 */
export function currentRequestSpan(): RequestContextSpan | undefined {
  return storage.getStore()?.span;
}

/**
 * The rate-limit middleware adapter — wires the {@link RateLimiter} into the
 * request pipeline, keyed by the client identity the request context carries.
 *
 * The token-bucket decision stays in `RateLimiter`, untouched. This adapter is
 * the plumbing: pick the key for *this* requester, ask the limiter, and either
 * let the request through or answer `429 Too Many Requests` with a `Retry-After`
 * the limiter computed. The key derivation (`keyFor`) is handed the request, so
 * a caller can bucket by an API-key header, a user, or a route param straight
 * from the request — no detour through the ambient context. By default the key
 * is the client IP, which is why trust-proxy matters: behind a proxy every
 * request shares the proxy's socket address, so without the context's resolved
 * `ip` the whole fleet would share one bucket.
 */

import { currentContext } from "@lesto/web";
import type { LestoRequest, Middleware } from "@lesto/web";

import { RateLimiter } from "./limiter";

const TOO_MANY_REQUESTS = 429;
const MS_PER_SECOND = 1000;

/**
 * The bucket key for a dispatch whose client IP we cannot key on — both the
 * in-request "IP unresolved" case and the out-of-request "no client to key on"
 * case (a build prerender, a batch task, a test that calls `app.handle` outside
 * a transport). One shared bucket rather than no gate: a missing IP must
 * *tighten* the gate (a single global ceiling), never open it. The two cases
 * differ only in observability — the in-request one trips
 * {@link RateLimitOptions.onUnknownClient} (it is a misconfig); the out-of-
 * request one is silent (there is no client to key on by design).
 */
export const UNKNOWN_CLIENT_KEY = "ratelimit:unknown-client";

/** The error code logs and tests branch on when the in-request fallback is hit. */
export const RATELIMIT_UNKNOWN_CLIENT_CODE = "RATELIMIT_UNKNOWN_CLIENT";

/** The coded `kind` the {@link RateLimitOptions.onDenied} seam reports a throttle under. */
export const RATELIMIT_DENIED_KIND = "ratelimit_exceeded";

/** What `rateLimit` needs to stand up a limiter, plus how to key a request. */
export interface RateLimitOptions {
  /** The bucket ceiling — the most requests a client may burst before throttling. */
  readonly capacity: number;

  /** How fast a client's bucket refills, in requests per second. */
  readonly refillPerSecond: number;

  /**
   * A pre-built limiter to use instead of constructing one from `capacity` /
   * `refillPerSecond`. The seam that lets a test inject a deterministic clock
   * and a shared store, and lets an app point many middleware at one limiter.
   */
  readonly limiter?: RateLimiter;

  /**
   * How a request maps to a bucket key. Receives the {@link LestoRequest} so the
   * key can come straight from the request — an `Authorization`/API-key header, a
   * route param, a body field, or a composite — *without* reaching through the
   * ambient {@link currentContext}. Defaults to the client IP from the request
   * context (see {@link UNKNOWN_CLIENT_KEY} when it is absent); the default
   * ignores its argument because the context, not the request shape, carries the
   * resolved IP.
   */
  readonly keyFor?: (request: LestoRequest) => string;

  /**
   * Called the first time the *default* key derivation runs inside a request
   * context that does not carry a resolved client IP, and so falls back to the
   * single shared {@link UNKNOWN_CLIENT_KEY} bucket. Fires only for *in-request*
   * misconfig — an out-of-request dispatch (a build prerender, a batch task, a
   * test that calls `app.handle` outside a transport) takes the same fallback
   * key silently, because there is no client to key on by design.
   *
   * WHY this seam exists: the fallback is a *silent* degradation. It is correct
   * on a node server with trust-proxy off (a missing IP tightens the gate), but
   * a real hazard when a transport establishes a per-request context yet leaves
   * `ip` unresolved — every request shares the one global bucket: per-client
   * limiting is gone (a bypass) and any one client can 429 the whole fleet (a
   * DoS amplifier). Making the fallback observable lets an operator detect the
   * misconfiguration instead of discovering it in production. It fires once per
   * middleware (not per request), so a steady stream of unresolved requests is
   * not a log flood. Defaults to a `console.warn`; inject to route it to a real
   * logger, or pass a no-op to silence it. A custom {@link keyFor} bypasses
   * this entirely — an explicit key is the operator's own choice, not an
   * unresolved fallback.
   */
  readonly onUnknownClient?: () => void;

  /**
   * Optional observability hook fired the moment a request is throttled — the
   * uniform `onDenied(kind, c)` seam shared across `@lesto/csrf`, `@lesto/authz`,
   * and `@lesto/ratelimit` (owned by auth-security item 6, consumed by OTLP wiring
   * in operability-dx item 3).
   *
   * `kind` is the coded reason (here always {@link RATELIMIT_DENIED_KIND}); `c` is
   * the throttled {@link LestoRequest}. Purely observational: it shapes nothing —
   * the `429` (and its `Retry-After`) is identical whether or not a hook is wired
   * — so firing is safe on the deny path. Distinct from {@link onUnknownClient},
   * which warns about a *misconfiguration* (no resolvable client IP); this fires on
   * an ordinary, correct throttle. A returned promise is awaited so an async sink
   * is not dropped mid-write.
   */
  readonly onDenied?: (kind: string, c: LestoRequest) => void | Promise<void>;

  /**
   * Routed into the limiter's auto-constructed {@link MemoryRateLimitStore} as its
   * saturation signal — fired once when the per-client store's hard cap starts
   * shedding throttled buckets under a distinct-IP flood (see
   * {@link MemoryRateLimitStoreOptions.onSaturated}). Distinct from
   * {@link onDenied}, which fires on every ordinary throttle: this fires only when
   * the store's *memory* bound engages — an attack signal, not a routine 429.
   * Ignored when a pre-built {@link limiter} is supplied (it owns its store).
   * Defaults, via the store, to a `console.warn` with a stable code.
   */
  readonly onSaturated?: () => void;
}

/**
 * The default warning for the in-request unresolved-client fallback: one
 * `console.warn`, carrying the stable {@link RATELIMIT_UNKNOWN_CLIENT_CODE} so
 * logs and ops tooling branch on the code, never the prose.
 */
function warnUnknownClient(): void {
  console.warn(
    `[${RATELIMIT_UNKNOWN_CLIENT_CODE}] rateLimit ran inside a request context that ` +
      `carries no resolved client IP, and is keying every such request to a single shared ` +
      `bucket. This breaks per-client limiting. Enable trust-proxy on the node server, have ` +
      `the transport set context.ip, or pass a custom keyFor that pulls the client identity ` +
      `from the request.`,
  );
}

/**
 * Build the default key derivation: the context's resolved client IP, or the
 * shared fallback.
 *
 * Two fallback cases, deliberately distinguished:
 *
 *   - **No request context at all** (`currentContext()` is undefined) — an
 *     out-of-request dispatch: a build prerender (`buildStaticSites` calls
 *     `app.handle` directly), a batch task, a test. There is no client to key
 *     on by design; fall back to {@link UNKNOWN_CLIENT_KEY} *silently*.
 *   - **Context present but `ip` undefined** — an in-request dispatch whose
 *     transport did not resolve a client identity (trust-proxy off behind a
 *     proxy, a hand-rolled transport that forgot to set `ip`). That is the
 *     misconfig the warn-once seam is for; trip {@link onUnknownClient}.
 *
 * Warn-once is kept here, in the closure, so each middleware tracks its own
 * "already warned" latch.
 *
 * It takes the {@link LestoRequest} to match the public `keyFor` signature, but
 * ignores it: the resolved client IP rides the ambient context, not the request
 * shape. A caller who wants to key off the request supplies their own `keyFor`.
 */
function defaultKeyFor(onUnknownClient: () => void): (request: LestoRequest) => string {
  let warned = false;

  return () => {
    const context = currentContext();

    if (context?.ip !== undefined) return context.ip;

    if (context !== undefined && !warned) {
      warned = true;
      onUnknownClient();
    }

    return UNKNOWN_CLIENT_KEY;
  };
}

/**
 * A rate-limit middleware over a token bucket per client.
 *
 * On each request it derives the client key — the context IP by default, or
 * whatever {@link RateLimitOptions.keyFor} pulls from the request — spends a
 * token, and:
 *
 *   - allows the request through when the bucket had one to spend; or
 *   - short-circuits with `429 Too Many Requests` when it did not, attaching a
 *     `Retry-After` header (whole seconds, rounded up from the limiter's
 *     `retryAfterMs`) so a well-behaved client knows when to come back.
 *
 * The limiter is built once, when the middleware is created, so its store (and
 * thus every client's accrued state) lives for the life of the process — the
 * bucket is meaningless if it resets per request.
 */
export function rateLimit(options: RateLimitOptions): Middleware {
  // Default to an in-process memory store: correct for a single node and for
  // tests. A fleet that must share limits injects a `limiter` over a SQL/Redis
  // store. Either way the limiter is built once, so its buckets outlive a single
  // request (the whole point of a bucket).
  //
  // We let the RateLimiter construct the store: it builds a MemoryRateLimitStore
  // at this middleware's own capacity and refill rate, which (L-976b4302) is
  // bounded by a hard `maxBuckets` cap and, over budget, evicts the bucket closest
  // to full first. That matters most HERE: this per-IP store is keyed by the client
  // IP, so a flood of distinct (or spoofed) IPs would otherwise grow it without
  // bound. Eviction-on-refill alone cannot bound it — the middleware spends cost 1
  // on every request, so an IP's bucket is stored below the ceiling and only
  // refills back to full while idle — but the hard cap does, and closest-to-full
  // order means a targeted IP actively being throttled is the LAST thing evicted.
  // Handing the limiter a store ourselves would only risk the capacity/rate drift
  // it now guards against; we thread `onSaturated` through instead so an operator
  // can observe (or route/silence) the per-IP store shedding buckets under a flood.
  const limiter =
    options.limiter ??
    new RateLimiter({
      capacity: options.capacity,
      refillPerSecond: options.refillPerSecond,
      // Only when given — an unwired caller falls through to the store's loud
      // default (conditional spread per `exactOptionalPropertyTypes`).
      ...(options.onSaturated ? { onSaturated: options.onSaturated } : {}),
    });

  // A custom keyFor is an explicit operator choice — no fallback, no warning.
  // Otherwise derive from the context IP, surfacing the shared-bucket fallback
  // through the (injectable, warn-once) onUnknownClient seam.
  const keyFor = options.keyFor ?? defaultKeyFor(options.onUnknownClient ?? warnUnknownClient);

  return async (request, next) => {
    const result = await limiter.check(keyFor(request));

    if (result.allowed) {
      return next();
    }

    // Announce the throttle before answering — observation only, never a bypass:
    // the `429` is returned regardless of whether (or how) the hook resolves.
    if (options.onDenied !== undefined) {
      await options.onDenied(RATELIMIT_DENIED_KIND, request);
    }

    // Denied: answer 429 ourselves, never reaching a controller. `Retry-After`
    // is whole seconds (the HTTP unit), rounded up so we never tell a client to
    // retry before the deficit has actually refilled.
    const retryAfterSeconds = Math.ceil(result.retryAfterMs / MS_PER_SECOND);

    return {
      status: TOO_MANY_REQUESTS,
      headers: { "content-type": "text/plain", "Retry-After": String(retryAfterSeconds) },
      body: "Too Many Requests",
    };
  };
}

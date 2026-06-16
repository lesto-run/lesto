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

import { currentContext } from "@keel/web";
import type { KeelRequest, Middleware } from "@keel/web";

import { RateLimiter } from "./limiter";
import { MemoryRateLimitStore } from "./store";

const TOO_MANY_REQUESTS = 429;
const MS_PER_SECOND = 1000;

/**
 * The bucket key for a request whose client IP the context could not resolve.
 *
 * Outside a request, or with trust-proxy off and no socket address threaded
 * through, there is no per-client identity to key on. We fall back to one shared
 * bucket rather than skip the limit: a missing IP must *tighten* the gate (a
 * single global ceiling), never open it. A WHY a deployment behind a proxy
 * should enable trust-proxy so each client gets its own bucket.
 */
export const UNKNOWN_CLIENT_KEY = "ratelimit:unknown-client";

/** The error code logs and tests branch on when the shared fallback bucket is hit. */
export const RATELIMIT_UNKNOWN_CLIENT_CODE = "RATELIMIT_UNKNOWN_CLIENT";

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
   * How a request maps to a bucket key. Receives the {@link KeelRequest} so the
   * key can come straight from the request — an `Authorization`/API-key header, a
   * route param, a body field, or a composite — *without* reaching through the
   * ambient {@link currentContext}. Defaults to the client IP from the request
   * context (see {@link UNKNOWN_CLIENT_KEY} when it is absent); the default
   * ignores its argument because the context, not the request shape, carries the
   * resolved IP.
   */
  readonly keyFor?: (request: KeelRequest) => string;

  /**
   * Called the first time the *default* key derivation cannot resolve a client
   * IP and falls back to the single shared {@link UNKNOWN_CLIENT_KEY} bucket.
   *
   * WHY this seam exists: the fallback is a *silent* degradation. It is correct
   * on a node server with trust-proxy off (a missing IP tightens the gate), but
   * a real hazard when this middleware runs somewhere no request context is ever
   * established — e.g. an edge handler that dispatches without `runWithContext`.
   * There, *every* request shares the one global bucket: per-client limiting is
   * gone (a bypass) and any one client can 429 the whole fleet (a DoS amplifier).
   * Making the fallback observable lets an operator detect the misconfiguration
   * instead of discovering it in production. It fires once per middleware (not
   * per request) so a legitimately context-less deployment is not flooded with
   * logs. Defaults to a `console.warn`; inject to route it to a real logger, or
   * pass a no-op to silence it. A custom {@link keyFor} bypasses this entirely —
   * an explicit key is the operator's own choice, not an unresolved fallback.
   */
  readonly onUnknownClient?: () => void;
}

/**
 * The default warning for the unresolved-client fallback: one `console.warn`,
 * carrying the stable {@link RATELIMIT_UNKNOWN_CLIENT_CODE} so logs and ops
 * tooling branch on the code, never the prose.
 */
function warnUnknownClient(): void {
  console.warn(
    `[${RATELIMIT_UNKNOWN_CLIENT_CODE}] rateLimit could not resolve a client IP and is ` +
      `keying every request to a single shared bucket. This breaks per-client limiting. ` +
      `Ensure a request context is established (e.g. enable trust-proxy on the node server) ` +
      `or pass a custom keyFor. Common cause: mounting rateLimit on a deploy target that ` +
      `dispatches without runWithContext.`,
  );
}

/**
 * Build the default key derivation: the context's resolved client IP, or the
 * shared fallback — invoking `onUnknownClient` the first time it falls back so
 * the silent degradation is observable. Warn-once is kept here, in the closure,
 * so each middleware tracks its own "already warned" latch.
 *
 * It takes the {@link KeelRequest} to match the public `keyFor` signature, but
 * ignores it: the resolved client IP rides the ambient context, not the request
 * shape. A caller who wants to key off the request supplies their own `keyFor`.
 */
function defaultKeyFor(onUnknownClient: () => void): (request: KeelRequest) => string {
  let warned = false;

  return () => {
    const ip = currentContext()?.ip;

    if (ip !== undefined) return ip;

    if (!warned) {
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
  const limiter =
    options.limiter ??
    new RateLimiter({
      store: new MemoryRateLimitStore(),
      capacity: options.capacity,
      refillPerSecond: options.refillPerSecond,
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

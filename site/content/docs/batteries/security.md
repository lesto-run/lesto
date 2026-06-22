---
title: "Security"
description: "The secure stack — per-client rate limiting, CSRF / origin-check, and CORS — three fail-closed batteries you turn on with one `secure` field on `createApp`."
section: Batteries
order: 22
---

# Security

The secure stack is three small batteries that share one shape: each is plain
Lesto middleware that reads the request and either answers or delegates, and each
fails closed. `@lesto/ratelimit` caps how often a client may call you,
`@lesto/csrf` proves a state-changing request came from your own pages, and
`@lesto/cors` decides which foreign origins a browser may read your responses
from.

You rarely wire them by hand. `@lesto/kernel` bundles all three into a single
ordered pipeline — `secureStack` — and `createApp` builds it for you from one
`secure` field, in the fixed safe order (`cors` → `rateLimit` → `originCheck` →
`csrf`, outermost first). A `createApp` app is rate-limited by default; the CSRF
and CORS layers are deliberately opt-in (a forced origin/token check would 403
legitimate non-browser API clients), so each is one field away:

```ts
import { createApp } from "@lesto/kernel";

const app = await createApp({
  app, // your composed lesto() app
  db,
  migrations,
  secure: {
    cors: { origin: ["https://app.example.com"], credentials: true, maxAge: 600 },
    rateLimit: { capacity: 100, refillPerSecond: 50 },
    browser: true, // shorthand: turn on the recommended origin-check defense
  },
});
```

`secure` is layered *over* a rate-limit baseline (`{ capacity: 100,
refillPerSecond: 50 }`, exported as `KERNEL_DEFAULT_RATE_LIMIT`): a spelled
`rateLimit` retunes it, while `cors`/`originCheck`/`csrf` add to it — so turning
on a CSRF check never silently turns off the DoS net. `secure: false` opts out
entirely (for an app composing its own stack). The rest of this page describes
each battery's options, which are the same shape whether you pass them through
`secure` or call the package factory directly.

## Rate limit per client

`@lesto/ratelimit` is a token-bucket limiter. The middleware builds the limiter
once — so a client's accrued state outlives a single request — derives a bucket
key per request, spends a token, and answers `429 Too Many Requests` with a
`Retry-After` (whole seconds, rounded up) when the bucket is empty:

```ts
import { RATELIMIT_DENIED_KIND } from "@lesto/ratelimit";

const app = await createApp({
  app,
  db,
  migrations,
  secure: {
    rateLimit: {
      capacity: 20, // the burst ceiling
      refillPerSecond: 5, // how fast the bucket refills
      onDenied: (kind, c) => trace.event(kind, { path: c.path }), // kind === RATELIMIT_DENIED_KIND
    },
  },
});
```

By default the bucket key is the client IP the request context carries. That
makes trust-proxy matter: behind a proxy every request shares the proxy's socket
address, so if the transport leaves the context's `ip` unresolved, the limiter
falls back to one shared `UNKNOWN_CLIENT_KEY` bucket — the fallback *tightens* the
gate (a single global ceiling) rather than opening it. That fallback is
observable: it fires `onUnknownClient` once per middleware (default
`console.warn` carrying `RATELIMIT_UNKNOWN_CLIENT_CODE`) so a misconfig is loud.
To bucket by something other than IP — an API key, a user, a route param — pass
`keyFor`, which receives the `LestoRequest`:

```ts
import { rateLimit } from "@lesto/ratelimit";

rateLimit({
  capacity: 100,
  refillPerSecond: 10,
  keyFor: (req) => req.headers["x-api-key"] ?? "anon",
});
```

A custom `keyFor` is an explicit choice, so it never triggers the unknown-client
warning. The package exports `rateLimit` (the middleware) and the lower-level
`RateLimiter` class directly; the kernel's `secure.rateLimit` accepts the same
`RateLimitOptions`.

### Sharing limits across a fleet

The default store is `MemoryRateLimitStore` — per-process, resets on restart,
correct for a single node. Inside `createApp`, passing a `db` automatically wires
the rate-limit slot over the fleet-correct `sqlRateLimitStore` instead; in
production with no `db` the stack warns once (`KERNEL_MEMORY_STORES_CODE`) that
limits are unshared. To build the shared store yourself, construct a
`RateLimiter` over `sqlRateLimitStore` and inject it as `limiter`. The store
keeps each bucket in one row and does the whole check inside a transaction (a
locked read on Postgres), so the math never races:

```ts
import { RateLimiter, sqlRateLimitStore, installRateLimitSchema } from "@lesto/ratelimit";

await installRateLimitSchema(db); // idempotent: CREATE TABLE/INDEX IF NOT EXISTS
const limiter = new RateLimiter({
  store: sqlRateLimitStore(db, { dialect: "postgres" }),
  capacity: 20,
  refillPerSecond: 5,
});

// hand it to the kernel:
//   secure: { rateLimit: { limiter, capacity: 20, refillPerSecond: 5 } }
// or to the bare middleware: rateLimit({ limiter, capacity: 20, refillPerSecond: 5 })
```

The SQL store also exposes `sweep(before)` to delete fully-refilled rows; the
caller owns the cadence — the framework starts no timer. (`createApp({ db })`
installs the rate-limit schema for you via its durable-store setup, so the manual
`installRateLimitSchema` above is only for the hand-wired path.) See
[Data](/batteries/data) for the database itself and [Env](/batteries/env) for
holding the connection config.

## CSRF: prove the request came from your pages

`@lesto/csrf` ships two defenses for the same problem and is **opt-in always** —
enforcement runs only because you turned it on. Start with `originCheck`, the
zero-plumbing default (`secure: { browser: true }` is the kernel shorthand for
it). It reads two headers the browser sets and a page cannot forge —
`Sec-Fetch-Site` (Fetch Metadata) first, then `Origin` against an explicit
allow-list — and guards `POST`/`PUT`/`PATCH`/`DELETE`. It never reads
`Content-Type`, so it is immune to the content-type-parsing bypass class:

```ts
secure: {
  originCheck: { allowedOrigins: ["https://app.example.com"], strict: true },
}
```

A cross-site initiator, an un-allow-listed `Origin`, or no evidence at all is a
`403 Forbidden`. By default `same-site` (a sibling subdomain) is trusted;
`strict: true` narrows that to exactly your origin. A request carrying neither
header is a non-browser client (curl, server-to-server) — refused unless you set
`allowNoOrigin: true` for a token-authed API where CSRF does not apply. A strict
refusal reports its own coded `kind` (`ORIGIN_STRICT_DENIED_KIND`) distinct from
the default (`ORIGIN_DENIED_KIND`).

When you need the stronger, session-bound guard, add the double-submit token.
`csrfToken` mints a token bound to the session by HMAC and returns the companion
`Set-Cookie` to plant it; the `csrf` middleware verifies the resubmitted token
(the `x-csrf-token` header or a `_csrf` form field, via `defaultExtractToken`)
with `verifyToken`:

```ts
import { csrfToken } from "@lesto/csrf";

// On a page render: issue the pair.
const { token, cookie } = csrfToken(sessionId, secret); // secret >= 32 bytes
// set `cookie` as a Set-Cookie; surface `token` to the page to resubmit.

// On the API: enforce it.
//   secure: { csrf: { secret, sessionFor: (req) => sessionId(req) } }
```

The companion cookie is deliberately readable by JavaScript (no `HttpOnly`) —
the page must read it back to resubmit — but it is not a credential: it authorizes
nothing and is bound to the session, so a token read on one origin is useless
against another. A weak `secret` (under 32 bytes) is refused loud with
`CsrfError` code `CSRF_WEAK_SECRET` when the middleware is built. Pair this with
[Auth](/batteries/auth), which establishes who the session belongs to.

## CORS: who may read your responses

`@lesto/cors` computes the `Access-Control-*` headers a foreign origin earns. The
`cors` middleware answers a real preflight (`OPTIONS` carrying
`Access-Control-Request-Method`) with a bodiless `204`, and folds the policy
headers *under* every other response so a controller's own header wins a clash:

```ts
secure: {
  cors: { origin: ["https://app.example.com"], credentials: true, maxAge: 600 },
}
```

The decision lives in the pure `corsHeaders(requestOrigin, options)` function if
you want it without the middleware:

```ts
import { corsHeaders } from "@lesto/cors";

const headers = corsHeaders(req.headers.origin, {
  origin: ["https://app.example.com"],
  credentials: true,
});
```

A non-wildcard policy echoes the request origin only when it is a member of the
allow-list and adds `Vary: Origin` on both the allow and deny paths, so a shared
cache can never replay one origin's CORS response to another. The default
`origin: "*"` allows any origin; pairing `"*"` with `credentials: true` throws
`CorsError` code `CORS_WILDCARD_WITH_CREDENTIALS` — a credentialed wildcard would
let any site read authenticated responses, so it fails at config time.

## Notes and gotchas

- **The order is fixed for you.** `secureStack` (built by `createApp`'s `secure`
  field) composes the middleware in the safe `cors` → `rateLimit` →
  `originCheck` → `csrf` order, outermost-first — you do not order them by hand.
  A preflight is answered by `cors` and never reaches the rest. To mount one
  battery on a bare `lesto()` chain instead, wrap it with `fromRequestMiddleware`
  from `@lesto/web` (the factories return a request-shaped `Middleware`, not a
  context handler).
- **A missing IP tightens, never opens.** With no resolved client IP, the
  limiter routes every request to one shared bucket — per-client limiting is gone
  but the gate still holds. Watch for the `RATELIMIT_UNKNOWN_CLIENT_CODE` warning
  and enable trust-proxy or pass `keyFor`.
- **`originCheck` and `csrf` are complementary, not redundant.** `originCheck`
  needs no client plumbing and covers cookie-authed browsers; `csrf` adds a
  session-bound token. Run `originCheck` everywhere (`secure: { browser: true }`);
  add `csrf` where you have threaded tokens through.
- **`verifyToken` is total; `csrf`/`csrfToken` are not.** `verifyToken` returns a
  boolean for every input and never throws (a malformed token is just `false`),
  but minting or building the middleware asserts the secret strength and throws
  on a weak one (`CSRF_WEAK_SECRET`, minimum 32 bytes). Keep the secret in
  [Env](/batteries/env), not in source.
- **The memory store is per-process.** `MemoryRateLimitStore` resets on restart
  and is not shared across instances. Pass `db` to `createApp` (or inject a
  `RateLimiter` over `sqlRateLimitStore`) when a limit must hold across a fleet.
- **`credentials: true` forbids the wildcard.** Name your origins explicitly to
  send `Access-Control-Allow-Credentials`; the wildcard combination throws
  `CORS_WILDCARD_WITH_CREDENTIALS` at config time, not a silent reflect.
- **Every refusal carries a coded `kind`.** `rateLimit`, `csrf`, and `originCheck`
  share the `onDenied(kind, c)` seam, so an audit sink branches on the code
  (`RATELIMIT_DENIED_KIND`, `CSRF_DENIED_KIND`, `ORIGIN_DENIED_KIND`,
  `ORIGIN_STRICT_DENIED_KIND`), never on prose. Wire it to
  [Observability](/batteries/observability).

For how middleware, `.use`, and the request `Context` work, see
[Routing & pages](/guides/routing); for declaring the inputs these batteries
need, see [Validation](/guides/validation).

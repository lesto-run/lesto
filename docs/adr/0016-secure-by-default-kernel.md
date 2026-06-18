# ADR 0016 — Secure-by-default kernel: a rate-limit baseline, CSRF/CORS opt-in

- **Status:** Accepted
- **Date:** 2026-06-16

## Context

Volo's security batteries (`@volo/cors`, `@volo/ratelimit`, `@volo/csrf`) were
real and well-tested, but `createApp` injected **none** of them — security was
purely app-composed via `.use(...secureStack(...).map(fromRequestMiddleware))`. An
app that forgot that line shipped with **zero** CSRF, CORS, *and* rate-limiting
(the readiness review's "secure defaults are opt-in, not enforced" + "no rate
limiting by default" blockers). The pit-of-success principle (ADR 0011) says the
forgetful app should be safe, not exposed.

The obvious move — default the whole `secureStack` on — is **wrong**, and the
research said so concretely (read `Sec-Fetch-Site` / token semantics in
`@volo/csrf`):

- **`csrf()` (token)** rejects every state-changing request without a valid
  session-bound token — it would 403 every token-less API client and even a
  same-origin form with no token plumbing. Cannot be default-on.
- **`originCheck()`** rejects a request with no `Sec-Fetch-Site` *and* no `Origin`
  (the shape `curl`/server-to-server/JSON-RPC send) unless `allowNoOrigin: true`.
  Default-on would 403 legitimate non-browser clients and break the integration
  journeys + admin example. Its safe policy is deployment-specific.
- **`cors()`** never blocks server-side (the browser does); same-origin is already
  the secure posture *without* a CORS layer, and the default origin is `*` — so
  default-on CORS would *advertise* open cross-origin, the opposite of secure.
- **`rateLimit()`** is the one battery that is both safe-to-default and a real win:
  on an allowed request it only calls `next()` (no response-header changes), it
  needs no DB (memory fallback) but uses the kernel's SQL store when present, and
  with a generous capacity it never trips legitimate use. It keys per-client IP off
  the ambient request context, which the transport establishes (`runWithContext`)
  *around* the kernel `handle()` — so it keys correctly even injected at that
  boundary.

So the framework's existing tiering (CORS/rate-limit "safe for everyone"; both CSRF
checks opt-in) is largely correct; the real gap is that rate-limit wasn't actually
*on*, and the secure baseline wasn't discoverable.

## Decision

`VoloAppConfig` gains `secure?: SecureStackOptions | false`, and `createApp` wraps
every dispatch in the resolved stack via `runPipeline` at the `handle()` boundary
(order-immune; covers built-ins and 404s; reads the same ALS context the
transport set, so per-IP rate-limit keying is correct):

- **Omitted (the default)** — per-client **rate-limiting ON**
  (`KERNEL_DEFAULT_RATE_LIMIT` = capacity 100, refill 50/s: a flood-shedding net,
  not a tight quota), keyed per IP, over the kernel's durable SQL store
  (`durable !== false`) or per-process memory (`durable: false`). CSRF/CORS stay
  **off** — forcing them 403s legitimate clients.
- **`secure: { ...SecureStackOptions }`** — layered **over** the baseline (merge,
  not replace): a spelled `rateLimit` retunes it, while `originCheck` / `cors` /
  `csrf` add to it, so turning ON a CSRF check never silently turns OFF the DoS
  net. The kernel threads `db` + `dialect` in. CSRF is now one field away:
  `secure: { originCheck: {} }`.
- **`secure: false`** — opt out entirely, for an app that composes `secureStack`
  on its own `volo()` chain (estate) — it must not get the layer twice.

The scaffolded app declares `secure: { originCheck: {} }` (gets originCheck **plus**
the default rate-limit), modelling the one-place declarative idiom instead of the
`.map(fromRequestMiddleware)` incantation.

## Consequences

- A bare `createApp` app is now rate-limited by default, closing the readiness
  review's residual rate-flood DoS vector; CSRF is a one-field opt-in.
- Apps that compose their own `secureStack` (estate; the SQL-shared-bucket
  integration test) set `secure: false` to avoid double-application (double
  rate-limiting halves capacity and doubles store round-trips).
- Forcing CSRF/CORS by default is explicitly rejected — their safe policy is
  deployment-specific (browser vs. API), so they stay opt-in but discoverable.
- **Not changed here:** `csrf()` token plumbing, a deployment-shape flag that would
  let `originCheck` default-on safely for browser-only apps, and steering
  `@volo/identity` to the SQL session store the kernel already provisions — all
  follow-ups.

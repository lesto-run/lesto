# Auth & Security — v1 plan

Derived from `docs/reviews/auth-security.md`, reconciled with `docs/ROADMAP-V1.md` (which rules).
Packages: `@lesto/auth`, `@lesto/identity`, `@lesto/csrf`, `@lesto/cors`, `@lesto/ratelimit`,
`@lesto/authz`, `@lesto/rbac`, `@lesto/flags`.
ADR 0013 durable stores are **done** (async store interfaces, `sqlSessionStore`/`sqlRateLimitStore`,
cross-driver atomicity proof) — referenced, not re-planned. The package layer has **no P0**; the
launch-blocking edge findings are owned by **edge-deploy** (its items 1–2) and the `trustProxy`
fix by **core-runtime** (its item 2). This plan is the posture-and-defaults work.

**The bar, every increment:** TS/ESM/Bun; oxlint/oxfmt clean; 100% vitest coverage on touched
packages; `bun run ws:typecheck` + the serial coverage gate green; coded errors; truthful doc
comments; one conventional commit on `main`.

## Increments (ordered)

1. **Secret-strength guard** — `[Wave 0 | P1 | ships in the stop-the-bleed pass]`
   Files: `packages/auth/src/signed-sessions.ts`, `packages/csrf/src/token.ts`, `packages/identity/src/identity.ts` — throw a coded error (`AUTH_WEAK_SECRET` / `CSRF_WEAK_SECRET` / `IDENTITY_WEAK_SECRET`) at construction for secrets under 32 bytes. Estate's `"estate-demo-identity-secret"` fallback gets the same demo-flag fencing as the edge (coordinate with edge-deploy item 1).
   Acceptance: empty/short/exact-boundary secrets covered; estate boots only with real secrets or the explicit demo flag.

2. **Versioned password-hash format** — `[Wave 3 | P1 — must land before any real users register]`
   Files: `packages/auth/src/password.ts` — format `scrypt$N$r$p$salt$hash`; raise defaults to N=2^17; verify against stored params; rehash-on-successful-login when params are stale; switch to promisified async `crypto.scrypt` with explicit `maxmem` (kills the event-loop-blocking DoS amplifier); `packages/identity/src/identity.ts` `DUMMY_HASH` becomes lazily computed.
   Acceptance: legacy-format hashes still verify and are rehashed on login; params round-trip; no `scryptSync` on any request path; CPU-equalization branches keep coverage.

3. **Session tokens hashed at rest + revoke-on-reset by default** — `[Wave 3 | P1]`
   Files: `packages/auth/src/sql-session-store.ts` (store `sha256(token)` as the key; `find`/`delete` hash before lookup), `packages/identity/src/identity.ts` (`resetPassword` calls `deleteByUserId` unconditionally whenever the store supports it — ADR 0013 made this possible).
   Acceptance: a DB-snapshot row can no longer be replayed as a live token; the compromised-account flow (attacker session + victim reset) ends the attacker's session, proven in the integration journey.

4. **Login throttling** — `[Wave 3 | P1]`
   Files: `packages/identity/src/identity.ts` — a per-account `RateLimiter` keyed `login:<normalizedEmail>` over the SQL store (fleet-correct), wired inside `login`; document the IP-keyed `secureStack` limiter as the outer layer, not the defense.
   Acceptance: N failed logins for one account throttle that account across two store handles; coded `IDENTITY_LOGIN_THROTTLED` refusal; timing/enumeration posture preserved.

5. **Kernel defaults to durable stores** — `[Wave 3 | P1 — the pit-of-success item]`
   Files: `packages/kernel/src/kernel.ts` / `secure-stack.ts` — when `createApp` has a `db`, wire `sqlSessionStore` + `sqlRateLimitStore` (schema install after migrate) automatically; in production mode without a `db`, warn loudly once (the `RATELIMIT_UNKNOWN_CLIENT` warn-once latch is the house pattern) that sessions/limits are per-process memory.
   Acceptance: a `createApp({ db })` app shares sessions and rate limits through SQL with zero config; the warning fires exactly once and carries a stable code.

6. **Identity event seam** — `[Wave 4 | P1]` (seam owned here; OTLP wiring owned by operability-dx item 3)
   Files: `packages/identity/src/identity.ts` — injectable `onEvent(event: IdentityEvent)` emitting coded `login_succeeded`/`login_failed`/`password_reset`/`email_verified`/`session_revoked` (no secrets in payloads); a uniform optional `onDenied(kind, c)` across csrf/authz/ratelimit middleware in the same pass. Estate wires both to the tracer as the dogfood.
   Acceptance: every event covered; payloads grep-clean of tokens/passwords/emails-in-clear where avoidable; estate dashboard-able in the Wave 4 integration test.

7. **authz/rbac consolidation** — `[Wave 5 | P1]`
   Fold `@lesto/rbac`'s wildcard permissions + cycle-safe inheritance into `@lesto/authz`'s `definePolicy`; delete or attic `@lesto/rbac`. One authorization story before the API freezes.
   Acceptance: rbac's test matrix ports into authz; `createGuard` unchanged for existing callers; memoize resolved grants per role while in the file.

8. **CSRF/CORS small-correctness batch** — `[Wave 5 | P2]`
   Files: `packages/csrf` (a `csrfToken(c)` issuance helper that sets the companion cookie — or rename the battery's docs away from "double-submit"; `originCheck` `strict` option requiring `same-origin`), `packages/cors` (gate preflight handling on `Access-Control-Request-Method`; emit `Vary: Origin` whenever policy ≠ `"*"`), estate's edge `readCookie` duplication replaced with the `@lesto/identity` cookie module.
   Acceptance: each fix pinned; docs match behavior.

## Owned elsewhere (do not duplicate)

- Edge demo fencing (`SESSION_SECRET` fail-closed, `?as=` gate, `secureStack` on the edge app) → **edge-deploy** items 1–2 (launch blocker #1).
- `trustProxy: true` right-most semantics → **core-runtime** item 2 (launch blocker #4).
- Store sweep scheduling (`deleteExpired`/`sweep` cadence) → **data-persistence** item 11.
- MailTransport for identity's verify/reset emails → **web-primitives** item 1 (blocker #10).

## Deferred post-1.0 (deliberate)

- Edge-durable KV revocation list for `SignedSessions` / Durable-Object rate limiting on Workers — per ADR 0013 §8 and the durable-stores plan's through-line: the SQL tier must be boringly solid first.
- `IDENTITY_EMAIL_NOT_VERIFIED` enumeration trade stays as documented; strict-mode mapping recipe goes in the docs site.
- Argon2id migration — the versioned format (item 2) is the door; walking through it is post-1.0.

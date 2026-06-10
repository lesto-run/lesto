# ADR 0003 — Auth strategy: in-house battery, pluggable edges

- **Status:** Accepted — Phase 1 implemented (estate `?as=` rewrite pending)
- **Date:** 2026-06-09
- **Deciders:** tech lead + owner
- **Owner-confirmed (2026-06-09):** (1) the assembled battery is **`@keel/identity`**;
  (2) **email verification is required before first login** — default on,
  configurable off for low-friction apps.
- **Implementation note (2026-06-09):** `packages/identity` ships register /
  verifyEmail / login / requestPasswordReset / resetPassword + cookie helpers +
  currentUser. 100% unit coverage; the canonical journey is exercised over a
  real socket in `packages/integration/test/identity.integration.test.ts`. The
  estate `?as=` demo replacement remains: estate has no DB today, so wiring it
  to `@keel/identity` is a separate slice (add migration runtime + mail mock +
  swap controllers + update tests).

## Context

Keel claims "auth" as a batteries-included feature, but today it is **not real**:

- `@keel/auth` ships sound primitives — `hashPassword`/`verifyPassword` (scrypt),
  `Sessions` (store-backed), `SignedSessions` (HMAC, edge), `generateToken`,
  `MemorySessionStore`. But a grep confirms **`verifyPassword` is called by
  nothing** outside its own tests: no login flow uses it.
- `@keel/mail` (react-email + queued delivery) exists but is **wired to auth
  nowhere** — no verification or reset emails.
- `@keel/rbac` (roles, wildcard permissions) and `@keel/csrf` (double-submit
  tokens) exist and are correct.
- The estate demo "signs in" with `?as=<id>` — it picks a hardcoded user from a
  two-entry `Map` and mints a session with **zero credential verification**. It
  exists to prove the session/cookie/edge mechanism, not authentication.

So the *session and identity-carrying mechanism* is real and tested (signed
tokens, `__Host-` cookies, CSRF, the cross-isolate property); the *credential
verification and user lifecycle* do not exist. This is the canonical
"aspirational IOU" — the battery the framework most needs to actually own.

The question this ADR answers: **does Keel ship in-house auth, or bring-your-own
(Clerk / better-auth / hand-roll)?**

## Decision

**Build auth in-house, batteries-included, on the one substrate — as the default
that works with zero external dependencies — and put a strategy seam only at the
irreducible edges (OAuth/social, enterprise SSO). In-house-first, not BYO-first.**

Concretely, split auth into two layers along Keel's existing "own the core, thin
drivers at the edges" line (the same line as SES-for-mail, S3-for-storage):

| Layer | What | Stance |
|---|---|---|
| **Identity & sessions (core)** | users on the SQL DB, password hashing, session issue/verify, CSRF, RBAC, email verification + password reset via `@keel/mail` | **in-house, on the substrate** |
| **Credential methods (edges)** | OAuth social (Google/GitHub), enterprise SSO (SAML/OIDC), SCIM, passkeys | **pluggable adapters / strategy seam** |

### Why in-house-first, for Keel specifically

1. **It is the thesis.** Keel sells "the batteries Next.js makes you assemble."
   Auth is *the* battery — Rails ships `has_secure_password` + a built-in auth
   generator, Laravel ships Breeze/Fortify/Sanctum, WordPress owns users
   entirely; none say "go integrate Auth0." BYO-first auth makes Keel *be*
   Next.js on the most important battery.
2. **One substrate is the moat.** Users-in-your-DB join naturally to RBAC,
   content ownership, audit, and every query. Clerk/Auth0 put identity in *their*
   database — reintroducing exactly the cross-boundary sync/webhook glue Keel
   exists to delete.
3. **Agent-native only works if we own it.** Keel's differentiator is agent
   operation via MCP. In-house auth lets an agent create users and assign roles
   through the same MCP surface; that is impossible if identity lives in Clerk.
4. **No per-MAU tax** on an open-source "build anything" framework.

### Where BYO genuinely wins (the seam, not the core)

Do **not** reinvent the compliance-heavy edges: enterprise **SSO (SAML/OIDC)**
and **SCIM** belong behind an adapter (e.g. WorkOS); **social OAuth** owns the
flow but the provider list is an adapter set, not core; **passkeys/WebAuthn** are
in-house-able but a later phase.

### On better-auth and the "buyout" framing

Architect **for users, not for an exit.** better-auth is itself an own-your-DB,
in-app library — the *same* space as in-house Keel auth — so a clean strategy
seam makes wrapping or later acquiring it a *wrapper, not a rewrite*. The
optionality comes free from good seams; do not let a hypothetical acquisition
shape the core API. The door stays open precisely *because* the core is ours and
the edge is an interface.

### The one engineering rule: don't design the plugin interface first

The reliable way to get the strategy seam right is to **extract it from two
concrete strategies** (password, then Google OAuth) — not to invent an abstract
`AuthStrategy` up front and hope it fits. Premature plugin interfaces are almost
always wrong. So the interface is a Phase-2 deliverable, grounded in two working
implementations, never a Phase-1 guess.

## Package shape

Keep `@keel/auth` as **low-level primitives** (hashing, tokens, sessions — no
database, no flows; unchanged). Add **`@keel/identity`** — the assembled,
DB-backed auth battery that composes `@keel/auth` + `@keel/orm` + `@keel/migrate`
+ `@keel/mail` + `@keel/csrf` + `@keel/rbac` into real users and real flows.

That respects the layering (primitive vs. battery), mirrors how `@keel/content-*`
sits on `@keel/orm`, and lets an app depend on just the primitives if it wants to
assemble its own.

## Implementation plan (phased)

### Phase 1 — in-house email/password + email verification (`@keel/identity`)

The MVP real-auth slice. No external services; runs on SQLite/Postgres + mail.

- **Users model + migration** — `users` table: `id`, `email` (unique, citext/
  lower-cased), `password_hash`, `email_verified_at` (nullable), `timestamps`.
  An ORM model + a `@keel/migrate` migration.
- **Register** — `register(email, password)`: reject duplicate email, validate
  password policy, `hashPassword`, insert user (unverified), mint a *signed,
  time-boxed* verification token (`SignedSessions`/`generateToken`), send it via
  `@keel/mail` (a react-email verification template). No session yet.
- **Verify email** — `verifyEmail(token)`: verify the signed token, set
  `email_verified_at`. Idempotent; expired/invalid → typed error.
- **Login** — `login(email, password)`: look up by email, `verifyPassword`
  (constant-time; the already-fixed fail-closed path), require verified email
  (configurable), issue a real session (store-backed for node, `SignedSessions`
  for edge — same `?as=`-replacement seam estate already has).
- **Password reset** — request (email a signed token) → reset (verify token, set
  new hash, invalidate existing sessions where revocable).
- **Controller helpers / middleware** — `currentUser(request)`, a guard that
  401s/redirects unauthenticated requests, CSRF (`@keel/csrf`) on every
  state-changing POST (register/login/reset), `__Host-` `Secure` cookies.
- **Replace estate's `?as=` demo** — wire `/mls` to real register/verify/login;
  delete the impersonation path (or fence it behind an explicit demo flag).
- **Tests** — `@keel/identity` unit at 100%; an **integration test in
  `@keel/integration`** that drives the full journey over a real socket with a
  *fake mail transport* capturing the link: register → verify (via captured
  token) → login → access gated resource → reset → re-login.

### Phase 2 — extract the strategy seam + Google OAuth

- Implement **Google OAuth** as the second credential method (authorize →
  callback → link/create user by verified email → issue session).
- **Now** extract `AuthStrategy` from what password and OAuth genuinely share
  (resolve-or-create a user → issue a session); document "implement
  `AuthStrategy`" as the third-party door (Clerk / better-auth / WorkOS wrap
  here).

### Phase 3 — deferred, noted not planned

Enterprise SSO (SAML/OIDC) + SCIM via a WorkOS-style adapter; passkeys/WebAuthn;
TOTP/MFA. Each is an adapter or an additive strategy on the Phase-2 seam.

## Non-goals (Phase 1)

Social OAuth (Phase 2), enterprise SSO/SCIM and passkeys (Phase 3), MFA, and an
abstract provider interface (extracted in Phase 2, never guessed in Phase 1).

## Consequences

- Keel gains a **real** auth battery — register/verify/login/reset on its own
  substrate, agent-manageable, zero external deps — closing the most prominent
  IOU and proving the batteries-included thesis on its hardest case.
- The estate `?as=` fake is replaced by real credentials; the live site becomes a
  genuine demonstration rather than a mechanism stub.
- The strategy seam keeps Clerk/better-auth/WorkOS as *options at the edge*
  without coupling the core to any of them — optionality without an exit bet.
- Building it dogfoods `@keel/orm` + `@keel/migrate` + `@keel/mail` + `@keel/auth`
  + `@keel/csrf` + `@keel/rbac` together, which (per the deploy QA) is exactly
  where integration bugs surface and get pinned.

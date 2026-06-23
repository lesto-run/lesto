# ADR 0030 — OAuth client / social sign-in ("Sign in with …")

- **Status:** Proposed. The broadly-demanded "OAuth out of the box" battery — letting a
  Lesto app's users sign in via an external IdP (Google/GitHub/generic OIDC). It is the
  *client* side of OAuth (the app is the OAuth client), distinct from and **sequenced
  before** ADR 0029 (Lesto as an Authorization *Server*). Mandate: a **vetted OAuth/OIDC
  client library** (never hand-rolled). Shipped as an opt-in package; not loaded by
  default.
- **Date:** 2026-06-20
- **Deciders:** tech lead + owner
- **Builds on / touches:** ADR 0003 (auth strategy), ADR 0013 (durable stores —
  `SqlDatabase` seam), ADR 0016 (secure-by-default kernel), ADR 0020 (auth factors —
  social login is another factor alongside password/TOTP). Composes `@lesto/identity` +
  `@lesto/auth` (find/create user + mint session), `@lesto/web` (app-layer mount),
  `@lesto/csrf` (`originCheck` on the return).

## Context

A batteries-included framework competing with Rails (`omniauth`), Laravel (Socialite),
Next/Auth.js, and Django (`allauth`) needs "Sign in with Google/GitHub" as a first-class
battery. Lesto does not have it: `packages/auth/src/index.ts:17` explicitly defers
"OAuth / social sign-in via better-auth" as "a future adapter, out of scope here." This
ADR makes that adapter real.

The owner's framing — "shouldn't the framework ship OAuth out of the box?" — is
correct, and this is the part of "OAuth out of the box" that the most apps want: the
**client** role. (The rarer *Authorization Server* role — issuing tokens that others
consume — is ADR 0029, and it ships after this.)

The reuse seams already exist in `@lesto/identity` (verified against the code):
`findUserByEmail` (`user.ts:75`), `insertUser` (`user.ts:58`), `findUserById`
(`user.ts:80`), `isEmailVerified`/`emailVerifiedAt` (`user.ts:53`), `markEmailVerified`
(`user.ts:94`), `normalizeEmail` (`user.ts:108`), `Identity.currentUser` (`identity.ts:355`),
and session minting via `sessions.create(String(user.id), ttl)` (`identity.ts:702`). Two
gaps to close: **(1)** `register` requires a password (`identity.ts:346`) — social-login
users may have none, so a **passwordless user-creation path** is needed; **(2)** there is
no place to record *which external account maps to which Lesto user* — a **linked
identities** table is net-new.

## Decision

Add an opt-in `@lesto/oauth-client` package (app-tier; depends on `@lesto/web` +
`@lesto/identity` + `@lesto/csrf`, **mounted by the app**, never by `kernel`) that turns
a Lesto app into an OAuth 2.0 / OIDC **client** against configured providers, built on a
**vetted, edge-friendly client library** (e.g. `arctic` for lightweight provider presets
+ PKCE on Workers, or `openid-client` for full OIDC/Node) — **never hand-rolled**. The
same library discipline as ADR 0029: own the Lesto glue, not the crypto/protocol.

### Scope

- **Provider registry.** Presets for Google, GitHub, and a generic OIDC provider
  (issuer discovery), each configured with client id/secret + scopes; pluggable so an
  app adds providers without a Lesto change.
- **The flow (two routes per provider, app-mounted):**
  - `GET /auth/:provider` — generate **PKCE** (`S256`) + **`state`** (+ **`nonce`** for
    OIDC), stash them in a short-lived signed/HTTP-only cookie, redirect to the
    provider's authorization endpoint.
  - `GET /auth/:provider/callback` — verify `state` (CSRF/mix-up), exchange the code
    (with `code_verifier`), validate the **ID token** for OIDC (signature via the
    provider JWKS, `iss`/`aud`/`exp`/**`nonce`**), fetch userinfo, then resolve to a
    Lesto identity and mint a session.
- **Identity resolution (the security-critical part — see below):** look up a
  **linked identity** `(provider, provider_account_id)`; if found → that user. If not,
  and the provider asserts a **verified** email matching an existing user → link (record
  the linked identity). Otherwise create a **passwordless** user (`emailVerifiedAt` set
  iff the provider verified it) and link.
- **New persisted entities** (over the `SqlDatabase` seam, edge-safe): a
  **`linked_identities`** table (`user_id`, `provider`, `provider_account_id` unique per
  provider, created/updated). A passwordless user is a `users` row with no usable
  password hash (a sentinel that `verifyPassword` always rejects, so password login
  can't be used on an OAuth-only account until the user sets one).
- **Session + account management:** on success, `sessions.create(String(user.id), ttl)`
  — the same session the rest of the stack reads; `currentUser` is unchanged. Expose
  *link/unlink* for an already-authenticated user (add a second provider, remove one)
  with a guard against removing the **last** sign-in method.

### Security posture (the review gate enforces it)

- **`state` + PKCE `S256`** mandatory; **`nonce`** for OIDC ID tokens; reject on any
  mismatch.
- **Account-takeover via unverified email is the #1 social-login footgun — closed by
  default.** Auto-linking to an existing user requires the provider to assert a
  **verified** email; an unverified provider email **never** auto-links (the attacker-
  registers-with-your-email-at-a-sloppy-IdP attack). Linking an unverified provider
  account is allowed *only* while already authenticated as that Lesto user (explicit
  linking).
- **ID-token validation** (OIDC): verify signature against the provider's JWKS, pin
  `alg`, check `iss`/`aud`/`exp`/`nonce` — the same JWT-verification discipline ADR 0029
  mandates (and a reason to share a `jose`-based verify helper).
- **Open-redirect** on the post-login `returnTo`: relative same-origin paths only;
  `originCheck` on the callback; the provider `redirect_uri` is exact-registered.
- Provider **client secrets** are server-only secrets (the `WEAK_SECRET`-class guard);
  state/PKCE cookies are HTTP-only, `SameSite=Lax`, short-TTL, signed.

## Non-goals

- **Not the Authorization Server** (issuing Lesto's own tokens) — that's ADR 0029.
- **Not SAML / enterprise SSO** — a later adapter if demanded.
- **No hand-rolled OAuth/JWT** — vetted library only.
- **No change to the password/TOTP factors** (ADR 0020) — social login is additive.

## Sequencing

Ships **before** ADR 0029 (the broad battery first; it's smaller and serves far more
apps). Independent of the operator control plane (ADR 0028). Within itself: linked-
identities + passwordless-user path → one provider end-to-end (Google or GitHub) →
generic OIDC → link/unlink management.

## Consequences

- Lesto gains the "Sign in with …" battery every batteries-included peer ships, closing
  the gap `auth/index.ts:17` records, reusing the existing identity/session stack rather
  than reinventing it.
- Two small net-new entities (linked identities, passwordless users) that also benefit
  future factors (magic-link, passkeys — ADR 0020).
- Establishes the vetted-library + share-the-`jose`-verify-helper discipline that ADR
  0029 then reuses for the AS.
- Security-sensitive but far smaller than the AS; the verified-email-before-link rule is
  the one non-negotiable that the review gate must confirm.

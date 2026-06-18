# ADR 0020 — Auth factors: TOTP, passkeys/WebAuthn, and magic-link

- **Status:** Proposed (Increment 1 — TOTP — implemented)
- **Date:** 2026-06-18
- **Deciders:** tech lead + owner
- **Supersedes nothing; extends ADR 0003 (auth implemented — register/verify/login/reset), ADR 0013 (durable stores), and inherits ADR 0005 (validation at the boundary) + ADR 0006 (async-only seam).**

## Context

`@lesto/identity` today is **single-factor**: a user is `email + passwordHash +
emailVerifiedAt` (`packages/identity/src/user.ts`), and `login` proves exactly one
thing — that the caller knows the password (`packages/identity/src/identity.ts`).
There is no second factor, no passwordless path, and no recovery story beyond the
password-reset email. Against Rails 8 / Laravel 12 / better-auth / Clerk, that is the
loudest honest gap in the auth battery: every one of them ships **2FA (TOTP),
passkeys (WebAuthn), and magic-link** out of the box.

The password path already sets the discipline this ADR must keep:

- **Hashed at rest.** Passwords are scrypt-hashed (`packages/auth/src/password.ts`),
  self-describing and re-hashable; nothing secret is stored in the clear.
- **Fail closed.** A malformed stored hash verifies to `false`, never throws,
  never "fails open" (`parseStored`).
- **Constant-time comparison.** `timingSafeEqual` everywhere a secret is compared.
- **Coded errors.** Every refusal carries a stable `IdentityError` / `AuthError`
  `code` (`packages/identity/src/errors.ts`, `packages/auth/src/errors.ts`).
- **Closure-factory, explicit `db`, async-only.** `createIdentity` returns plain
  functions closing over options; the `db` handle is threaded, never global; every
  terminal is a `Promise` over the `@lesto/db` seam (ADR 0006).
- **Enumeration-safe.** `register` / `requestPasswordReset` are success-shaped on
  conflict/unknown-email and spend equal CPU on every path.

A second factor must inherit *all* of it. The hard part is not the crypto — TOTP is
~60 lines of `node:crypto`, WebAuthn assertion is a documented COSE/CBOR verify — it
is keeping three new factors from each leaking a different shape into `login`, the
schema, and the call-site. So this ADR designs all three up front and ships them in
strict increments.

### Why not an npm dependency

TOTP is **HMAC-SHA1 over an 8-byte time counter** (RFC 4226 HOTP) with the counter
derived from the clock (RFC 6238), plus a **base32** secret. `node:crypto` has
`createHmac` and `randomBytes`; base32 is ~30 lines. Pulling `otplib`/`speakeasy`
adds a transitive tree and a second hasher we do not control, for code we can own and
test to 100%. **No TOTP dependency is added** (the lockfile has none). The same logic
applies to recovery codes: they are **hashed with the existing scrypt
`hashPassword`** — we do *not* invent a second hasher.

WebAuthn (Increment 2) is the one place build-vs-buy is genuinely open: assertion
verification needs CBOR/COSE decode + an ES256/RS256 signature check. That tradeoff
is decided in Increment 2's own spike, not here — this ADR only fixes the *seam* it
hangs off.

## Decision

Ship multi-factor auth as **three increments on `@lesto/auth` + `@lesto/identity`**
(no new package), in dependency order, each gate-green and non-breaking to estate.
The unifying model:

> A **factor** is a credential, hashed/secret-bearing at rest, owned by a user, that
> a **challenge** verifies. `login` stays the password gate; a *second factor*, when
> enrolled, is a **second step** (`login → factor challenge → session`), never a
> change to the password contract. Passwordless (magic-link, passkey-first) is a
> *first* factor that replaces the password step, reusing the same challenge seam.

The two load-bearing anti-footgun decisions:

1. **Secrets are hashed/encrypted at rest with the password path's primitives.**
   Recovery codes are scrypt-`hashPassword`'d (single-use, verified with
   `verifyPassword`). A TOTP shared secret is the one unavoidable exception — TOTP
   *requires* the verifier to hold the secret to recompute the code, so it cannot be
   one-way hashed; it is stored as the raw base32 secret in a dedicated table and the
   ADR is explicit that **protecting it is the deployment's at-rest-encryption job**
   (the same posture every TOTP implementation has), not a property we can fake with
   a hash. WebAuthn stores only a *public* key — nothing secret at rest at all.
2. **A factor is a row, not a column on `users`.** Each factor type gets its own
   table keyed by `user_id`, so adding a factor never migrates the hot `users` row
   and a user can hold several (multiple passkeys, TOTP + recovery codes).

### 1 · TOTP (RFC 6238) + recovery codes — **shipped**

The primitive lands in `@lesto/auth` (`totp.ts`), pure and dependency-free:

- `generateTotpSecret()` → a base32-encoded random secret (160 bits, the RFC SHA1
  recommendation), via `randomBytes` + an in-house base32 (RFC 4648) encoder.
- `totpCode(secret, { timeStep, digits, clock })` → the current 6-digit code:
  base32-decode the secret → 8-byte big-endian counter = `floor(epochSeconds /
  timeStep)` → `HMAC-SHA1(secret, counter)` → dynamic truncation (RFC 4226 §5.3) →
  `code mod 10^digits`, zero-padded.
- `verifyTotp(secret, code, { window, timeStep, digits, clock })` → **drift-tolerant,
  constant-time** check across `±window` steps (default `±1` = ±30s), so a slightly
  fast/slow authenticator app still verifies. Each candidate is compared with
  `timingSafeEqual`; a malformed secret/code returns `false`, never throws
  (fail-closed, mirroring `verifyPassword`).
- `totpKeyUri({ secret, issuer, account })` → the standard
  `otpauth://totp/Issuer:account?secret=…&issuer=…` provisioning URI an authenticator
  app (or a QR encoder) consumes. We emit the URI (the QR *data*); rendering the QR
  image is the app's choice — keeps the package zero-dependency and edge-safe.

The identity service (`@lesto/identity`, `totp.ts` + new `Identity` methods) wires
the storage + flows over **two tables**:

```ts
// totp_factors: at most one per user (UNIQUE user_id), the enrolled secret.
totp_factors(id pk, user_id unique not null, secret not null,
             confirmed_at timestamp null, created_at, updated_at)

// recovery_codes: N single-use, scrypt-hashed backup codes per user.
recovery_codes(id pk, user_id not null, code_hash not null,
               used_at timestamp null, created_at)
```

Both tables are declared as `@lesto/db` schema values using the **current** column
API — `boolean`/`timestamp` now exist (ADR 0018 Increment 1), so `confirmed_at` /
`used_at` / `created_at` are real `timestamp` columns hydrating to `Date`, not
string-by-convention. (A real FK `user_id → users.id` is deferred until ADR 0018
Increment 2 lands FKs; the column is a plain `integer("user_id")` today, exactly as
`sql-session-store` keys its `user_id` — schema-only, non-breaking to upgrade later.)

The three flows, each a coded, fail-closed `Identity` method:

- **enroll** (`enrollTotp(token)`): authenticated by the caller's session. Generates a
  fresh secret, upserts an **unconfirmed** `totp_factors` row, and returns
  `{ secret, keyUri }` so the app can render the QR. Enrolling again before
  confirmation re-issues a new secret (the old unconfirmed one is discarded).
  **Returns the secret exactly once, at enroll** — never re-fetchable, matching every
  authenticator-onboarding UX.
- **confirm** (`confirmTotp(token, code)`): the user types the first code from their
  app. On a valid `verifyTotp`, stamps `confirmed_at` *and* mints the recovery codes
  — `generateRecoveryCodes()` returns the **plaintext** codes once (shown to the user,
  never stored), persisting only their scrypt `hashPassword` digests. An invalid code
  throws `IDENTITY_INVALID_TOTP`; an already-confirmed factor throws
  `IDENTITY_TOTP_ALREADY_ENROLLED`. This is the enroll→challenge→verify boundary.
- **verify a challenge** (`verifyTotpChallenge(userId, code)` and
  `verifyRecoveryCode(userId, code)`): the second-factor step *after* `login` proves
  the password. `verifyTotpChallenge` checks the live code; `verifyRecoveryCode`
  finds an *unused* code whose `verifyPassword(code, code_hash)` matches, marks it
  `used_at` (single-use — a replay finds it spent), and is the break-glass path when
  the authenticator is lost. Both are enumeration-quiet: an unknown user / no factor /
  bad code all surface the same `IDENTITY_INVALID_TOTP`, spending one constant-time
  comparison.

`login` itself is **unchanged** in Increment 1 — TOTP is exposed as an explicit
second step the caller orchestrates (`login` → if `hasTotp(userId)` → challenge),
rather than baking a `mfaRequired` branch into the password contract now. A
`hasTotp(userId)` probe lets the caller decide. (A future increment may fold a
first-class `login` MFA gate; the seam is already here.)

*Acceptance (this increment):* enroll → confirm → challenge-verify journey green; a
recovery-code path green (one code verifies once, a replay is refused); secrets and
recovery codes hashed/stored per the model above; 100% coverage on both packages.

### 2 · WebAuthn / passkeys — **deferred (designed here, not implemented)**

A passkey is a public-key credential bound to the origin; the server stores only the
**public key + credential id + signature counter** — *nothing secret at rest*, the
strongest at-rest posture of the three. Two flows, both challenge/response:

- **Registration** (`navigator.credentials.create`): server issues a random
  challenge → browser returns an attestation → server verifies the attestation,
  extracts the COSE public key + credential id, and stores them in a
  `webauthn_credentials(id, user_id, credential_id unique, public_key, sign_count,
  transports, created_at)` table.
- **Assertion** (`navigator.credentials.get`, the login): server issues a challenge →
  browser signs it with the private key (held by the authenticator/Secure Enclave) →
  server verifies the signature against the stored public key, checks the **signing
  counter strictly increased** (clone detection), and bumps it.

Hard parts deferred to this increment's own spike: CBOR/COSE decode + ES256/RS256
signature verification (the genuine build-vs-buy call — likely `@simplewebauthn/server`
or a minimal in-house COSE verify), **challenge storage** (a short-TTL,
single-use server-side challenge — reuse the durable `RateLimitStore`/a small table,
per ADR 0013), and **origin/RP-ID binding** (an assertion must be checked against the
exact origin — the anti-phishing property that *is* the point of passkeys, and the
easiest thing to get subtly wrong). It hangs off the **same factor-as-a-row +
challenge seam** as TOTP, so the `Identity` surface grows by `enrollPasskey` /
`verifyPasskeyAssertion`, not a new shape.

### 3 · Passwordless magic-link — **deferred (designed here, not implemented)**

A magic-link is `requestPasswordReset` with a different terminal: instead of a reset
form, the signed token *is* the login. It reuses the existing primitives almost
entirely:

- **request** (`requestMagicLink(email)`): enumeration-safe exactly like
  `requestPasswordReset` (success-shaped on unknown email, equal CPU), mints a
  **single-use, short-TTL signed token** via the existing `SignedSessions` /
  `tokens.ts` machinery, and mails the link. Single-use is enforced by **binding the
  token to a per-user nonce** stored hashed (`magic_link_nonces`, scrypt-hashed,
  consumed on use) — the same "single-use via a stored secret" pattern recovery codes
  use — so a replayed link finds its nonce spent.
- **redeem** (`redeemMagicLink(token)`): verifies the signed token, consumes the
  nonce (atomic, single-use), and mints a real session — the passwordless first
  factor. `requireVerifiedEmail` still gates it; a magic-link to an unverified email
  both proves the email *and* logs in.

Deferred because it is the smallest of the three and depends only on what already
ships; it lands after TOTP with no new crypto, just the nonce table + two methods.

## What this is explicitly NOT

- **Not a new package.** Factors live in `@lesto/auth` (primitives) + `@lesto/identity`
  (storage + flows), beside the password path they extend.
- **Not a second hasher.** Recovery codes (and magic-link nonces) reuse scrypt
  `hashPassword`/`verifyPassword`. TOTP's shared secret is the one thing that *cannot*
  be one-way hashed (the verifier must recompute the code); at-rest protection of that
  secret is the deployment's encryption job, stated honestly, not faked.
- **Not a `login` rewrite.** Increment 1 leaves the password contract untouched and
  exposes TOTP as an explicit second step + a `hasTotp` probe. A first-class `login`
  MFA gate is a later, additive option.
- **Not WebAuthn or magic-link now.** Both are designed above and implemented in
  Increments 2 and 3 — TOTP (Increment 1) is the only one this ADR ships.
- **Not SMS/email OTP as a *factor*.** SMS OTP is phishable + SIM-swappable; email OTP
  is just magic-link. Neither earns a factor slot.

## Sequencing

Strict order; each independently shippable, gate-green, non-breaking on `main`:

1. **TOTP + recovery codes** *(this increment, shipped)* — `@lesto/auth/totp.ts`
   primitive + `@lesto/identity` `totp_factors` / `recovery_codes` tables + enroll /
   confirm / challenge-verify / recovery flows + new `IDENTITY_*` codes + estate
   dogfood. No `login` change.
2. **WebAuthn / passkeys** — `webauthn_credentials` table + challenge store + the
   CBOR/COSE build-vs-buy spike + register/assert flows on the same factor seam.
3. **Magic-link** — `magic_link_nonces` (scrypt-hashed, single-use) + request/redeem,
   reusing `SignedSessions` + the enumeration-safe `requestPasswordReset` shape.

## Consequences

- The auth battery gains a real second factor (TOTP) with single-use, hashed-at-rest
  recovery codes — the same fail-closed, constant-time, coded-error discipline the
  password path set, with no new dependency and 100% coverage.
- A factor is a row keyed by `user_id`, so the model extends to passkeys and any
  future factor without migrating `users` and without a per-factor reshape of `login`.
- The remaining two factors are designed, scoped, and sequenced — not hand-waved — so
  Increment 2/3 start from a fixed seam (factor-as-a-row + challenge), with their one
  genuinely-open question (WebAuthn's CBOR/COSE build-vs-buy) named rather than
  pre-decided.
- Cost: TOTP's shared secret is the one value not one-way-hashable; the ADR states the
  deployment-encryption responsibility for it plainly instead of pretending a hash
  protects a secret the verifier must be able to recompute.

## Open questions (resolve in the Increment 2/3 spikes)

- **WebAuthn CBOR/COSE: build vs. `@simplewebauthn/server`.** Settle against the real
  attestation/assertion verify, weighed against the zero-dependency norm everywhere
  else in Lesto.
- **Challenge storage TTL + store.** A WebAuthn challenge is single-use and short-TTL;
  reuse the `RateLimitStore` shape, a dedicated table, or a signed stateless
  challenge? Decide against the assertion flow's replay requirements.
- **First-class `login` MFA gate.** Should `login` itself return a
  `{ status: "mfa_required", userId }` when a factor is enrolled, or stay a pure
  password gate with the caller orchestrating the second step (Increment 1's choice)?
  Decide once a second factor type (passkey) exists to generalize over.

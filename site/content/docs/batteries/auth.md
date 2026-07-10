---
title: Auth
description: Registration, email verification, login, password reset, and two-factor TOTP — with sessions that work on both Node and the edge.
section: Batteries
order: 3
---

# Auth

Lesto splits authentication across two packages. `@lesto/auth` owns the
primitives — runtime-adaptive password hashing (scrypt on Node, PBKDF2 on the
edge), TOTP one-time codes, recovery codes, and the session stores — each a
small, dependency-free function over `node:crypto` or WebCrypto.
`@lesto/identity` is the account lifecycle assembled on top of them: register,
verify email, login, password reset, and TOTP enrollment, wired over your
database and a mailer.

Most apps talk to `@lesto/identity`. You reach for `@lesto/auth` when you want a
piece on its own — a signed token on the edge, or a password hash outside the
account flow.

## Wiring an identity service

`createIdentity` is a closure factory: pass it a database handle, a signing
secret, and a mailer, and it returns an object of plain functions. The `db`
handle is explicit — identity never reaches for a global.

```ts
import { createIdentity } from "@lesto/identity";
import { installSessionSchema, sqlSessionStore } from "@lesto/auth";

await installSessionSchema(sql); // idempotent — safe at every boot

const identity = createIdentity({
  db,
  secret: process.env.LESTO_AUTH_SECRET!, // >= 32 bytes; openssl rand -hex 32
  sessionStore: sqlSessionStore(sql),
  mailer: { sendVerificationEmail, sendPasswordResetEmail },
  verificationUrl: (token) => `https://app.com/verify?token=${token}`,
  resetUrl: (token) => `https://app.com/reset?token=${token}`,
});
```

`secret` backs the HMAC signatures on verification and reset tokens. The
secret-strength guard rejects anything under 32 bytes at construction, so a
misconfigured deployment fails closed at startup rather than signing tokens with
a guessable key. Without an explicit `sessionStore`, identity defaults to an
in-memory store suited to a single process.

## Register, verify, login

```ts
// Sends a verification email; no session is issued yet.
await identity.register("ada@example.com", "correct horse battery staple");

// The user clicks the link; verifyEmail is idempotent.
await identity.verifyEmail(tokenFromLink);

// Login is gated on verification by default.
const { user, session } = await identity.login(
  "ada@example.com",
  "correct horse battery staple",
);
```

`register` is enumeration-safe: a colliding email returns the same
`{ status: "verification_sent" }` shape and spends the same hashing cost, so an
attacker cannot probe which emails are registered. `login` returns
`IDENTITY_INVALID_CREDENTIALS` for both an unknown email and a wrong password,
and always spends one KDF derive so the two paths are timing-equal. To bound
credential stuffing, wire a `loginRateLimiter`: each failed attempt burns a
token from a per-account `login:<email>` bucket, and a drained bucket refuses
with `IDENTITY_LOGIN_THROTTLED` before the database or the KDF is touched. A
successful login spends nothing, so a real user is never locked out by their
own sign-in.

To set the cookie from a handler, use the cookie helpers `@lesto/identity` ships:

```ts
import { readSessionToken, sessionCookie, clearSessionCookie } from "@lesto/identity";

const { session } = await identity.login(email, password);
return {
  status: 303,
  headers: { Location: "/app", "Set-Cookie": sessionCookie(session.token) },
};
```

## Password reset

```ts
// Always resolves "reset_sent", even for an unknown email (enumeration-safe).
await identity.requestPasswordReset("ada@example.com");

// The reset token is single-use in effect: it is signed with a secret that
// mixes in the current password hash, so it dies the moment the password changes.
await identity.resetPassword(tokenFromLink, "a brand new passphrase");
```

When the session store is SQL-backed, `resetPassword` also revokes every one of
the user's live sessions — so a victim's reset ends an attacker's stolen
session, with no extra wiring.

## Two-factor: TOTP and recovery codes

Enrollment is two steps. `enrollTotp` mints a secret and the `otpauth://`
provisioning URI you render as a QR code; `confirmTotp` confirms it with the
first authenticator code and returns the one-time-visible recovery codes.

```ts
// Both methods take the session token — they act on the signed-in user.
const { secret, keyUri } = await identity.enrollTotp(sessionToken);
// ...user scans keyUri, types the first code...
const { recoveryCodes } = await identity.confirmTotp(sessionToken, code);
// Show recoveryCodes once — only their KDF hashes are stored.
```

After a password login, run the second-factor challenge. These methods take the
numeric `user.id`, not a session token. Both a live code and a single-use
recovery code are accepted:

```ts
if (await identity.hasTotp(user.id)) {
  if (usingRecoveryCode) {
    await identity.verifyRecoveryCode(user.id, code);
  } else {
    await identity.verifyTotpChallenge(user.id, code);
  }
}
```

A wrong, expired, or replayed code throws `IDENTITY_INVALID_TOTP` — enumeration-quiet,
so it never reveals whether a factor exists. Wire a `totpRateLimiter` to bound an
attacker iterating codes; a drained bucket refuses with `IDENTITY_TOTP_THROTTLED`
before the secret is touched.

## Identity methods

| Method | Signature | Returns |
| --- | --- | --- |
| `register` | `(email, password)` | `{ status: "verification_sent", user }` |
| `verifyEmail` | `(token)` | `User` (idempotent) |
| `login` | `(email, password)` | `{ user, session }` |
| `requestPasswordReset` | `(email)` | `{ status: "reset_sent" }` |
| `resetPassword` | `(token, newPassword)` | `User` |
| `logout` | `(token)` | `void` |
| `currentUser` | `(token)` | `User \| undefined` |
| `enrollTotp` | `(token)` | `{ secret, keyUri }` |
| `confirmTotp` | `(token, code)` | `{ recoveryCodes }` |
| `hasTotp` | `(userId)` | `boolean` |
| `verifyTotpChallenge` | `(userId, code)` | `void` |
| `verifyRecoveryCode` | `(userId, code)` | `void` |

Every failure throws an `IdentityError` carrying a stable `code` (e.g.
`IDENTITY_INVALID_CREDENTIALS`, `IDENTITY_EMAIL_NOT_VERIFIED`,
`IDENTITY_WEAK_SECRET`). Branch on the code, never the message. The lower-level
primitives throw `AuthError` (`AUTH_INVALID_HASH`, `AUTH_WEAK_SECRET`,
`AUTH_KDF_UNAVAILABLE`) the same way.

## Sessions on both tiers

`@lesto/auth` ships two session strategies so one app authenticates on a
long-lived Node server and on the ephemeral Cloudflare edge.

```ts
import { sqlSessionStore, installSessionSchema, SignedSessions } from "@lesto/auth";

// Server tier: revocable, store-backed. Tokens are sha256-hashed at rest.
await installSessionSchema(sql);
const store = sqlSessionStore(sql);

// Edge tier: stateless HMAC tokens, no store to consult.
const signed = new SignedSessions({ secret: process.env.LESTO_AUTH_SECRET! });
const token = signed.issue(String(user.id), 15 * 60 * 1000); // 15-minute TTL
const claim = signed.verify(token); // { userId, expiresAt } | undefined
```

- **`sqlSessionStore`** — server-side sessions in your database. Revocable
  per-token (`delete`) and per-user (`deleteByUserId`), which is what powers
  revoke-on-reset. The right fit for a Node server. Pass it as `createIdentity`'s
  `sessionStore`.
- **`SignedSessions`** — stateless signed tokens. The token *is* the proof: any
  isolate holding the secret can verify a session it never issued, with no
  lookup. The right fit for per-PoP Worker isolates where there is no shared
  store. The trade-off is that a signed token cannot be revoked before it expires
  — keep its TTL short.

## Password hashing on the edge

Password hashing is runtime-adaptive, and you configure nothing. `hashPassword`
mints under the KDF the host can bear — memory-hard **scrypt** on Node/Bun,
CPU-hard **PBKDF2** over `crypto.subtle` on Cloudflare Workers, where scrypt's
~128 MiB working set would OOM-crash the isolate on the first hash. The
selection (`selectPasswordAlgorithm`) is fail-safe: only a positively-identified
Node host gets scrypt; every ambiguous runtime falls to PBKDF2, which is still
fully secure and cannot crash.

Hashes are self-describing (`scrypt$…` / `pbkdf2$…`), so `verifyPassword`
dispatches on the stored prefix — a PBKDF2 hash verifies on every runtime. The
one hard boundary: a **scrypt hash reaching the edge cannot be verified there**.
`verifyPassword` refuses it *before* the derive with a coded `AuthError`
`AUTH_KDF_UNAVAILABLE` (an OOM is not catchable, so the refusal must happen at
dispatch). A greenfield edge app never sees this — the edge mints and reads only
PBKDF2. It appears when a password database minted on Node moves to the edge.

`login` catches that refusal and maps it via the `onUnverifiableHash` option:

- `"invalid_credentials"` (the default) — refuse with
  `IDENTITY_INVALID_CREDENTIALS`, byte- and timing-identical to a wrong
  password. Enumeration-safe; migrated users recover via a reset link.
- `"require_reset"` — refuse with the distinct
  `IDENTITY_PASSWORD_RESET_REQUIRED` so your app can route the user straight to
  the reset screen. This deliberately leaks which emails are
  registered-but-legacy; opt in only when the UX outweighs that.

To migrate a Node password DB ahead of an edge cutover, wire the
`pbkdf2MigrationHasher` preset on the still-live Node tier:

```ts
import { createIdentity, pbkdf2MigrationHasher } from "@lesto/identity";

const identity = createIdentity({ ...options, hasher: pbkdf2MigrationHasher });
```

It verifies existing scrypt rows as usual (Node runs scrypt fine) but mints
PBKDF2 and marks every non-PBKDF2 row as due for rehash — so the existing
rehash-on-login seam re-mints each user's proven plaintext as edge-safe PBKDF2
on their next sign-in. Hashes are one-way, so convert-on-login (or a reset) is
the only migration path; whatever tail has not signed in by cutover is handled
by a password reset, which also mints PBKDF2.

## Notes & gotchas

- **The secret guard fails closed at construction.** A secret under 32 bytes
  throws `IDENTITY_WEAK_SECRET` (or `AUTH_WEAK_SECRET` for `SignedSessions`) when
  the service is built, turning a weak key into a startup error, not a silent
  hole. Generate one with `openssl rand -hex 32` and store it as an env var.
- **Signed sessions have no pre-expiry revocation.** There is nothing to delete,
  so a leaked signed token is valid until it ages out. Keep TTLs short (minutes,
  not days) and pair with the SQL store when instant revocation matters.
- **Verification fails closed.** A malformed stored hash verifies to `false`
  rather than throwing — a truncated hash can never make every password pass.
  Hashes are self-describing, so `login` transparently upgrades a stale one on
  the next successful sign-in — and a scrypt hash on the edge is refused with
  `AUTH_KDF_UNAVAILABLE` before the derive, never silently accepted or crashed
  on.
- **The `__Host-` cookie needs HTTPS.** The session cookie name carries the
  browser-enforced `__Host-` prefix, so it is dropped over plain
  `http://localhost`. Use a dev-mode cookie name there; never drop `Secure` on a
  real deploy.
- **Not in v1.** There is no OAuth / social sign-in, no passkeys (WebAuthn), and
  no magic-link factor. The auth battery is email + password + TOTP. Don't reach
  for those flows yet.

## See it run

[`examples/estate`](https://github.com/lesto-run/lesto/tree/main/examples/estate)
puts it together: an auth-aware static marketing zone and a dynamic authed app on
one origin, sharing one session across Node (`sqlSessionStore`) and Cloudflare
(`SignedSessions`).

Related: [Authorization](/batteries/authz) for who-can-do-what once a user is
signed in, and [Deploy to Cloudflare](/deploy/cloudflare) for running the edge
session tier in Worker isolates.

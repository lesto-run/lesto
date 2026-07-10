# Migrating a password database to the edge

Lesto hashes passwords with the KDF the host runtime can bear:
**scrypt on Node**, **PBKDF2 (`crypto.subtle`) on Cloudflare Workers** — because
scrypt's ~128 MiB working set OOM-crashes the 128 MB Workers isolate. `@lesto/auth`
picks this automatically (see [`packages/auth/src/runtime.ts`](../../packages/auth/src/runtime.ts)),
so a **greenfield** edge app — where the edge is the only thing that ever writes a
hash — mints and reads only PBKDF2 and needs nothing from this guide.

> **Edge PBKDF2 is pinned at 100,000 iterations — an interim floor below the OWASP
> recommendation.** Cloudflare Workers' WebCrypto hard-rejects any PBKDF2 derive above
> 100k (`cloudflare/workerd#1346`, not raisable by any compat flag), and that limit gates
> verifying as well as minting. So `@lesto/auth` mints every `pbkdf2$…` hash at exactly
> 100k on **every** runtime — the format's whole reason to exist is to run on the edge, so
> it stays edge-runnable by construction. **Be honest about the cost:** 100k
> PBKDF2-HMAC-SHA256 is ~6× below OWASP-2023's 600k recommendation, so an *exfiltrated*
> hash database is ~6× cheaper to crack offline than a 600k corpus (a per-account
> `loginRateLimiter` bounds *online* guessing but does nothing for the offline threat a
> KDF cost defends). The platform forces "not scrypt", **not** "PBKDF2" — a memory-hard
> **argon2id** via WASM fits the 128 MB isolate and would restore the lost margin, so 100k
> PBKDF2 is the current interim, not a hard ceiling on edge password security (tracked
> follow-up: an ADR to move the edge KDF to argon2id-wasm). Node deployments get
> memory-hard **scrypt** via the default facade, so this floor applies only to the
> edge-portable format, not to a Node-native deployment.

This guide is for the other two cases: you have **existing `scrypt$…` hashes** and
you want to run auth **on the edge**.

- **Migration** — a database first written by a Node deployment, now moving to Workers.
- **Hybrid** — a Node side (an admin CLI, a seed script, a cron) mints hashes with the
  default `hashPassword` (→ scrypt) that an edge front-end later reads.

## Why you can't just re-hash the column

Password hashes are **one-way**. You cannot convert a `scrypt$…` hash to a
`pbkdf2$…` hash offline — that needs the user's *plaintext* password, which only
exists for a moment at **login** or **password reset**. So there is no batch job that
rewrites the column; migration happens **as users authenticate**.

## What the edge does with a hash it can't verify

On the edge, `verifyPassword` **refuses** a `scrypt$…` hash *before* running the KDF —
attempting the derive would OOM-kill the whole isolate, which no `try/catch` can
rescue. It throws a coded `AuthError` `AUTH_KDF_UNAVAILABLE`. `@lesto/identity.login`
catches that and, by default, returns the same enumeration-safe
`IDENTITY_INVALID_CREDENTIALS` as a wrong password (see
[`onUnverifiableHash`](../../packages/identity/src/identity.ts)). So a migrated user
who has not yet been converted simply cannot sign in on the edge until their hash is
re-minted — which is what the two steps below arrange.

## Step 1 — convert on login, before cutover (shrinks the tail)

While the **Node tier is still live**, wire the migration preset so every successful
login transparently re-mints that user's hash as PBKDF2:

```ts
import { createIdentity, pbkdf2MigrationHasher } from "@lesto/identity";

const identity = createIdentity({
  db,
  secret: env.LESTO_AUTH_SECRET,
  mailer,
  verificationUrl,
  resetUrl,
  hasher: pbkdf2MigrationHasher, // verify as usual on Node; MINT PBKDF2; rehash non-PBKDF2 rows
});
```

`pbkdf2MigrationHasher` verifies exactly as production does (Node runs scrypt fine, so
existing rows still authenticate) but mints PBKDF2 and reports any non-PBKDF2 hash as
due for rehash — so the built-in rehash-on-login seam converts each user on their next
sign-in, with **no forced reset**. Leave this running for a normal login cycle and the
active-user corpus drains to PBKDF2 on its own.

> ⚠️ **Timing/enumeration during the window.** While the corpus is mixed, this hasher
> mints the login timing-decoy with PBKDF2 but verifies unconverted rows with scrypt,
> so the two costs differ — an attacker can distinguish a real *unconverted* account
> from an unknown/converted one by response time (identical error codes notwithstanding),
> worst for legacy hashes. Keep the migration window short, keep a per-account
> `loginRateLimiter` wired, and watch login latency by outcome.

## Step 2 — reset the dormant tail (covers everyone who didn't log in)

Users who don't sign in during the window still hold `scrypt$…` hashes at cutover.
Find them and send an out-of-band **password-reset** email — the reset flow never
verifies the old hash, so it works on the edge and mints PBKDF2:

```sql
-- The blast radius: accounts the edge cannot verify. Two shapes:
--   scrypt$…            — the classic Node-minted hash.
--   pbkdf2$sha256$<n>$… — a legacy OVER-CEILING PBKDF2 row (n > 100000), minted by a
--                         pre-fix build; also un-derivable on the edge and refused with
--                         the same AUTH_KDF_UNAVAILABLE.
-- Parse the iteration count NUMERICALLY — a `LIKE 'pbkdf2$sha256$6%'` prefix match is
-- WRONG (it flags edge-fine sub-ceiling rows like 60000 and MISSES over-ceiling rows
-- that don't start with 6, e.g. 150000 → a user silently stranded on the edge). Postgres:
SELECT id, email FROM users
WHERE password_hash LIKE 'scrypt$%'
   OR (
     password_hash LIKE 'pbkdf2$sha256$%'
     AND CAST(split_part(password_hash, '$', 3) AS INTEGER) > 100000
   );
```

A completed reset self-heals that account. A Node login through
`pbkdf2MigrationHasher` also walks an over-ceiling `pbkdf2$…` row **down** to 100k
automatically (the rehash-on-login seam), so the active tail drains without a reset.
Keep `onUnverifiableHash` at its safe default (`"invalid_credentials"`) so login stays
enumeration-clean throughout.

> ⚠️ **`pbkdf2MigrationHasher` is a migration tool — remove it after cutover.** Its
> rehash seam re-mints any non-100k `pbkdf2$…` row to 100k on login, which means a
> legacy 600k row is walked **down** to the weaker 100k cost. That is correct *during*
> a migration (the goal is edge-runnable hashes), but if you leave this hasher wired on
> a Node tier that is **not** migrating, every strong 600k login silently loses ~6× of
> its cost for no platform reason, with no event to audit it. On the still-Node default
> `productionHasher` this never happens (a 600k row upgrades to scrypt on Node). Wire
> `pbkdf2MigrationHasher` only for the migration window, then revert to the default.

## Optional — an in-band reset prompt (a security trade-off)

If you would rather prompt a legacy user to reset *at the login screen* instead of
emailing them, opt in:

```ts
createIdentity({ /* … */, onUnverifiableHash: "require_reset" });
```

Now the edge returns the distinct `IDENTITY_PASSWORD_RESET_REQUIRED`, which your app
routes straight to the reset screen. **The cost:** this is an *unauthenticated*
account-existence oracle — an attacker learns which emails are registered-but-legacy
without knowing any password (a strict superset of the existing
`IDENTITY_EMAIL_NOT_VERIFIED` leak). It is bounded and self-healing (it shrinks as
users reset), but choose it only when the UX outweighs the leak for your threat model.

## Greenfield / hybrid checklist

- **New edge app?** Nothing to do — you already mint and read PBKDF2 everywhere.
- **Hybrid (Node writes, edge reads)?** Pin PBKDF2 on the Node writer so the edge never
  meets a scrypt hash: mint with `hashPasswordWeb` from `@lesto/auth`, or run the Node
  writer through `pbkdf2MigrationHasher`.
- **Recovery codes (TOTP break-glass)** ride the same KDF. A scrypt-hashed recovery
  code can't be verified on the edge; it fails closed (treated as an invalid code). A
  password reset does **not** heal recovery codes — `resetPassword` re-mints only the
  *password* hash, and recovery-code hashes are one-way (there is no plaintext to
  re-hash). A migrated user whose recovery codes were minted on Node must
  **re-enroll TOTP** (`confirmTotp`), which mints fresh PBKDF2 recovery codes. If your
  migration window is long, prefer shrinking the scrypt recovery-code tail the same way
  as passwords — keep users signing in / re-enrolling on the Node tier before cutover.

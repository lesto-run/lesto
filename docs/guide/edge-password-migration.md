# Migrating a password database to the edge

Lesto hashes passwords with the KDF the host runtime can bear:
**scrypt on Node**, **PBKDF2 (`crypto.subtle`) on Cloudflare Workers** — because
scrypt's ~128 MiB working set OOM-crashes the 128 MB Workers isolate. `@lesto/auth`
picks this automatically (see [`packages/auth/src/runtime.ts`](../../packages/auth/src/runtime.ts)),
so a **greenfield** edge app — where the edge is the only thing that ever writes a
hash — mints and reads only PBKDF2 and needs nothing from this guide.

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

## Step 2 — reset the dormant tail (covers everyone who didn't log in)

Users who don't sign in during the window still hold `scrypt$…` hashes at cutover.
Find them and send an out-of-band **password-reset** email — the reset flow never
verifies the old hash, so it works on the edge and mints PBKDF2:

```sql
-- the blast radius: accounts still on a scrypt hash
SELECT id, email FROM users WHERE password_hash LIKE 'scrypt$%';
```

A completed reset self-heals that account. Keep `onUnverifiableHash` at its safe
default (`"invalid_credentials"`) so login stays enumeration-clean throughout.

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
- **Recovery codes** ride the same KDF. A scrypt-hashed recovery code can't be verified
  on the edge either; it fails closed (treated as an invalid code). A password reset
  re-mints the user's recovery codes as PBKDF2 too.

---
title: Auth
description: Registration, email verification, login, password reset, and two-factor TOTP — with sessions that work on both Node and the edge.
section: Batteries
order: 3
---

# Auth

`@lesto/identity` is the full account lifecycle — register, verify, login, reset
— built on `@lesto/auth`'s primitives: scrypt password hashing (fixed key length,
fail-closed), signed and database-backed sessions, and TOTP two-factor.

## Identity

`createIdentity` wires the account flows over your database and a mailer:

```ts
import { createIdentity } from "@lesto/identity";

const identity = createIdentity({ db, mailer, secret });

await identity.register({ email, password });   // sends a verification email
const { session } = await identity.login(email, password);
```

The secret-strength guard rejects a weak signing secret at construction, so a
misconfigured deployment fails closed rather than signing sessions with a guessable key.

## Two-factor

TOTP and single-use recovery codes are built in:

```ts
await identity.verifyTotpChallenge(user.id, code);
await identity.verifyRecoveryCode(user.id, code);
```

## Sessions on both tiers

`@lesto/auth` ships two session strategies so the same app authenticates on a
long-lived Node server and on the ephemeral Cloudflare edge:

- **`sqlSessionStore`** — server-side sessions in your database, revocable.
- **`SignedSessions`** — stateless signed tokens that verify anywhere the secret
  is known, the right fit for per-PoP Worker isolates (keep TTLs short, since
  there is no central store to revoke against).

## See it run

[`examples/estate`](https://github.com/lesto-run/lesto/tree/main/examples/estate)
puts it together: an auth-aware static marketing zone and a dynamic authed app on
one origin, sharing one session across Node and Cloudflare.

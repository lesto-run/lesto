# @lesto/identity

> Batteries-included auth — register / verify / login / reset on your SQL database.

Part of **[Lesto](https://lesto.run)**, the batteries-included, agent-native fullstack framework.

```bash
bun add @lesto/identity
```

```ts
import { createIdentity, identityMigrations } from "@lesto/identity";
import { Migrator } from "@lesto/migrate";

// Install the REQUIRED migration set — see the callout below.
await new Migrator(db, identityMigrations).migrate();

const identity = createIdentity({
  db,
  secret: env.LESTO_AUTH_SECRET,
  mailer: { sendVerificationEmail, sendPasswordResetEmail },
  verificationUrl: (token) => `https://app.com/verify?token=${token}`,
  resetUrl: (token) => `https://app.com/reset?token=${token}`,
});

await identity.register("ada@example.com", "correct horse battery staple");
await identity.verifyEmail(tokenFromLink);
// login() returns a discriminated union — a session is never minted on the
// password alone when the account has a confirmed second factor.
const result = await identity.login("ada@example.com", "correct horse battery staple");
if (result.status === "authenticated") {
  // result.session — signed in
} else {
  // result.status === "totp_required": complete with
  // identity.completeTotpChallenge(result.challenge, code)
}
```

> **Always install `identityMigrations`, not a hand-picked subset.** `login()`
> reads the caller's confirmed-factor state on *every* call — even for an app
> that never enrolls anyone in 2FA — so a deployment missing the
> `totp_factors` table gets a raw, uncoded driver error ("no such table:
> totp_factors") the first time a password verifies. `identityMigrations` is
> the ordered `[usersMigration, totpMigration, userRolesMigration]` bundle
> that makes forgetting a required table impossible; the individual exports
> remain available for composing a custom migration order.

Composes `@lesto/auth` (scrypt hashing, store-backed sessions, signed tokens),
`@lesto/db` + `@lesto/migrate` (the `users` schema), and `@lesto/csrf`. Mail is
injected as an interface, so the package stays decoupled from any one transport.

[Docs](https://docs.lesto.run) · [Example](../../examples/estate)

# @lesto/identity

> Batteries-included auth — register / verify / login / reset on your SQL database.

Part of **[Lesto](https://lesto.run)**, the batteries-included, agent-native fullstack framework.

```bash
bun add @lesto/identity
```

```ts
import { createIdentity } from "@lesto/identity";

const identity = createIdentity({
  db,
  secret: env.LESTO_AUTH_SECRET,
  mailer: { sendVerificationEmail, sendPasswordResetEmail },
  verificationUrl: (token) => `https://app.com/verify?token=${token}`,
  resetUrl: (token) => `https://app.com/reset?token=${token}`,
});

await identity.register("ada@example.com", "correct horse battery staple");
await identity.verifyEmail(tokenFromLink);
const { session } = identity.login("ada@example.com", "correct horse battery staple");
```

Composes `@lesto/auth` (scrypt hashing, store-backed sessions, signed tokens),
`@lesto/db` + `@lesto/migrate` (the `users` schema), and `@lesto/csrf`. Mail is
injected as an interface, so the package stays decoupled from any one transport.

[Docs](https://docs.lesto.run) · [Example](../../examples/estate)

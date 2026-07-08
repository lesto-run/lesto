# @lesto/mail

> Queued, transport-agnostic email built on @lesto/queue.

Part of **[Lesto](https://lesto.run)**, the batteries-included, agent-native fullstack framework.

```bash
bun add @lesto/mail
```

```ts
import { Mailer } from "@lesto/mail";

const mailer = new Mailer({ queue, transport, render, defaultFrom: "hi@app.com" });

const welcome = mailer.template("welcome", (p: { to: string; name: string }) => ({
  to: p.to,
  subject: "Welcome",
  react: <Welcome name={p.name} />,
}));

welcome.send({ to: "ada@example.com", name: "Ada" }); // typed; enqueued; a worker delivers it
```

Bring your own renderer via the `render` hook (e.g. react-email in one line) —
the package depends on neither React nor react-email. Two transports ship:
`createSmtpTransport` (Node) and `createFetchProviderTransport` (Workers-compatible).

[Docs](https://docs.lesto.run) · [Example](../../examples/mailing-lists)

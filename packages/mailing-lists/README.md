# @lesto/mailing-lists

> Ghost-style subscriber lists — double opt-in and resumable broadcasts.

Part of **[Lesto](https://lesto.run)**, the batteries-included, agent-native fullstack framework.

```bash
bun add @lesto/mailing-lists
```

```ts
import { createMailingLists, insertList } from "@lesto/mailing-lists";

const list = await insertList(db, { name: "Weekly" });
const lists = createMailingLists({
  db,
  mailer,
  confirmationMailer: { name: "confirm", confirmUrl: (t) => `https://x.com/confirm/${t}` },
  unsubscribeUrl: (t) => `https://x.com/unsubscribe/${t}`,
});

const sub = await lists.subscribe(list.id, "ada@example.com"); // pending; confirm email enqueued
await lists.confirm(sub.confirmToken!);                         // → subscribed
await lists.broadcast(list.id, "digest", { issue: 42 });       // → resumable broadcast
```

Composes `@lesto/db`, `@lesto/mail`, and `@lesto/queue`. The package opens no
database and holds no request context — hand it a `Db` and a `Mailer`.
Rate-limit the HTTP boundary that fronts `subscribe`.

[Docs](https://docs.lesto.run) · [Example](../../examples/mailing-lists)

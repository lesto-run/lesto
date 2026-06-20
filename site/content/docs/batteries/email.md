---
title: Email & mailing lists
description: Transport-agnostic transactional email, plus double-opt-in mailing lists with confirmation, unsubscribe, and broadcasts.
section: Batteries
order: 8
---

# Email & mailing lists

`@lesto/mail` sends transactional email through a transport you choose;
`@lesto/mailing-lists` builds double-opt-in lists and broadcasts on top of it.

## Sending mail

The `Mailer` is transport-agnostic — SMTP on Node, a fetch-based provider on the
edge — and queues delivery so a send never blocks a request:

```ts
const welcome = mailer.template("welcome", ({ name }: { name: string }) => ({
  subject: `Welcome, ${name}`,
  html: `<p>Glad you're here, ${name}.</p>`,
}));

await welcome.send({ name: "Ada" });
```

## Mailing lists

`createMailingLists(db, mailer, options)` gives you subscribe → confirm →
broadcast → unsubscribe, each backed by a token. A subscribe enqueues a
confirmation email and stays `pending` until the link is clicked:

```ts
const lists = createMailingLists(db, mailer, { unsubscribeUrl });

await lists.subscribe(listId, "ada@example.com"); // 202 — confirmation sent
await lists.confirm(token);                        // double opt-in
await lists.broadcast(listId, "digest", { issue: 7 });
await lists.unsubscribe(token);
```

Invalid input raises a coded `MAILING_LIST_*` error you map at the boundary. See
the runnable [`examples/mailing-lists`](https://github.com/lesto-run/lesto/tree/main/examples/mailing-lists),
which pairs this with the **[Queue](/batteries/queue)** for rate-limited delivery.

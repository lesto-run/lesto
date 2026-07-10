---
title: "Mailing lists"
description: "Ghost-style subscriber lists for Lesto: named lists joined by double opt-in, and resumable broadcasts that fan a templated email out to every confirmed recipient over a durable per-recipient delivery ledger."
section: Batteries
order: 11
---

# Mailing lists

`@lesto/mailing-lists` is a Ghost-style subscriber layer: named lists people join
by double opt-in, and broadcasts that fan a templated email out to every
confirmed recipient. It composes the other batteries — [`@lesto/db`](/batteries/data)
holds the rows, [`@lesto/mail`](/batteries/email) renders and sends,
[`@lesto/queue`](/batteries/queue) is the durable enqueue beneath the mailer.
The core idea is a **per-recipient delivery ledger**: every intended recipient
is written to the database before any email is enqueued, so a fan-out that
crashes mid-flight resumes from exactly the rows it never finished — never
double-sending.

The package opens no database and holds no request context. You hand
`createMailingLists` a `Db` and a `Mailer`, and it returns a service.

## Create the service

`createMailingLists` is a closure factory (the same shape as `@lesto/identity`):
no `this`, no inheritance, everything captured in scope. Run the migration once,
then build the service:

```ts
import { Migrator } from "@lesto/migrate";
import { createMailingLists, mailingListsMigration, insertList } from "@lesto/mailing-lists";

await new Migrator(sql, [mailingListsMigration]).migrate();

const lists = createMailingLists({
  db,
  mailer,
  // When set, `subscribe` enqueues this template with `{ to, confirmUrl }`.
  confirmationMailer: { name: "confirm", confirmUrl: (t) => `https://app.com/confirm/${t}` },
  // When set, every broadcast email carries List-Unsubscribe headers.
  unsubscribeUrl: (t) => `https://app.com/unsubscribe/${t}`,
});

const weekly = await insertList(db, { name: "Weekly digest" });
```

`mailingListsMigration` creates four tables — `lists`, `subscribers`,
`broadcasts`, `broadcast_deliveries` — and their indexes, rendering DDL for
whichever dialect the migrator runs against. `confirmationMailer` and
`unsubscribeUrl` are both optional; `token` (the token generator, random by
default) and `chunkSize` (delivery rows per transaction, default `1000`) round
out `MailingListsOptions`.

## Double opt-in

`subscribe` upserts a `pending` row carrying a fresh, single-use confirm token,
and — when a `confirmationMailer` is configured — enqueues the opt-in email.
`confirm` flips that row to `subscribed` and rotates the token so the link is
single-use; `unsubscribe` flips it to `unsubscribed`.

```ts
const sub = await lists.subscribe(weekly.id, "ada@example.com"); // pending; confirm email enqueued
await lists.confirm(sub.confirmToken!);                          // → subscribed; token cleared
await lists.unsubscribe(sub.unsubscribeToken!);                 // → unsubscribed
```

Re-subscribing the same address is an **upsert**, never a duplicate — the same
row is reset to `pending` with new tokens, backed by a `UNIQUE (list_id, email)`
index. `confirm` and `unsubscribe` throw a `MailingListError` with code
`MAILING_LIST_INVALID_TOKEN` when no row matches the presented token, and
`subscribe` throws `MAILING_LIST_INVALID_EMAIL` if the address fails a syntactic
shape check before it is stored. Your `confirm` mailer template is an ordinary
[`@lesto/mail`](/batteries/email) template that receives `{ to, confirmUrl }`.

## Broadcasts

`broadcast` records a `broadcasts` row, writes one `broadcast_deliveries` row per
subscribed recipient in chunked transactions, then enqueues a mail job per
pending delivery. It returns the new broadcast id and how many jobs this run
enqueued:

```ts
const { broadcastId, enqueued } = await lists.broadcast(weekly.id, "digest", { issue: 42 });
```

The recipient set is durably recorded *before* any email goes out, so the ledger
already knows every intended recipient and which ones are still `pending`. Each
delivery is enqueued and only then marked `enqueued`; a crash between the two
leaves the row `pending`. Because deliveries are written first, a half-finished
fan-out is recoverable:

```ts
await lists.resumeBroadcast(broadcastId); // enqueues only still-pending rows; idempotent
```

`resumeBroadcast` re-enqueues just the `pending` rows for that broadcast — run it
after the broadcast already finished and it enqueues nothing. It throws
`MAILING_LIST_UNKNOWN_BROADCAST` if the id has no row. A `UNIQUE
(broadcast_id, subscriber_id)` index means a resumed fan-out can never double-insert
a recipient.

## The model helpers

The service is the high-level API, but the underlying schema values and query
helpers are exported too — for an admin view, a metrics scan, or a custom flow.
They all take an explicit `db`:

```ts
import { subscribedRecipients, pendingBroadcastDeliveries, findBroadcastById } from "@lesto/mailing-lists";

const recipients = await subscribedRecipients(db, weekly.id);   // confirmed only
const stuck = await pendingBroadcastDeliveries(db, broadcastId); // not yet enqueued
const row = await findBroadcastById(db, broadcastId);            // Broadcast | undefined
```

The `lists`, `subscribers`, `broadcasts`, and `broadcastDeliveries` table values
are plain [`@lesto/db`](/batteries/data) `defineTable` schemas; `SubscriberStatus`
(`pending` → `subscribed` → `unsubscribed`), `BroadcastStatus`, and
`DeliveryStatus` are the string unions their `status` columns hold.

## Notes and gotchas

- **Rate-limit `subscribe` at the HTTP boundary.** It is unauthenticated by
  nature — anyone may join a list — and it both writes a row and enqueues an
  email, which makes it a spam amplifier if exposed raw. This package has no
  request context, so it does **not** rate-limit. Wrap the route that fronts it
  with `@lesto/ratelimit`, keyed by IP and/or email. Double opt-in blunts
  list-bombing (an unconfirmed address never receives a broadcast), but the
  confirmation send is still yours to throttle.
- **Delivery is at-least-once.** Enqueue-then-mark means a crash between the two
  re-enqueues that recipient on resume — the same floor the
  [queue](/batteries/queue) and mailer already document. An idempotent transport
  dedupes on the mailer's stable `messageId`.
- **Unsubscribe headers need a cooperative template.** When `unsubscribeUrl` is
  set, each broadcast's per-recipient params carry a `headers` object holding
  `List-Unsubscribe` / `List-Unsubscribe-Post` (the Gmail/Yahoo bulk-sender
  one-click requirement). Your broadcast template must spread `params.headers`
  into the email it returns, or the headers are silently dropped.
- **Status values aren't DB-enforced.** `@lesto/db` has no runtime enum
  constraint today; the `SubscriberStatus` / `BroadcastStatus` / `DeliveryStatus`
  unions narrow at the API boundary, and the column stores whatever string the
  call site passes. The `UNIQUE` indexes — not a CHECK — are the integrity guard.
- **Confirm tokens are single-use; unsubscribe tokens are long-lived.** `confirm`
  clears the confirm token on success, so a replayed confirmation link no longer
  matches a pending row. The unsubscribe token persists for the life of the
  subscriber and doubles as the value behind the `List-Unsubscribe` header.
- **Branch on `code`, never the message.** `MailingListError` carries a stable
  `MailingListErrorCode`; the human-facing message is free to change.

For the template and transport mechanics these lists build on, see
[Email](/batteries/email); for the schema and query primitives, see [Data](/batteries/data).

---
title: Email & mailing lists
description: Transport-agnostic transactional email, plus double-opt-in mailing lists with confirmation, unsubscribe, and broadcasts.
section: Batteries
order: 8
---

# Email & mailing lists

`@lesto/mail` sends transactional email through a transport you choose, queueing
every delivery so a send never blocks a request. `@lesto/mailing-lists` builds
double-opt-in subscriber lists and resumable broadcasts on top of it. Neither
package opens a database or holds request state — you hand them a `Queue`, a
transport, and (for lists) a `Db`, and they return a service.

## Sending mail

A `Mailer` defines emails as functions of their params and sends them by name.
`mailer.template(name, build)` registers the template and returns a typed
sender, so a wrong-shaped payload is a compile error:

```ts
import { Mailer } from "@lesto/mail";

const mailer = new Mailer({ queue, transport, defaultFrom: "hi@app.com" });

const welcome = mailer.template(
  "welcome",
  (p: { to: string; name: string }) => ({
    to: p.to,
    subject: `Welcome, ${p.name}`,
    html: `<p>Glad you're here, ${p.name}.</p>`,
    text: `Glad you're here, ${p.name}.`,
  }),
);

await welcome.send({ to: "ada@example.com", name: "Ada" }); // enqueued; returns the job id
```

Calling `welcome.send(...)` enqueues a job on `@lesto/queue` and returns
immediately; a queue worker later builds, renders, and delivers the email. An
`Email` needs a `to` and a `subject`, plus a body — a ready `html` string, or a
`react` element rendered by an injected `render` hook (wire `@react-email/render`
in one line). Supplying both `html` and `text` makes the transport emit a
`multipart/alternative` body. `mailer.define(name, build)` registers a template
without the typed handle, and `mailer.send(name, params)` dispatches by string
key — reach for it only when the template name is dynamic.

### Transports

Three real transports ship; all implement the same `MailTransport` interface, so
the same templates deliver through any of them:

```ts
import {
  createSmtpTransport,
  createFetchProviderTransport,
  createCloudflareEmailTransport,
} from "@lesto/mail";

// Node only — speaks raw TCP/TLS over node:net / node:tls.
const smtp = createSmtpTransport({
  host: "smtp.example.com",
  port: 587,
  auth: { user: "apikey", pass: process.env.SMTP_PASS! },
});

// Workers-compatible — uses only global fetch (Resend / SES-HTTP shaped).
const provider = createFetchProviderTransport({
  endpoint: "https://api.resend.com/emails",
  apiKey: process.env.RESEND_KEY!,
  defaultFrom: "hi@app.com",
});

// Workers only — drives Cloudflare Email Sending's `send_email` binding. No API keys.
const cloudflare = createCloudflareEmailTransport({
  binding: env.EMAIL,
  defaultFrom: "hi@app.com",
});
```

Use `createSmtpTransport` on a Node server. On the edge, pick
`createFetchProviderTransport` for an HTTP provider (Resend, SES), or
`createCloudflareEmailTransport` to send through the platform itself — it drives
the Worker's `send_email` binding directly, so there is no API key to manage. The
sender domain must be onboarded to Cloudflare Email Sending first
(`wrangler email sending enable <domain>` plus the SPF/DKIM/DMARC DNS records);
until then the binding rejects the send and the transport surfaces it as a coded
`CloudflareEmailError`, so the queue retries instead of dropping the mail.

Delivery is **at-least-once**: every rendered email carries a stable,
job-derived `messageId` (sent as the SMTP `Message-ID` and the provider's
`Idempotency-Key`) so an idempotent transport collapses retried sends into one.
The Cloudflare binding exposes no idempotency key, so a retried job there can
deliver twice — the accepted floor for transactional mail.

### Delivery events

Pass `onDelivered` / `onFailed` to the `Mailer` to watch deliveries without
reading the queue. Both payloads are PII-free — mailer name, job id, attempt,
and (on failure) a coded reason, never the recipient or body — so they are safe
to forward to a log line or a span:

```ts
const mailer = new Mailer({
  queue,
  transport,
  onDelivered: ({ mailerName, jobId, attempt }) => log.info("mail.sent", { mailerName, jobId, attempt }),
  onFailed: ({ mailerName, code }) => log.warn("mail.failed", { mailerName, code }),
});
```

A throw inside either hook is swallowed — a broken sink can neither fail nor
retry a delivery.

## Mailing lists

`createMailingLists(options)` gives you the classic confirmed-subscription dance —
`subscribe` → `confirm` → `broadcast` → `unsubscribe` — each step backed by a
one-shot or long-lived token. You hand it a `Db`, a `Mailer`, and the URL
builders for your confirm and unsubscribe links:

```ts
import { createMailingLists, insertList } from "@lesto/mailing-lists";

const lists = createMailingLists({
  db,
  mailer,
  confirmationMailer: {
    name: "confirm", // a registered mailer template, called with { to, confirmUrl }
    confirmUrl: (token) => `${baseUrl}/confirm/${token}`,
  },
  unsubscribeUrl: (token) => `${baseUrl}/unsubscribe/${token}`,
});

const list = await insertList(db, { name: "Weekly Digest" });

const sub = await lists.subscribe(list.id, "ada@example.com"); // status "pending"; confirm email enqueued
await lists.confirm(sub.confirmToken!);                         // status "subscribed"; confirm token rotated away
await lists.broadcast(list.id, "digest", { issue: 7 });        // → { broadcastId, enqueued }
await lists.unsubscribe(sub.unsubscribeToken!);                // status "unsubscribed"
```

`subscribe` upserts a `pending` subscriber holding a fresh confirm token and, if
a `confirmationMailer` is configured, enqueues the opt-in email — a second
subscribe of the same address resets the same row, never a duplicate. `confirm`
flips that row to `subscribed` and clears the spent confirm token so the link is
single-use. `broadcast(listId, mailerName, params)` records a `broadcasts` row
plus one delivery row per recipient in chunked transactions, then enqueues a mail
job per pending delivery, returning a `BroadcastResult` of `{ broadcastId,
enqueued }`. A crash mid-fan-out leaves the unsent rows `pending`;
`resumeBroadcast(broadcastId)` (or a fresh `broadcast`) picks up exactly those, so
no recipient is enqueued twice. When `unsubscribeUrl` is set, each broadcast email
carries `List-Unsubscribe` / `List-Unsubscribe-Post` headers (a Gmail/Yahoo
bulk-sender requirement) under `params.headers` — the broadcast template must
spread them into the email it returns.

`subscribe`, `confirm`, and `unsubscribe` return the updated `Subscriber`, whose
`status` is one of `"pending"`, `"subscribed"`, or `"unsubscribed"`.

## Errors

Bad input raises a coded `MailingListError` you branch on at the HTTP boundary —
never on the message string:

```ts
import { MailingListError } from "@lesto/mailing-lists";

try {
  await lists.subscribe(listId, email);
} catch (error) {
  if (error instanceof MailingListError && error.code === "MAILING_LIST_INVALID_EMAIL") {
    return c.json({ error: error.message }, 422);
  }
  throw error;
}
```

The codes are `MAILING_LIST_INVALID_EMAIL` (a subscribe email that fails shape
validation), `MAILING_LIST_INVALID_TOKEN` (no subscriber matched a presented
confirm or unsubscribe token — map to a 404), and `MAILING_LIST_UNKNOWN_BROADCAST`
(a `resumeBroadcast` id with no row). The email shape check is a syntactic guard,
not RFC 5322 — the real proof an address exists is the confirmation round-trip.

## Notes and gotchas

- **Queued delivery never blocks the request.** `send` and `broadcast` only
  *enqueue*; a queue worker does the rendering and transport I/O. Run a worker
  (or drain the queue) or nothing is delivered.
- **`subscribe` is an abuse amplifier — rate-limit it.** It is unauthenticated by
  nature and sends an email per call. The package has no request context, so the
  HTTP handler fronting it MUST apply `@lesto/ratelimit` (keyed by IP and/or
  email) before calling it.
- **Broadcasts pair with the [Queue](/batteries/queue).** Fan-out is one job per
  recipient, so the queue's concurrency and backoff give you rate-limited delivery
  for free, and `resumeBroadcast` rides the queue's at-least-once floor.

## Where to go next

- [Mailing lists](/batteries/mailing-lists) — the delivery ledger, the schema, and the model helpers in depth.
- [Queue](/batteries/queue) — the durable enqueue every send rides on.
- Runnable examples: [`examples/mailing-lists`](https://github.com/lesto-run/lesto/tree/main/examples/mailing-lists)
  exposes the whole journey as real HTTP routes;
  [`examples/mail`](https://github.com/lesto-run/lesto/tree/main/examples/mail)
  runs the mailer on Cloudflare — a D1-backed queue delivering through Email Sending.

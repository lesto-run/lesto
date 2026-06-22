---
title: Adopt one battery
description: You don't have to switch frameworks. Pull a single Lesto battery — like the durable queue — into your existing Node, Express, or Next app.
section: Migrate
order: 2
---

# Adopt one battery

Switching frameworks is a big decision. Adopting one battery is not. Lesto's
batteries depend on **interfaces** — a database handle, a transport — not on the
framework, so you can pull a single one into an app you already have. This guide
adds the durable job queue (`@lesto/queue`) to a plain Node app; the same pattern
works for cache, mail, and auth.

## Why the queue first

If your app sends email, resizes images, calls a flaky third-party API, or does
anything you don't want to block a request on, you need a job queue. The usual
answer is BullMQ + a Redis to run and pay for. `@lesto/queue` is a durable queue
**on the database you already have** — at-least-once delivery with
visibility-timeout reclaim, no broker. A worker killed mid-job (a deploy) releases
it, and another worker reclaims and completes it.

## Add it to an existing app

Install the queue and a database driver (skip the driver if your app already has
one — the queue takes any Lesto `SqlDatabase` handle):

```sh
npm install @lesto/queue @lesto/runtime better-sqlite3
```

Open a database handle and install the queue's table once on boot:

```ts
import { openSqlite } from "@lesto/runtime";
import { installSchema, Queue } from "@lesto/queue";

const { db } = await openSqlite("app.db"); // or openPostgres(...) at scale
await installSchema(db);                    // creates the jobs table (idempotent)

const queue = new Queue({ db });
```

Define what a job does, once, at startup:

```ts
queue.define("send_welcome_email", async ({ userId }: { userId: number }) => {
  const user = await loadUser(userId);
  await sendEmail(user.email, "Welcome!");
});
```

Enqueue from anywhere in your existing code — your Express route, your Next route
handler, a webhook — and return immediately:

```ts
// inside whatever handler you already have:
await queue.enqueue("send_welcome_email", { userId: user.id });
res.status(202).json({ ok: true }); // the email sends out of band
```

## Run a worker

A job is durable the moment it's enqueued, but something has to drain the queue.
Run a worker — in the same process for local dev, or a separate process in
production so a web deploy never interrupts a job:

```ts
// worker.ts — run with `node worker.ts` (or your runtime)
import { openSqlite } from "@lesto/runtime";
import { Queue } from "@lesto/queue";

const { db } = await openSqlite("app.db");
const queue = new Queue({ db });

queue.define("send_welcome_email", async ({ userId }) => {
  /* same handler as above */
});

const worker = queue.work(); // drains forever

// Graceful shutdown: stop pulling new jobs, let in-flight ones finish.
process.on("SIGTERM", () => void worker.stop());
```

That's the whole integration. No Redis, no broker, no schema you maintain by
hand — the jobs live in a table next to your data, so you can query them, and a
transaction that enqueues a job commits atomically with the rest of your write.

## The same shape for other batteries

Every battery is adopted the same way — give it a handle or a transport, not your
framework:

- **`@lesto/cache`** — `cache.fetch(key, ttl, fn)` over the same `db` (or in-memory).
- **`@lesto/mail`** — react-email templates with queued delivery on `@lesto/queue`.
- **`@lesto/auth`** — password hashing, tokens, and sessions on `node:crypto`.
- **`@lesto/webhooks`** — HMAC-signed outbound delivery, retried on the queue.

## When to graduate to the full framework

Once you're running two or three batteries and threading the same database handle
through your routes, you're most of the way to a Lesto app. That's the moment the
[From Express](/migrate/express) or [From Next.js](/migrate/nextjs) port pays for
itself — one app surface, one config, batteries already wired. Until then, adopt
exactly what you need.

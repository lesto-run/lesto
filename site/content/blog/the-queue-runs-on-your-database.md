---
title: The queue runs on your database — no Redis
description: How Lesto's durable job queue lives on the SQL database you already have, and why that's the right default.
date: "2026-06-22"
author: The Lesto team
---

# The queue runs on your database — no Redis

Most JavaScript backends reach for Redis the moment they need a job queue. It's a
second piece of infrastructure to provision, secure, monitor, and pay for — and a
second source of truth that can drift from your database.

Lesto's queue (`@lesto/queue`) runs on **the SQL database you already have**.
SQLite for zero-config local, Postgres at scale. No broker.

## How it stays durable

The queue is a small, well-understood primitive — the same pattern Rails 8's Solid
Queue and `pgmq` use:

- A job is a row. Enqueuing it is an ordinary insert, so it commits **atomically**
  with the rest of your transaction. If the surrounding write rolls back, the job
  was never enqueued — no half-states.
- A worker claims jobs with a row-level lock and a **visibility timeout**. If a
  worker dies mid-job — say, a deploy kills it — the claim expires and another
  worker reclaims and re-runs the job. **At-least-once delivery**, so jobs are
  idempotent by convention.

```ts
import { Queue } from "@lesto/queue";

const queue = new Queue({ db });
queue.define("send_welcome_email", async ({ userId }) => {
  await sendWelcomeEmail(userId);
});

await queue.enqueue("send_welcome_email", { userId: 42 });
const worker = queue.work(); // drains forever; worker.stop() drains gracefully
```

## Why on the database

One substrate is the whole idea behind Lesto. The queue, cache, and pub/sub all
live on the database, so there's one thing to reason about, one thing to back up,
and nothing to keep in sync. You can `SELECT` your pending jobs. A transaction
spans your data and your jobs together.

When you genuinely outgrow it, the driver seam lets a specialized store slot in
under the same API — but most apps never need to, and you don't pay for Redis on
day one to find out.

Adopting just the queue into an existing app? See
[Adopt one battery](/migrate/adopt-a-battery). The full surface is in the
[Queue battery docs](/batteries/queue).

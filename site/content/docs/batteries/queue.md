---
title: Queue
description: A database-backed background job queue with exactly-once delivery, retries, batches, and an operator dashboard.
section: Batteries
order: 1
---

# Queue

`@lesto/queue` is a background job queue backed by your database — no Redis, no
broker. It claims jobs with `FOR UPDATE SKIP LOCKED` on Postgres (and the
equivalent on SQLite), reclaims jobs whose worker died, and fences completion so
a job runs **exactly once**. That guarantee is proven against real Postgres in CI.

## Install and enqueue

```ts
import { Queue, installSchema } from "@lesto/queue";

await installSchema(db);
const queue = new Queue(db);

await queue.enqueue("send-welcome-email", { userId: 42 });
await queue.enqueue("flaky-task", {}, { maxAttempts: 1 });
```

## Process

A worker pulls ready jobs and runs your handler. Failures retry with backoff up
to `maxAttempts`, then land in the dead-letter state:

```ts
const worker = queue.work({
  onJob: async (job) => {
    // ... handle job.name with job.payload ...
  },
});
```

For tests and single-shot drains, `queue.runOnce({ onJob })` processes one pass
without starting the loop.

## Batches and dependencies

`enqueueBatch` enqueues a set of steps with dependencies — a step is `blocked`
until the steps it depends on complete, then becomes `ready` automatically. The
queue also ships a scheduler for cron-style recurring jobs and a retention
sweeper for finished-job cleanup.

## The dashboard

[`examples/queue-dashboard`](https://github.com/lesto-run/lesto/tree/main/examples/queue-dashboard)
is a full operator dashboard — jobs, attempts, retries, the dead-letter queue,
and batch dependencies — built from `@lesto/queue`'s observability seam.

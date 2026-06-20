---
title: Queue
description: A database-backed background job queue with exactly-once delivery, retries, batches, and an operator dashboard.
section: Batteries
order: 2
---

# Queue

`@lesto/queue` is a background job queue backed by your SQL database — no Redis,
no broker, no second piece of infrastructure to run. A worker _claims_ a job
atomically, stamps a visibility deadline, runs your handler, then _fences_ the
terminal write on the claim it took. On Postgres the claim carries
`FOR UPDATE SKIP LOCKED` so concurrent workers each grab a distinct row; on
SQLite the runtime serializes every write over its single connection, so the
same `UPDATE … RETURNING` is already atomic. If a worker dies mid-job — a deploy
`SIGKILL`s the pod — the row lingers in `running` until its deadline lapses, then
a reclaim sweep returns it to `ready` for another worker. Work is never lost.

The contract is **at-least-once delivery with exactly-once completion**: a job
is processed to a terminal state once and only once, because the fence rejects
any stale worker's write. Write idempotent handlers and you get exactly-once
semantics end to end. The guarantee is proven against real Postgres in CI.

## Install and enqueue

Create the tables once (idempotent — run it from a migration or at boot), then
construct a `Queue` over your database handle. Pass `dialect: "postgres"` to
**both** `installSchema` and `new Queue` on Postgres; they must agree, or the
locking clause is silently dropped.

```ts
import { Queue, installSchema } from "@lesto/queue";

await installSchema(db); // dialect defaults to "sqlite"
const queue = new Queue({ db });

// Register a handler for each job name.
queue.define("send-welcome-email", async (payload: { userId: number }) => {
  await mailer.sendWelcome(payload.userId);
});

// Enqueue work. The id comes back so you can track it.
await queue.enqueue("send-welcome-email", { userId: 42 });

// maxAttempts (default 5), priority, and delayMs/runAt are EnqueueOptions.
await queue.enqueue("flaky-task", {}, { maxAttempts: 1, delayMs: 5_000 });
```

## Process jobs

A worker polls for ready jobs and runs the handler you registered with
`define`. A handler that throws routes through retry-with-backoff up to
`maxAttempts`; once attempts are exhausted the job lands in the `failed` state —
the dead-letter queue. `work()` returns a handle that drains gracefully:

```ts
const worker = queue.work({
  concurrency: 4, // claim up to 4 jobs in parallel (default 1)
  onJob: (event) => metrics.record(event), // observability seam — see below
  onError: (error) => log.warn(error.code), // transient claim/poll faults
});

// Later, on shutdown:
await worker.stop(); // stops claiming and waits for in-flight jobs to finish
```

Backoff is exponential (`baseBackoffMs * 2 ** (attempts - 1)`, capped at
`maxBackoffMs`), and reclaim of stalled jobs runs on its own cadence
(`reclaimMs`, defaulting to the visibility window).

For tests and single-shot drains, `runOnce` claims and runs exactly one job,
returning its `RunResult` or `null` when the queue is idle — no loop, no timers:

```ts
let result;
while ((result = await queue.runOnce()) !== null) {
  // result.outcome is "done" | "retry" | "failed"
}
```

## Batches and dependencies

`enqueueBatch` writes a set of steps — and the dependency edges between them — in
one transaction, so a batch is all-or-nothing. Each step may declare `dependsOn`
as zero-based indices of _earlier_ steps. A step with dependencies starts
`blocked` (invisible to the claim); a step with none starts `ready`. As each
prerequisite reaches `done`, the dependency release flips a dependent to `ready`
once **all** of its prerequisites are settled — so a batch runs in order:

```ts
const batch = await queue.enqueueBatch("import-photo", [
  { name: "ingest", payload: { url } }, // step 0 — starts ready
  { name: "thumbnail", payload: { size: 256 }, dependsOn: [0] }, // step 1 — blocked on 0
]);

// Roll the batch's per-job statuses up to a lifecycle state.
const summary = await queue.batch(batch.id);
// summary.state is "pending" | "completed" | "failed"
```

`thumbnail` can never run before `ingest`, because the claim only ever scans
`status = 'ready'` and the blocked step is released solely by `ingest`
completing. Forward or self edges are rejected eagerly with
`QUEUE_BATCH_FORWARD_DEPENDENCY` — a cycle could never complete.

## Scheduling and retention

The `Scheduler` turns time into jobs. Register cron expressions (5-field
`min hour day month weekday`) or fixed intervals, then `start()` a cadence that
enqueues due entries. All the deciding lives in `tick(now)`, a pure function of
the clock, so it tests without real timers:

```ts
import { Scheduler } from "@lesto/queue";

const scheduler = new Scheduler({ queue });
scheduler.cron("0 9 * * *", "daily-digest"); // 9am daily
scheduler.every(60_000, "heartbeat"); // every 60s
const handle = scheduler.start();
```

> Cron de-duplication is in-process memory, not durable. Run the scheduler on a
> **single** designated instance (a leader or a one-replica deployment); two
> instances each decide the same cron is due and double-fire. The _workers_ they
> enqueue into may still be many.

Finished jobs are inert but accumulate as history. `Queue.prune(olderThanMs)`
deletes terminal (`done`/`failed`) rows past a cutoff — along with their orphaned
batch and dependency rows — in one transaction. The `RetentionScheduler` wires
that (and any other store's sweep) to a cadence in one place:

```ts
import { RetentionScheduler } from "@lesto/queue";

const DAY_MS = 86_400_000;
const retention = new RetentionScheduler({
  tasks: [{ name: "queue", everyMs: 3_600_000, run: () => queue.prune(7 * DAY_MS) }],
});
retention.start();
```

## Notes and gotchas

- **Idempotent handlers.** At-least-once means a reclaimed job can run twice
  (the first worker stalled but its work may have partly landed). Make handlers
  safe to repeat — upsert, check-before-send, dedupe on a natural key.

- **Stop retrying with `permanentFailure`.** When a failure can never succeed on
  a later attempt — a 4xx the receiver keeps returning, an SSRF-blocked URL, a
  payload no handler version can process — throw `permanentFailure(error)` from
  your handler. The queue retires the job straight to `failed` after that one
  attempt instead of burning the remaining `maxAttempts`. The marker is read
  structurally, so any package's error can opt in.

- **The `onJob` seam carries no payload.** `JobEvent` is `{ queue, id, name,
  outcome, attempt, durationMs }` — deliberately no payload body, so a sink can
  never leak job contents into a log or span. `durationMs` measures the handler
  call, not queue wait time. A throwing sink is contained and never breaks
  processing. `Queue.stats()` complements it with per-status counts plus `depth`
  (the claimable backlog) and `oldestReadyAgeMs` (the headline latency signal).

- **Errors carry codes.** Every refusal is a `QueueError` with a stable
  `QueueErrorCode` (`QUEUE_HANDLER_NOT_FOUND`, `QUEUE_POISON_PAYLOAD`,
  `QUEUE_BATCH_EMPTY`, …). Branch on the code, never the message.

For rate-limited transactional delivery built on this queue, see
[Email](/batteries/email). The full operator dashboard — jobs, attempts, the
dead-letter queue, batch dependencies, and the `onJob` observability seam — is
[`examples/queue-dashboard`](https://github.com/lesto-run/lesto/tree/main/examples/queue-dashboard).

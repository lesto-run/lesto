---
title: Node
description: Run a Lesto app as a long-lived Node server — the same app you deploy to the edge, with a process for background work.
section: Deploy
order: 1
---

# Deploy to Node

The same app that runs on Cloudflare runs as a long-lived `node:http` process.
Nothing changes about the app — only the transport in front of it. And a
long-lived process is the right home for steady, stateful work that an
edge request can't host: a background **[queue](/batteries/queue)** worker, a
cron scheduler, an OTLP flush on an interval. For the edge half of a deploy, see
**[Deploy to Cloudflare](/deploy/cloudflare)**.

## Serve

`lesto serve` boots the app and stands a hardened `node:http` server in front of
it:

```bash
lesto build            # apply migrations, bundle islands, prepare assets
lesto serve --port 3000
# listening on http://127.0.0.1:3000
```

`serve` loads your `lesto.app.ts`, runs `createApp` (which applies pending
migrations on boot), and listens. `--port` overrides the default `3000`.

The front door is the same one the edge Worker runs, so a request gets the same
treatment whether it lands on a Worker or this process:

- **Per-request context** — each request mints its own context (and, when
  tracing is on, its own span), so nothing leaks between concurrent requests.
- **Body caps** — request bodies over `1 MiB` are refused with `413` before they
  are read, with a separate, independently tunable cap for `application/json` so
  raising the upload limit never grows the `JSON.parse` blast radius.
- **Handler-timeout abort** — a handler that runs past its deadline (default
  `30s`) is aborted with a `503` instead of pinning a socket open.
- **Slow-loris limits** — header-block timeout, per-request socket deadline,
  keep-alive idle timeout, and a max header size, so a client can't hold sockets
  open by dribbling bytes.
- **SIGTERM drain** — on `SIGTERM`/`SIGINT` the server stops accepting new
  connections, lets in-flight requests finish (up to a drain window), then exits,
  so a rolling restart never severs a live request.

Every limit ships with a secure default and is retunable from the environment at
deploy time (`LESTO_MAX_BODY_BYTES`, `LESTO_HANDLER_TIMEOUT_MS`,
`LESTO_DRAIN_TIMEOUT_MS`, and friends) — an unset or invalid value always falls
through to the safe default rather than weakening it.

### A real readiness probe

`serve` wires `/readyz` to an actual database ping — `SELECT 1` against the
app's connection — not a constant `200`. If the connection is gone or the pool is
exhausted, the probe resolves false and the runtime answers `/readyz` with `503`,
so an orchestrator takes the node out of rotation until its database recovers.
(`/health` stays a bare liveness `200` — the process is up.) Point your load
balancer and your post-deploy health gate at `/readyz`.

## A worker process

The web tier should answer requests and return — it has no business running a
30-second report or retrying a failed email inline. That work belongs on a
**[queue](/batteries/queue)**, drained by a worker loop. The worker is just
`queue.work()` started after boot — in the same process as `serve`, or, more
commonly, in a second process pointed at the same database:

```ts
// worker.ts — a second long-lived process on the same DB
import { openPostgres } from "@lesto/pg";
import { Queue, Scheduler } from "@lesto/queue";

const { db, close } = await openPostgres({
  connectionString: process.env.DATABASE_URL,
});

const queue = new Queue({ db, dialect: "postgres" });

// Register a handler per job name. Handlers are expected to be idempotent —
// the queue's contract is at-least-once.
queue.define("send_email", async ({ to }) => {
  await sendEmail(to);
});
queue.define("rebuild_report", async ({ accountId }) => {
  await rebuildReport(accountId);
});

// Start draining. `work()` claims jobs atomically and runs forever; on Postgres
// concurrent workers each claim a different row (FOR UPDATE SKIP LOCKED).
const worker = queue.work({
  concurrency: 4,
  onJob: (event) => console.log(`${event.name} → ${event.outcome} in ${event.durationMs}ms`),
});

// Cron lives in the same process. The Scheduler turns time into enqueues.
const schedule = new Scheduler({ queue });
schedule.cron("0 9 * * *", "daily_digest"); // 09:00 every day
schedule.every(60_000, "heartbeat"); // every 60s
const ticking = schedule.start();

// Drain gracefully on shutdown: stop the scheduler, then let the worker finish
// its in-flight jobs.
const shutdown = async (): Promise<void> => {
  ticking.stop();
  await worker.stop();
  await close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
```

Your web tier enqueues with `queue.enqueue("send_email", { to })` during a
request and returns immediately; this process does the work. `onJob` is an
observability sink — it sees each job's outcome and `durationMs` (never the
payload), so it's the natural place to log or feed your tracer.

## Production topology

A typical production shape is three tiers over one database:

- a **Cloudflare Workers** web tier at the edge, answering requests with low
  latency;
- a long-running **Node** worker process owning the queue and the scheduler;
- one **Postgres** they both share.

The web tier enqueues; the Node process drains. They coordinate entirely through
the queue tables in Postgres — no extra broker, no message bus.

The two halves run the *same app*. You develop against local SQLite —
`openSqlite()` gives you a zero-config handle, migrations run on boot — and for
production you point the same code at Postgres by swapping the handle:
`openPostgres({ connectionString })` returns a `{ db, close }` over the same
`SqlDatabase` seam `openSqlite` does, so `createApp` and `new Queue` accept it
unchanged. Pass `dialect: "postgres"` where it matters (the queue's atomic claim
and the schema's identity columns key off it) and nothing else in your app
changes. See **[Data](/batteries/data)** for the handle and the dialect switch.

## Notes & gotchas

- **Run exactly one scheduler.** Cron de-duplication lives in the scheduler's
  in-process memory, not in the database. Two scheduler instances each decide the
  same cron is due and double-fire every scheduled job. Run the `Scheduler` on a
  single designated process (a leader or a single-replica deployment) — the queue
  *workers* it enqueues into can still be many.
- **Workers are at-least-once.** A worker that dies mid-job leaves the row to be
  reclaimed and retried after its visibility deadline. Work is never lost, but it
  can run more than once, so keep handlers idempotent.
- **Drain in order.** On shutdown, stop the scheduler first (so no new jobs are
  enqueued), then `await worker.stop()` (so in-flight jobs finish), then close the
  database. `serve` already drains its HTTP front door the same way on
  `SIGTERM` — give your worker process the matching hook.
- **Flush traces on drain.** When `LESTO_OTLP_URL` is set, `serve` flushes spans
  on a steady interval and once more on drain, so a rolling restart doesn't drop
  the final batch. See **[Observability](/batteries/observability)**.

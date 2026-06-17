# Deployment topology

Keel's pitch is "stateless web tier; state lives in the one database." That makes the
web tier trivially scalable — but the **background tier** (queue workers, the cron
scheduler, retention sweeps) is a *long-running process*, and on Cloudflare Workers
the web tier can't host it. This is the topology that reconciles "edge-first" with the
single-instance scheduler constraint.

## The three pieces

```
                         ┌─────────────────────────┐
   requests ───────────► │  Web tier (stateless)   │
                         │  Cloudflare Worker       │ ──┐
                         │  (or `keel serve` on Node)│   │
                         └─────────────────────────┘   │
                                                         ├──► one regional Postgres
                         ┌─────────────────────────┐   │     (the shared substrate:
   (no inbound traffic)  │  Worker process (Node)   │ ──┘      db · queue · cache ·
                         │  queue.work() + Scheduler │          sessions · rate limit)
                         │  + RetentionScheduler     │
                         └─────────────────────────┘
```

1. **Web tier — stateless, scale freely.** A Cloudflare Worker (`@keel/cloudflare`) or
   a Node process (`keel serve`). It only handles requests; it holds no state and runs
   no timers. Scale it to N replicas — they coordinate through the database.
2. **Worker process — long-running Node, the background tier.** Runs `queue.work()`
   (job delivery), a `Scheduler` (crons), and a `RetentionScheduler` (sweeps). A
   Cloudflare Worker **cannot** be this: it has no long-lived process and no background
   timers, so on the edge this is a separate Node process (a small VM/container, or a
   Cloudflare Container / a scheduled trigger that invokes the worker).
3. **One Postgres — the substrate both tiers share.** Jobs enqueued by the web tier are
   claimed by the worker process via `FOR UPDATE SKIP LOCKED`; sessions, cache, and
   rate-limit state are shared the same way.

## The scaling rule (and the scheduler constraint)

- **Queue workers scale horizontally.** The claim is `SKIP LOCKED`-fenced, so you can
  run many `queue.work()` replicas and each job is delivered to exactly one — proven on
  a real `postgres:16` in CI.
- **Run exactly ONE scheduler replica.** The cron de-duplication in `Scheduler` is
  **in-process memory**, not durable (`packages/queue/src/scheduler.ts`). Two scheduler
  replicas keep separate memory and would each fire every cron — double-delivery. So the
  background process that owns the `Scheduler` must be single-replica. (Durable, atomically-
  claimed cron firings are a post-1.0 item.)

This is the whole reconciliation: **"edge-first" describes the web tier; the scheduler is
single-instance because it lives in the one background process, not in the edge fleet.**

## The worker-process recipe

A minimal background entrypoint (run with `bun worker.ts` / `node`, as its own
deployment — NOT in the Worker):

```ts
import { Queue, Scheduler, RetentionScheduler } from "@keel/queue";
import { openPostgres } from "@keel/pg"; // openSqlite (from @keel/runtime) on a single Node node

// Queue takes the SqlDatabase directly (it issues raw SKIP LOCKED claims).
const { db } = await openPostgres({ connectionString: process.env.KEEL_PG_URL! });
const queue = new Queue({ db });

// 1. Deliver jobs (scale this process's replicas freely — claims are SKIP LOCKED-safe).
const worker = queue.work();

// 2. Crons + retention — SINGLE replica only (in-process cron de-dup).
const scheduler = new Scheduler({ queue });
scheduler.cron("0 * * * *", "hourly-rollup"); // register crons; each fires a named job
const handle = scheduler.start();
const retention = new RetentionScheduler({ tasks: [/* e.g. a queue-prune / cache-sweep task */] });
const sweeps = retention.start();

// 3. Graceful drain on deploy: stop timers, let in-flight jobs finish.
process.on("SIGTERM", async () => {
  handle.stop();
  sweeps.stop();
  await worker.stop();
  process.exit(0);
});
```

> `examples/mailing-lists/serve.ts` runs `queue.work()` inside the web process — fine for
> a single-node Node deploy where one process is both tiers. The moment you deploy the web
> tier to Workers (or scale it past one replica), split the background tier into its own
> single-replica process as above.

## Choosing a shape

| Deploy | Web tier | Background tier |
|---|---|---|
| **Local / single-node Node** | `keel serve` | same process (`queue.work()` in `serve.ts`) — fine |
| **Scaled Node** | N× `keel serve` | 1× worker process (the recipe above) |
| **Cloudflare Workers** | the Worker (`@keel/cloudflare`) | 1× Node worker process alongside, on one Postgres |

See [deploy-cloudflare.md](./deploy-cloudflare.md) for the web-tier deploy and
[ARCHITECTURE.md](../../ARCHITECTURE.md) §6 for the durability model.

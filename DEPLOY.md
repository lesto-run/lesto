# Deploying a Keel app

Keel's deployment model is deliberately small. There is **one durable
substrate — the database** — and everything else is a stateless process you can
add, remove, or restart at will. There is no separate broker, no sticky session
store, no out-of-band scheduler to babysit.

## The shape of a deployment

A Keel app is a single `keel.app.ts` that default-exports its `AppConfig`
(`{ db, router, controllers, migrations }`). Two kinds of process run it, plus
one one-shot command:

| Process            | Command            | Role                                                        |
| ------------------ | ------------------ | ----------------------------------------------------------- |
| Web tier           | `keel serve`       | Boots the HTTP server in front of the app. **Stateless.**   |
| Worker tier        | `keel work` *      | Drains the durable job queue. **Stateless.**                |
| Migrations         | `keel migrate`     | Applies pending migrations, prints the versions, exits.     |

\* The worker is `runWorker(queue)` from `@keel/runtime` — a thin wire over
`queue.work()`, which owns the at-least-once claim/reclaim loop and the graceful
drain. Run it from your app's worker entry (or wire it behind a CLI command);
`keel serve` boots the web tier only, so the two scale independently.

## The web tier is stateless

`keel serve` holds nothing in memory that matters across requests. Every request
is resolved from the database. That means:

- **Scale horizontally** by running more `keel serve` containers behind a load
  balancer. No sticky sessions, no shared in-process cache to coordinate.
- **Rolling restarts are free** for the web tier — a draining instance has no
  state to hand off.

The supplied `Dockerfile` builds exactly this tier: Bun base image, a
`--production` dependency install, the app source, and `keel serve --port $PORT`.

## The database is the one substrate

Keel puts the job queue **on the SQL database** (`@keel/queue`) rather than on a
separate broker. This is the load-bearing design choice:

- **The durable queue means rolling restarts do not lose jobs.** An enqueued job
  is a committed row. When a worker dies mid-job, the claim is reclaimed by the
  at-least-once loop and the job runs again — so a deploy that rolls every worker
  pod drops nothing in flight. Make handlers **idempotent**; at-least-once means
  a job can run more than once.
- **The scheduler is just the queue too.** `Scheduler.cron(...)` enqueues due
  jobs onto the same durable queue, so cron survives restarts the same way.
- **Migrations run against this one substrate.** Run `keel migrate` once per
  release, *before* the new web/worker code goes live, as a release/job step.

Because the database is the only stateful thing, **back it up and you have backed
up the app.**

## Bring your own Postgres / Redis adapters at scale

Out of the box a Keel app uses an embedded SQLite database (`keel.db`), which is
perfect for a single node and for getting to production fast. To scale past one
box, point the app at a managed datastore:

- **Postgres** — supply a Postgres-backed `db` in `keel.app.ts`. The queue,
  models, and migrations all run on whatever SQL database you provide; nothing in
  the framework assumes SQLite. A managed Postgres gives you the durable queue,
  the models, and the scheduler on shared, replicated storage that every
  stateless web and worker instance reads from.
- **Redis adapters** — for the hot paths that want an in-memory tier
  (`@keel/cache`, `@keel/ratelimit`, `@keel/pubsub`), swap the in-memory store
  for a Redis-backed adapter. These are interface-driven
  (e.g. `RateLimitStore`, the cache store), so this is a constructor swap, not a
  rewrite — and it stays optional: the database remains the source of truth.

## Release checklist

1. **Build** the image: `docker build -t my-keel-app .`
2. **Migrate** against the target database: `keel migrate` (one-shot, pre-deploy).
3. **Roll the web tier**: deploy the new `keel serve` instances behind the LB.
4. **Roll the worker tier**: deploy the new worker instances — in-flight jobs are
   reclaimed from the queue, so nothing is lost.
5. **Scale** by adding web/worker replicas; the database is the only thing that
   must scale with care (managed Postgres + read replicas as needed).

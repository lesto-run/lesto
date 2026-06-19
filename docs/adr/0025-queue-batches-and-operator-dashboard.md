# ADR 0025 — Queue job batches, dependency edges, and an operator dashboard

- **Status:** Accepted (implemented)
- **Date:** 2026-06-19
- **Deciders:** tech lead + owner
- **Supersedes nothing; extends the `@lesto/queue` primitive (the reference impl — durable, at-least-once, claim/fence/reclaim lifecycle), ADR 0011/0012 (canonical islands), ADR 0010 (island data sources), ADR 0005 (validation at the boundary), and `@lesto/admin` (CRUD-over-a-`@lesto/db`-Table).**

## Context

`@lesto/queue` is the framework's reference implementation: a durable, at-least-once
job queue over a `SqlDatabase` interface, with a claim/fence/reclaim lifecycle, an
injected `Clock`, coded errors, and 100% coverage. It enqueues, claims, runs,
retries-with-backoff, and dead-letters one job at a time. Two honest gaps remained
against the table-stakes bar (Sidekiq Pro batches, Oban workflows, BullMQ flows,
Cloudflare Queues + Workflows):

1. **No structure between jobs.** Every enqueue is independent. A real pipeline —
   *ingest a photo, THEN thumbnail it; fan several inputs in, THEN aggregate* — has
   to be hand-wired by each app with its own "is the prerequisite done yet?" polling,
   which re-derives ordering (and gets it wrong) per app.

2. **No operator surface.** The queue's state lived only in the table. An operator
   could not see jobs in-flight / failed / scheduled, inspect a poisoned job, retry a
   dead-lettered one, or read throughput without writing raw SQL. The framework's
   pitch is "batteries included"; a queue you cannot *watch and steer* is a battery
   missing its terminals.

The constraints this ADR honours, all already load-bearing in `@lesto/queue`:

- **The claim path is sacred.** The claim subselect scans `status = 'ready'` under a
  partial index; nothing here may slow or complicate it. A new lifecycle state must be
  *invisible* to the claim, not a new branch inside it.
- **At-least-once, idempotent by convention.** `complete` can run twice (a reclaimed
  worker). Any dependency-release it triggers must be safe to run twice and must never
  fire on a completion the worker did not actually land.
- **State lives in the database.** A batch's structure (its jobs, its edges) is rows,
  not process memory — so the web/worker tier stays stateless and a batch survives a
  deploy.
- **Errors carry stable `code`s; closure-factory house style; 100% coverage.**

## Decision

### 1. Job batches + dependency edges, on the existing primitive

A **batch** is a named set of jobs enqueued together in one transaction, with an
optional DAG of **dependency edges** between them. Two tables and one column carry the
structure; one new source state carries the ordering:

- `lesto_job_batches` — one row per `enqueueBatch` call (`id`, `name`, `total`,
  `created_at`).
- `lesto_job_deps` — one row per `(job_id, depends_on_id)` edge, indexed BOTH ways
  (by job, to read a dependent's unmet prerequisites; by prerequisite, to find the
  dependents of a just-finished job).
- `lesto_jobs.batch_id` — the nullable back-reference (`null` for a standalone
  enqueue), indexed.

The lifecycle gains exactly ONE state, **`blocked`**, that sits *before* `ready`:

> A job enqueued with unmet dependency edges starts `blocked` and is **never
> claimed** — the claim subselect still only ever scans `status = 'ready'`, so a
> `blocked` job is simply invisible to it. When the **last** prerequisite it depends
> on reaches `done`, the dependency release flips it `blocked → ready` and the
> ordinary lifecycle takes over. A `blocked` job whose prerequisite *fails* stays
> `blocked` forever — it is reported separately by `batch()`, never silently released
> — so a batch never runs a step whose prerequisite never succeeded.

This is the whole ordering guarantee: **B never runs before A** because B is hidden
from the claim until A is `done`. The claim path is untouched.

**`enqueueBatch(name, steps)`** writes the batch row, every job row, and every edge in
ONE `transaction` — a batch is all-or-nothing, so a fault mid-insert rolls back rather
than leaving a half-wired DAG that could deadlock (a `blocked` job whose missing
prerequisite was never inserted would wait forever). Each `BatchStep` may declare
`dependsOn` — zero-based indices of *earlier* steps. A forward or self edge is rejected
eagerly, **before** the transaction opens, with `QUEUE_BATCH_FORWARD_DEPENDENCY`: it
could only describe a job depending on one not yet inserted, or a cycle, neither of
which can ever complete. An empty `steps` is `QUEUE_BATCH_EMPTY`.

**The dependency release** runs from `complete`, gated on the fenced `done` UPDATE
actually landing (`changes > 0`): a stale worker whose visibility lapsed matches zero
rows and therefore must NOT release a completion it did not perform. The release is one
indexed `UPDATE … WHERE status = 'blocked' AND NOT EXISTS (an unfinished prerequisite)`
— so a fan-in dependent is released only by the completion of its *last* input, and a
job with no edges (the common path) matches nothing and pays a cheap no-op. The
`status = 'blocked'` fence makes a double-`complete` a no-op: it never double-releases.

**`batch(id)`** rolls the per-status job counts up to a `BatchState`: `failed` wins
(one failed job means the batch can never complete), else `completed` iff every ORIGINAL
job is `done` — the `done` count reconciled against the batch row's stored `total`, not
the sum of whatever rows survive — else `pending`. Reconciling against `total` keeps an
all-discarded batch honest: `discard` deletes job rows, so a batch whose every job was
discarded has empty counts, and `done(0) === 0` would falsely read `completed`; against
the original `total > 0` it is truthfully `pending`. An unknown id is
`QUEUE_BATCH_NOT_FOUND`.

### 2. The operator surface: `list` / `retry` / `discard`

Three methods, deliberately **outside** the claim/fence lifecycle — an operator acting
from a UI is not a worker holding a visibility lock, so these are unfenced and made
idempotent by their `WHERE` clause:

- **`list(options)`** — jobs filtered by `status` and/or `queue`, paged,
  `updated_at DESC, id DESC` (the just-failed / just-finished job surfaces first). A
  poison payload row hydrates through the same coded `QUEUE_POISON_PAYLOAD` path as
  `find`, so one corrupt row is a loud, branchable error mid-list, not a raw
  `SyntaxError`.
- **`retry(id)`** — resets a `failed` job to a fresh `ready` (attempts cleared,
  `run_at = now`). Fenced on `status = 'failed'`, so a double-click or stale view can
  never resurrect a running or done job; returns whether a row was re-queued.
- **`discard(id)`** — deletes a non-`running` job, then RE-EVALUATES its dependents and
  sweeps its dependency edges. Discarding a prerequisite **unblocks** its dependents:
  the deleted prerequisite is treated as settled, so any dependent whose every other
  remaining prerequisite is already `done` is released to `ready` rather than stranded
  `blocked` forever (the trigger lives in one shared `releaseReadyDependents` helper, run
  from BOTH `complete` and `discard` — `complete` alone is not enough, because a
  discarded prerequisite never completes). The order inside the transaction is
  load-bearing: delete the row, THEN release dependents (still discoverable via the
  `depends_on_id` edges, and the deleted prerequisite no longer joins, so it counts as
  satisfied), THEN sweep the edges. Refuses a `running` job — discarding a row a worker
  holds would race that worker's terminal write.

### 3. The dashboard — dogfooding islands + the admin surface

`examples/queue-dashboard` (`@lesto/example-queue-dashboard`, a **preview**) is the
proof. It is one `lesto()` app:

- The READ is a canonical island (ADR 0012): `app/islands/queue-board.tsx` is
  `ssr: true` with a `snapshot` data binding (ADR 0010) resolved at render and inlined
  (0 RTT), auto-exposed at `/__lesto/data/queue` as the poll/refresh tier. The board
  renders the per-status tabs (in-flight / failed / scheduled), the backlog-depth +
  oldest-waiting latency line, the failed-job DLQ sample, and the throughput panel; the
  interactive status-tab spotlight (`useState`) is the visible proof of hydration.
- The MANAGEMENT verbs are HTTP routes the operator's client posts to:
  `GET /queue/jobs` (the tabs' list), `GET /queue/jobs/:id` (inspect),
  `POST /queue/jobs/:id/retry`, `DELETE /queue/jobs/:id`, `GET /queue/batches/:id`
  (rollup). These go STRAIGHT to the queue's operator surface — they are queue
  operations, not generic CRUD.
- The THROUGHPUT ledger (`job_runs`, written by an `onJob` observer) is read back
  through **`@lesto/admin`** (`GET /admin/runs`) — dogfooding the admin layer's
  pagination + projection for a generic CRUD table. Two surfaces, each used for what it
  is good at.

The example seeds a mix of jobs (successes, one DLQ failure) and a
**batch-with-a-dependency** (`ingest` → `thumbnail`), drains it, and proves the
thumbnail can only run *after* ingest.

> **Preview caveat — the example's mutation routes are unauthenticated and CSRF-free.**
> `POST /queue/jobs/:id/retry` and `DELETE /queue/jobs/:id` ship with NO auth and NO
> CSRF guard. That is acceptable for a local dogfood driven by `curl`/tests, but it is
> an insecure pattern to copy verbatim, so `serve.ts` and `src/app.ts` carry a loud
> "PREVIEW — unauthenticated, do not deploy as-is" banner (and `serve.ts` warns at
> boot). A real deploy gates those routes behind its own auth and mounts `@lesto/csrf`
> — `originCheck()` (the zero-config Fetch-Metadata default for a cookie-authed app) or
> the signed double-submit `csrf()` middleware — via `.use(...)`, exactly as
> `examples/estate` does. Full CSRF token-threading was left out of the preview
> deliberately: the example has no session/auth story to bind a double-submit token to,
> and inventing one would balloon a focused queue demo.

## Why a new `blocked` state, not a `run_at` far in the future or a separate "pending" table

Two rejected alternatives:

- **Park a dependent at `run_at = +∞` and bump it forward on release.** This keeps the
  job `ready` and *visible to the claim*, relying on `run_at` to hide it — but a
  `ready` row with a future `run_at` is exactly what `reclaim`/scheduling reason about,
  and conflating "scheduled for later" with "blocked on a prerequisite" muddies both.
  `blocked` is honest: it is a distinct reason a job is unclaimable.
- **A separate `pending_jobs` table that promotes rows into `lesto_jobs` on release.**
  Two-table promotion is a second write path, a second place for a crash to tear, and a
  duplicate of every column. One `status` value and one back-reference column is
  strictly less machinery for the same guarantee.

The `blocked` state costs the claim **nothing** — the partial index and the subselect
both already filter `status = 'ready'`, so `blocked` rows never enter the claim's
working set.

## Error contract

| `code` | Surface | Meaning |
|---|---|---|
| `QUEUE_BATCH_EMPTY` | `enqueueBatch` | `steps` was empty — a batch of nothing is a caller bug, not a no-op. |
| `QUEUE_BATCH_FORWARD_DEPENDENCY` | `enqueueBatch` | A step depends on a later step or itself (a cycle / un-inserted prerequisite). |
| `QUEUE_BATCH_NOT_FOUND` | `batch` | No batch with that id (a typo or a pruned batch), refused loudly rather than a hollow zero-job summary. |

`list` reuses the existing `QUEUE_POISON_PAYLOAD`; `retry`/`discard` return a boolean
(no new code — "nothing to do" is a value, not an exception). The example maps a
non-retryable to `409`, a non-discardable to `409`, an unknown job/batch to `404`.

## Consequences

- **Pipelines are first-class.** An app declares `dependsOn` and gets ordered
  execution + a batch rollup; it no longer hand-rolls "is the prerequisite done?"
  polling and no longer gets the ordering wrong.
- **The queue is operable.** in-flight / failed / scheduled, inspect, retry, discard,
  throughput — the operator reads and steers without raw SQL, through a dashboard built
  from existing islands + the admin surface.
- **The claim path is unchanged and uncompromised.** A non-batch job's lifecycle is
  byte-for-byte as before; the dependency machinery is one indexed no-op on the common
  path.
- **At-least-once is preserved.** The release is gated on the fenced UPDATE landing and
  fenced again on `status = 'blocked'`, so a reclaimed worker's double-`complete`
  neither double-releases nor resurrects a job.
- **Additive + reversible.** Two tables, one column, one state, three methods; an app
  that never calls `enqueueBatch` / `list` / `retry` / `discard` is unaffected.

## Acceptance (this ADR)

- `enqueueBatch` / `batch` / `list` / `retry` / `discard` ship in `@lesto/queue`; the
  `blocked` state is invisible to the claim; a batch with a dependency completes IN
  ORDER and reports `completed`; a failed prerequisite leaves its dependent `blocked`
  and the batch `failed`. 100% coverage on `@lesto/queue` and `@lesto/admin` (the two
  touched non-preview packages).
- `examples/queue-dashboard` (preview) demonstrates the whole journey over real HTTP —
  view (snapshot, list-by-status, inspect), manage (retry, discard), batch-with-
  dependency-in-order, and admin-backed throughput — with its tests + typecheck green;
  it is designed so a deployed app could view and manage queue state through the
  dashboard.

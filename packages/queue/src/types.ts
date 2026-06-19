/**
 * The vocabulary of the queue.
 *
 * Notably, the queue depends on a *minimal SQL surface* — not on any one driver.
 * better-sqlite3 satisfies it structurally today; a Postgres driver will satisfy
 * the same shape tomorrow, and the queue never knows the difference.
 */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

/**
 * A job moves: ready → running → (done | failed), with running → ready on reclaim.
 *
 * One extra source state, `blocked`, sits *before* `ready`: a job enqueued with
 * unmet dependency edges (see {@link Queue.enqueueBatch}) starts `blocked` and is
 * NEVER claimed — the claim subselect only ever scans `status = 'ready'`. When the
 * last job it depends on reaches `done`, the dependency release flips it
 * `blocked → ready` and the ordinary lifecycle takes over. A blocked job whose
 * dependency *fails* stays `blocked` forever (it is reported separately by
 * {@link Queue.batch} rather than silently released), so a batch never runs a step
 * whose prerequisite never succeeded.
 */
export type JobStatus = "blocked" | "ready" | "running" | "done" | "failed";

export interface Job<Payload extends JsonValue = JsonValue> {
  readonly id: number;
  readonly queue: string;
  readonly name: string;
  readonly payload: Payload;

  readonly status: JobStatus;
  readonly priority: number;
  readonly attempts: number;
  readonly maxAttempts: number;

  readonly runAt: string;
  readonly lockedUntil: string | null;
  readonly lastError: string | null;

  /** The batch this job belongs to, or `null` for a standalone enqueue. */
  readonly batchId: number | null;

  readonly createdAt: string;
  readonly updatedAt: string;
  readonly finishedAt: string | null;
}

export interface JobContext {
  readonly job: Job;
  readonly attempt: number;
}

export type JobHandler<Payload extends JsonValue = JsonValue> = (
  payload: Payload,
  context: JobContext,
) => void | Promise<void>;

export interface EnqueueOptions {
  readonly queue?: string;
  readonly priority?: number;
  readonly maxAttempts?: number;

  /** Delay before the job becomes eligible. Mutually exclusive with `runAt`. */
  readonly delayMs?: number;

  /** Absolute time the job becomes eligible. Wins over `delayMs`. */
  readonly runAt?: Date;
}

export type RunOutcome = "done" | "retry" | "failed";

export interface RunResult {
  readonly job: Job;
  readonly outcome: RunOutcome;
}

/**
 * The observability record for one processed job — what {@link JobObserver} sees.
 *
 * Carries only the metadata an operator or tracer needs (queue, id, outcome,
 * attempt, duration); the payload BODY is deliberately omitted so a sink can never
 * leak job contents into a log or span. `durationMs` measures the processing span:
 * the handler call (or the terminal transition for a poison/unhandled job), not
 * the time the job waited in the queue.
 */
export interface JobEvent {
  readonly queue: string;
  readonly id: number;
  readonly name: string;
  readonly outcome: RunOutcome;
  readonly attempt: number;
  readonly durationMs: number;
}

/** A sink invoked once per processed job. A throw is contained, never fatal. */
export type JobObserver = (event: JobEvent) => void;

/**
 * A queue's health at a glance — for dashboards, the MCP surface, and tracing.
 *
 * The per-status counts stay TOP-LEVEL keys (`ready`, `running`, `done`,
 * `failed`), each a real `number` (Postgres returns `COUNT(*)` as a string, so
 * every count is coerced via `Number()`). On top of the counts:
 *
 * - `depth` — the backlog: jobs `ready` AND already eligible (`run_at <= now`),
 *   i.e. work a worker could claim right now. Distinct from the `ready` count,
 *   which also includes jobs scheduled for the future.
 * - `oldestReadyAgeMs` — how long the oldest such eligible job has waited, in
 *   milliseconds, or `null` when the backlog is empty. The headline latency
 *   signal: a growing value means workers are falling behind.
 */
export type QueueStats = Partial<Record<JobStatus, number>> & {
  readonly depth: number;
  readonly oldestReadyAgeMs: number | null;
};

// ---- batches & dependency edges ----
//
// A batch is a named set of jobs enqueued together, with an optional DAG of
// dependency edges between them. The two new tables (`lesto_job_batches`,
// `lesto_job_deps`) and the `batch_id` column on `lesto_jobs` carry the
// structure; `enqueueBatch` writes it atomically and the dependency release
// (run from `complete`) advances `blocked` jobs to `ready` as their
// prerequisites finish. The CLAIM path is untouched — it still only ever scans
// `status = 'ready'`, so a blocked job is simply invisible to it until released.

/**
 * One step in an {@link Queue.enqueueBatch} call: a job to enqueue, plus the
 * indices of the *earlier* steps in the same batch it depends on.
 *
 * `dependsOn` is a list of zero-based positions in the `steps` array — a step
 * may only depend on a step BEFORE it (a forward edge would be a job depending
 * on one not yet inserted, and a cycle could never complete). A step with a
 * non-empty `dependsOn` is enqueued `blocked`; one with none is enqueued `ready`
 * and is claimable immediately. The job's options (`queue`, `priority`,
 * `maxAttempts`, `delayMs`/`runAt`) are the usual {@link EnqueueOptions}.
 */
export interface BatchStep {
  readonly name: string;
  readonly payload?: JsonValue;
  readonly options?: EnqueueOptions;

  /** Zero-based indices of earlier steps this one waits for. Must point backwards. */
  readonly dependsOn?: readonly number[];
}

/** What {@link Queue.enqueueBatch} hands back: the batch id and every job id it created. */
export interface BatchHandle {
  /** The `lesto_job_batches` row id. */
  readonly id: number;

  /** The job ids, in `steps` order — `jobIds[i]` is the id of `steps[i]`. */
  readonly jobIds: readonly number[];
}

/** Where a batch is in its lifecycle, derived from its jobs' statuses. */
export type BatchState = "pending" | "completed" | "failed";

/**
 * A batch's health at a glance — for the operator dashboard and tests.
 *
 * The per-status counts are over the batch's jobs (NOT the whole queue), each a
 * real `number` (Postgres returns `COUNT(*)` as a string, coerced via `Number()`).
 * `total` is how many jobs the batch holds. `state` is the derived rollup:
 *
 * - `failed` — at least one job is `failed`. The batch cannot complete: a job
 *   that depended on the failed one stays `blocked` forever, by design.
 * - `completed` — every ORIGINAL job is `done` (the `done` count equals the
 *   batch's stored `total`). A batch whose jobs were discarded away has fewer
 *   surviving rows than `total`, so it is `pending`, never a false `completed`.
 * - `pending` — none of the above: work is still ready/blocked/running, or some
 *   jobs were discarded so the batch can no longer fully complete.
 */
export interface BatchSummary {
  readonly id: number;
  readonly name: string;
  readonly total: number;
  readonly counts: Partial<Record<JobStatus, number>>;
  readonly state: BatchState;
  readonly createdAt: string;
}

// ---- the operator surface (what a dashboard reads + acts on) ----

/**
 * The filter + paging for {@link Queue.list} — the operator dashboard's read.
 *
 * `status` narrows to one lifecycle state (the dashboard's "in-flight / failed /
 * scheduled" tabs map to `running` / `failed` / `ready`); absent → every status.
 * `queue` narrows to one named queue; absent → the queue's default. `limit` /
 * `offset` page the result, newest-updated first, so the dashboard never loads an
 * unbounded table.
 */
export interface ListJobsOptions {
  readonly status?: JobStatus;
  readonly queue?: string;
  readonly limit?: number;
  readonly offset?: number;
}

/** A clock we can stop. Injected everywhere time matters, so tests are deterministic. */
export type Clock = () => Date;

/**
 * Which SQL dialect the queue speaks. Defaults to `"sqlite"`. It selects the
 * surrogate-key DDL ({@link installSchema}) and the row-locking clause in the
 * atomic claim (`FOR UPDATE SKIP LOCKED` on Postgres). Mirrors `@lesto/db`'s
 * `Dialect`.
 */
export type Dialect = "sqlite" | "postgres";

// ---- the minimal SQL surface (driver-agnostic) ----
//
// This surface is OWNED by `@lesto/db`, not redeclared here. The queue once
// carried its own structurally-identical copy, which made `@lesto/db`'s
// `SqlDatabase` and the queue's two *nominally distinct* types: sharing one
// `openSqlite` handle across `createDb` and `new Queue({ db })` forced a
// `handle as unknown as SqlDatabase` cast even though the shapes matched to the
// method. Re-exporting the canonical `@lesto/db` types instead means a single
// handle flows into `createDb`, `new Queue({ db })`, and `installSchema` with NO
// cast (ADR 0006's async terminals, positional params, and sync `prepare` are
// all defined there). `@lesto/queue` adding `@lesto/db` to its dependencies is the
// only cost; the queue still speaks the same minimal surface, just by reference.
export type { SqlDatabase, SqlStatement } from "@lesto/db";

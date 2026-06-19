import { isPermanentFailure, QueueError } from "./errors";
import { isoAfter, nowIso, systemClock } from "./time";

import type {
  BatchHandle,
  BatchState,
  BatchStep,
  BatchSummary,
  Clock,
  Dialect,
  EnqueueOptions,
  Job,
  JobHandler,
  JobObserver,
  JobStatus,
  JsonValue,
  ListJobsOptions,
  QueueStats,
  RunOutcome,
  RunResult,
  SqlDatabase,
} from "./types";

const TABLE = "lesto_jobs";

/** The batch-metadata table: one row per {@link Queue.enqueueBatch} call. */
const BATCHES_TABLE = "lesto_job_batches";

/** The dependency-edge table: one row per `(job, depends-on)` pair. */
const DEPS_TABLE = "lesto_job_deps";

/**
 * The durable job queue.
 *
 * The contract is at-least-once: a worker CLAIMS a job atomically, stamps a
 * visibility deadline, and increments `attempts` up front. If that worker dies
 * mid-job — a deploy SIGKILLing the pod — the row lingers in `running` until the
 * deadline lapses, then RECLAIM returns it to `ready` for another worker. Work
 * is never lost; it is, at worst, retried. Handlers are therefore expected to be
 * idempotent.
 *
 * On SQLite the claim is one atomic `UPDATE … WHERE id = (SELECT … LIMIT 1)
 * RETURNING *`. On Postgres the subselect adds `FOR UPDATE SKIP LOCKED`, so
 * concurrent workers each skip rows another has already locked and every job is
 * claimed exactly once — behind this exact API (see {@link Queue.claim}).
 *
 * Two observability seams are optional and additive: a `work({ onJob })` /
 * `runOnce({ onJob })` sink fires once per processed job with its outcome and
 * `durationMs` (no payload), and {@link Queue.stats} reports per-status counts
 * plus the backlog signals `depth` + `oldestReadyAgeMs`. Both are inert by
 * default — no sink, no cost.
 */

/**
 * Create the jobs table. Idempotent; call it from a migration or once at boot.
 *
 * `dialect` defaults to `"sqlite"`; pass `"postgres"` to declare the surrogate
 * key as a `BIGINT … GENERATED ALWAYS AS IDENTITY` column (Postgres has no
 * `AUTOINCREMENT` keyword, and an int4 key would cap the queue at ~2.1B jobs).
 * Every other column is spelled identically on both engines.
 *
 * IMPORTANT: this `dialect` and the {@link Queue}'s `dialect` MUST agree. The
 * Queue's `dialect` is what decides whether the atomic claim carries `FOR UPDATE
 * SKIP LOCKED`; a Postgres app that installs the schema here with `"postgres"`
 * but forgets `dialect: "postgres"` on `new Queue()` silently DROPS that clause
 * and reintroduces double-delivery under concurrency — with no error to warn
 * you. Pass the same dialect to both.
 */
export async function installSchema(db: SqlDatabase, dialect: Dialect = "sqlite"): Promise<void> {
  const idColumn =
    dialect === "postgres"
      ? "BIGINT  PRIMARY KEY GENERATED ALWAYS AS IDENTITY"
      : "INTEGER PRIMARY KEY AUTOINCREMENT";

  const batchIdColumn =
    dialect === "postgres"
      ? "BIGINT  PRIMARY KEY GENERATED ALWAYS AS IDENTITY"
      : "INTEGER PRIMARY KEY AUTOINCREMENT";

  await db.exec(`
    CREATE TABLE IF NOT EXISTS ${BATCHES_TABLE} (
      id            ${batchIdColumn},
      name          TEXT    NOT NULL,
      total         INTEGER NOT NULL,
      created_at    TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id            ${idColumn},
      queue         TEXT    NOT NULL DEFAULT 'default',
      name          TEXT    NOT NULL,
      payload       TEXT    NOT NULL DEFAULT '{}',
      status        TEXT    NOT NULL DEFAULT 'ready',
      priority      INTEGER NOT NULL DEFAULT 0,
      attempts      INTEGER NOT NULL DEFAULT 0,
      max_attempts  INTEGER NOT NULL DEFAULT 5,
      run_at        TEXT    NOT NULL,
      locked_until  TEXT,
      last_error    TEXT,
      batch_id      INTEGER,
      created_at    TEXT    NOT NULL,
      updated_at    TEXT    NOT NULL,
      finished_at   TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_${TABLE}_claim
      ON ${TABLE} (status, queue, run_at);

    CREATE INDEX IF NOT EXISTS idx_${TABLE}_batch
      ON ${TABLE} (batch_id);

    -- The dependency edges. (job_id, depends_on_id) is the natural key; a job
    -- with N prerequisites has N rows. Indexed BOTH ways: by job (read a job's
    -- unmet deps when deciding whether to release it) and by prerequisite (find
    -- the dependents of a just-finished job in the release sweep).
    CREATE TABLE IF NOT EXISTS ${DEPS_TABLE} (
      job_id         INTEGER NOT NULL,
      depends_on_id  INTEGER NOT NULL,
      PRIMARY KEY (job_id, depends_on_id)
    );

    CREATE INDEX IF NOT EXISTS idx_${DEPS_TABLE}_depends_on
      ON ${DEPS_TABLE} (depends_on_id);
  `);

  // A PARTIAL index over only the rows the claim subselect ever scans —
  // `status = 'ready'`. Once a queue retires millions of `done`/`failed` rows
  // (between `prune` runs), the full `(status, queue, run_at)` index above still
  // carries every terminal row; this one indexes ONLY the claimable backlog, so
  // the hot path stays small no matter how much history accumulates.
  //
  // Postgres-only by deliberate choice: the constant predicate must MATCH the
  // claim's `status = 'ready'` for the planner to use a partial index, and only
  // Postgres is the engine where a large terminal-row tail is an operational
  // concern (a Postgres deployment is the multi-million-row one). SQLite — the
  // single-connection dev/edge engine — is well served by the full index above
  // and skips the extra write-amplification a second index costs.
  if (dialect === "postgres") {
    await db.exec(
      `CREATE INDEX IF NOT EXISTS idx_${TABLE}_ready
         ON ${TABLE} (queue, priority DESC, run_at) WHERE status = 'ready'`,
    );
  }
}

interface Row {
  id: number;
  queue: string;
  name: string;
  payload: string;
  status: JobStatus;
  priority: number;
  attempts: number;
  max_attempts: number;
  run_at: string;
  locked_until: string | null;
  last_error: string | null;
  batch_id: number | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

/**
 * Hydrate everything EXCEPT the payload — the metadata terminal transitions need
 * (id, attempts, the `lockedUntil` fencing token). The payload is parsed
 * separately ({@link hydrate}) so a poison (un-parseable) payload can be routed
 * through `fail()` from this same metadata, instead of throwing before the job is
 * even visible to the runner. `payload` is seeded `null` and overwritten on the
 * happy path.
 */
function hydrateMeta(row: Row): Job {
  return {
    // `id` is a BIGINT on Postgres, which node-postgres returns as a string;
    // coerce so `Job.id` is always the `number` its type promises (the integer
    // counters are int4 → already numbers, but `Number()` is idempotent on them).
    id: Number(row.id),
    queue: row.queue,
    name: row.name,
    payload: null,
    status: row.status,
    priority: Number(row.priority),
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    runAt: row.run_at,
    lockedUntil: row.locked_until,
    lastError: row.last_error,
    // `batch_id` is a nullable BIGINT on Postgres (string when present, null
    // when absent); coerce the present case to `number` and pass the null
    // through, so `Job.batchId` is always `number | null` as its type promises.
    batchId: row.batch_id === null ? null : Number(row.batch_id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

/**
 * Hydrate the full job, parsing the payload. A poison (un-parseable) payload
 * throws the *coded* `QUEUE_POISON_PAYLOAD` rather than a raw `SyntaxError`, so a
 * caller can branch on the code and an operator can see WHICH job is corrupt
 * instead of a bare parse failure. `runOnce` does not go through this path — it
 * parses on the claimed metadata so it can route a poison payload through
 * `fail()` (see {@link Queue.runOnce}); the public `claim()`/`find()` surface
 * keeps its Job-or-null contract and surfaces the coded error instead.
 */
function hydrate(row: Row): Job {
  const meta = hydrateMeta(row);

  let payload: JsonValue;
  try {
    payload = JSON.parse(row.payload) as JsonValue;
  } catch (error) {
    // `JSON.parse` only ever throws a `SyntaxError` (an `Error`), so reading
    // `.message` needs no non-Error fallback here.
    throw new QueueError("QUEUE_POISON_PAYLOAD", `Job ${meta.id} has an unparseable payload.`, {
      id: meta.id,
      cause: (error as Error).message,
    });
  }

  return { ...meta, payload };
}

/**
 * Roll a batch's per-status job counts up to its lifecycle {@link BatchState},
 * reconciled against the batch row's original `total`.
 *
 * `failed` WINS over `completed`/`pending`: one failed job means the batch can
 * never complete (a job that depended on the failed one stays `blocked`
 * forever), so an operator should see `failed` even while other jobs are still
 * running. With no failure, `completed` iff EVERY ORIGINAL job is `done` — the
 * `done` count must equal the batch's original `total`, not merely the count of
 * whatever rows survive. A count is read defensively (`?? 0`) because an absent
 * status is simply zero of it.
 *
 * Reconciling against `total` (rather than the sum of present counts) is what
 * keeps an ALL-DISCARDED batch honest: discard DELETES job rows, so a batch whose
 * every job was discarded has empty counts. Summing those gives 0, and `done(0)
 * === 0` would falsely report `completed` — yet nothing completed. Against the
 * original `total > 0`, `done(0) !== total`, so it is truthfully `pending`. (A
 * partially-discarded batch is likewise `pending` until its surviving jobs all
 * reach `done` AND that equals the original count — i.e. nothing was lost.)
 */
function batchState(counts: Partial<Record<JobStatus, number>>, total: number): BatchState {
  if ((counts.failed ?? 0) > 0) {
    return "failed";
  }

  return (counts.done ?? 0) === total ? "completed" : "pending";
}

export interface QueueOptions {
  readonly db: SqlDatabase;
  readonly clock?: Clock;
  readonly defaultQueue?: string;
  readonly baseBackoffMs?: number;
  readonly maxBackoffMs?: number;

  /**
   * Which SQL dialect `db` speaks. Defaults to `"sqlite"`. On `"postgres"` the
   * atomic claim adds `FOR UPDATE SKIP LOCKED` so concurrent workers each skip a
   * row another already locked — the row-level locking SQLite does not need
   * (the runtime serializes every write over its one connection).
   *
   * MUST match the dialect passed to {@link installSchema}: forgetting
   * `"postgres"` here on a Postgres app silently drops the locking clause and
   * reintroduces double-delivery, with no error to warn you.
   */
  readonly dialect?: Dialect;
}

export interface WorkOptions {
  readonly queue?: string;
  readonly concurrency?: number;
  readonly pollMs?: number;
  readonly visibilityMs?: number;

  /**
   * How often to RECLAIM stalled jobs, in ms. Defaults to `visibilityMs` — a job
   * cannot be stale until its visibility deadline lapses, so reclaiming roughly
   * once per window catches every stalled row without scanning on every poll.
   *
   * This is the cadence change that makes RECLAIM independent of the poll loop:
   * `runOnce` no longer reclaims, so a hot 200ms poll loop no longer issues a
   * RECLAIM `UPDATE` on every empty tick (it ran one wasted full-table `UPDATE`
   * per poll). The reclaim now rides its own timer here, scanning at the rate
   * stalls can actually occur. Reclaim faults route through {@link onError} like
   * any poll fault.
   */
  readonly reclaimMs?: number;

  /** Injected so tests can drive the poll loop without real time. */
  readonly sleep?: (ms: number) => Promise<void>;

  /**
   * The observability seam for worker-loop failures.
   *
   * A handler that throws routes through {@link Queue#fail} (retry/backoff) and
   * never reaches here. This fires only for errors raised *outside* the
   * handler — a transient DB fault on claim/reclaim — which would otherwise
   * kill the worker. The error arrives as a coded `QUEUE_WORKER_POLL_FAILED`
   * `QueueError`; branch on its code, log it, ship it to your tracer.
   */
  readonly onError?: (error: QueueError) => void;

  /**
   * The observability seam for processed jobs: fires once per job this worker
   * runs, with its outcome, attempt, and processing `durationMs` (NO payload).
   * Forwarded straight to {@link Queue#runOnce} — see {@link JobObserver}.
   */
  readonly onJob?: JobObserver;
}

export interface Worker {
  stop(): Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class Queue {
  private readonly db: SqlDatabase;

  private readonly clock: Clock;

  private readonly defaultQueue: string;

  private readonly baseBackoffMs: number;

  private readonly maxBackoffMs: number;

  private readonly dialect: Dialect;

  private readonly handlers = new Map<string, JobHandler>();

  constructor(options: QueueOptions) {
    this.db = options.db;
    this.clock = options.clock ?? systemClock;
    this.defaultQueue = options.defaultQueue ?? "default";
    this.baseBackoffMs = options.baseBackoffMs ?? 1000;
    this.maxBackoffMs = options.maxBackoffMs ?? 60_000;
    this.dialect = options.dialect ?? "sqlite";
  }

  /** Register the handler for a job name. */
  define<Payload extends JsonValue = JsonValue>(name: string, handler: JobHandler<Payload>): this {
    if (typeof handler !== "function") {
      throw new QueueError(
        "QUEUE_HANDLER_NOT_A_FUNCTION",
        `Handler for job "${name}" must be a function.`,
        { name },
      );
    }

    this.handlers.set(name, handler as JobHandler);

    return this;
  }

  /** When a job with these options first becomes eligible. */
  private eligibleAt(options: EnqueueOptions): string {
    if (options.runAt) {
      return options.runAt.toISOString();
    }

    if (options.delayMs) {
      return isoAfter(this.clock, options.delayMs);
    }

    return nowIso(this.clock);
  }

  /** Enqueue a job. Returns its id. */
  async enqueue(
    name: string,
    payload: JsonValue = {},
    options: EnqueueOptions = {},
  ): Promise<number> {
    const now = nowIso(this.clock);
    const runAt = this.eligibleAt(options);

    // RETURNING id (not run().lastInsertRowid): Postgres has no implicit row id,
    // so the id is read from the returned row across both drivers. The `?` order
    // mirrors the VALUES order; `now` fills both created_at and updated_at.
    const row = (await this.db
      .prepare(
        `INSERT INTO ${TABLE}
           (queue, name, payload, status, priority, max_attempts, run_at, created_at, updated_at)
         VALUES
           (?, ?, ?, 'ready', ?, ?, ?, ?, ?)
         RETURNING id`,
      )
      .get([
        options.queue ?? this.defaultQueue,
        name,
        JSON.stringify(payload),
        options.priority ?? 0,
        options.maxAttempts ?? 5,
        runAt,
        now,
        now,
      ])) as { id: number };

    return Number(row.id);
  }

  /**
   * Enqueue a set of jobs as one BATCH, with optional dependency edges between
   * them, atomically. Returns the batch id and every job id it created.
   *
   * Each {@link BatchStep} may declare `dependsOn` — zero-based indices of
   * *earlier* steps in the same call. A step with unmet dependencies is enqueued
   * `blocked` and is never claimed; one with none is enqueued `ready` and is
   * claimable immediately. As each prerequisite reaches `done`, the dependency
   * release (run from `complete`) re-checks the dependents and flips a job to
   * `ready` once ALL of its prerequisites are done — so a batch with a
   * dependency completes IN ORDER: B never runs before A.
   *
   * The whole write — the batch row, every job row, every edge — runs in ONE
   * {@link SqlDatabase.transaction}, so a batch is all-or-nothing: a fault
   * mid-insert rolls the batch back rather than leaving a half-wired DAG that
   * could deadlock (a `blocked` job whose missing prerequisite was never
   * inserted would wait forever).
   *
   * `dependsOn` must point BACKWARDS (a smaller index). A forward or self edge
   * is rejected eagerly with `QUEUE_BATCH_FORWARD_DEPENDENCY` — it could only
   * describe a job depending on one not yet inserted, or a cycle, neither of
   * which can ever complete. An empty `steps` is rejected with
   * `QUEUE_BATCH_EMPTY`: a batch of nothing is a caller bug, not a no-op.
   */
  async enqueueBatch(name: string, steps: readonly BatchStep[]): Promise<BatchHandle> {
    if (steps.length === 0) {
      throw new QueueError("QUEUE_BATCH_EMPTY", `Batch "${name}" has no steps.`, { name });
    }

    // Validate the edges BEFORE opening the transaction — a malformed DAG is a
    // caller bug, caught synchronously, never a rolled-back partial write.
    steps.forEach((step, index) => {
      for (const dep of step.dependsOn ?? []) {
        if (dep >= index) {
          throw new QueueError(
            "QUEUE_BATCH_FORWARD_DEPENDENCY",
            `Batch "${name}" step ${index} depends on step ${dep}, which is not an earlier step.`,
            { name, step: index, dependsOn: dep },
          );
        }
      }
    });

    const now = nowIso(this.clock);

    return this.db.transaction(async (tx) => {
      const batchRow = (await tx
        .prepare(
          `INSERT INTO ${BATCHES_TABLE} (name, total, created_at)
           VALUES (?, ?, ?)
           RETURNING id`,
        )
        .get([name, steps.length, now])) as { id: number };

      const batchId = Number(batchRow.id);

      // Insert each step in order. A step with any dependency starts `blocked`
      // (invisible to the claim until released); one with none starts `ready`.
      // The job ids are collected in `steps` order so a later step's edges can
      // reference an earlier step's real id.
      const jobIds: number[] = [];

      for (const step of steps) {
        const options = step.options ?? {};
        const blocked = (step.dependsOn ?? []).length > 0;

        const jobRow = (await tx
          .prepare(
            `INSERT INTO ${TABLE}
               (queue, name, payload, status, priority, max_attempts, run_at, batch_id, created_at, updated_at)
             VALUES
               (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             RETURNING id`,
          )
          .get([
            options.queue ?? this.defaultQueue,
            step.name,
            JSON.stringify(step.payload ?? {}),
            blocked ? "blocked" : "ready",
            options.priority ?? 0,
            options.maxAttempts ?? 5,
            this.eligibleAt(options),
            batchId,
            now,
            now,
          ])) as { id: number };

        const jobId = Number(jobRow.id);
        jobIds.push(jobId);

        for (const dep of step.dependsOn ?? []) {
          // `dep < index` was validated above, so `jobIds[dep]` is already set.
          await tx
            .prepare(`INSERT INTO ${DEPS_TABLE} (job_id, depends_on_id) VALUES (?, ?)`)
            .run([jobId, jobIds[dep]]);
        }
      }

      return { id: batchId, jobIds };
    });
  }

  /**
   * Release any `blocked` job whose prerequisites are now ALL settled.
   *
   * The ONE place a dependent is re-evaluated, shared by the two events that
   * settle a prerequisite:
   *
   * - {@link Queue.complete} runs it the instant a job reaches `done` — the
   *   prerequisite is now a `done` row.
   * - {@link Queue.discard} runs it the instant a prerequisite is DELETED — its
   *   row is gone, and {@link Queue.discard} runs this BEFORE sweeping the edges
   *   that named it, so the dependents are still discoverable here.
   *
   * For each dependent, flip it `blocked → ready` IFF no remaining edge points at
   * a prerequisite that is not yet `done`. The `NOT EXISTS` JOINs each edge to its
   * prerequisite ROW: a `done` prerequisite is satisfied, and a DISCARDED
   * prerequisite (its row deleted) produces no joined row at all, so it too is
   * treated as satisfied — a discarded prerequisite no longer strands its
   * dependent. A dependent with other, still-unfinished prerequisites is left
   * `blocked`; it is released only when its LAST prerequisite settles, so a job
   * behind a fan-in waits for all of its inputs.
   *
   * The flip is itself fenced on `status = 'blocked'`: a dependent already
   * released (by a concurrent completion/discard of its last prerequisite)
   * matches zero rows and is a no-op, so the at-least-once `complete` — which can
   * run twice if a worker is reclaimed — never double-releases or resurrects a job.
   *
   * Both call sites run this with the SAME transaction/claim discipline as the
   * rest of the lifecycle: `complete` is already fenced on the worker's claim and
   * runs the release on `this.db` (no surrounding transaction); `discard` runs the
   * delete + this release + the edge sweep in ONE transaction, so it passes its
   * `tx` here — on a pooled driver the release MUST land on the transaction's
   * pinned connection, not a fresh one off `this.db`, or it would escape the
   * atomic span (see {@link SqlDatabase.transaction}).
   */
  private async releaseReadyDependents(jobId: number, sql: SqlDatabase = this.db): Promise<void> {
    const now = nowIso(this.clock);

    // `EXISTS (… an unsettled prerequisite …)` reads "this dependent still has an
    // edge to a job that exists and isn't done yet." We release exactly the
    // blocked dependents for which NO such row exists — every prerequisite is
    // either `done` or gone (discarded).
    await sql
      .prepare(
        `UPDATE ${TABLE}
            SET status = 'ready', updated_at = ?
          WHERE status = 'blocked'
            AND id IN (SELECT job_id FROM ${DEPS_TABLE} WHERE depends_on_id = ?)
            AND NOT EXISTS (
              SELECT 1
                FROM ${DEPS_TABLE} d
                JOIN ${TABLE} p ON p.id = d.depends_on_id
               WHERE d.job_id = ${TABLE}.id
                 AND p.status <> 'done'
            )`,
      )
      .run([now, jobId]);
  }

  /**
   * A batch's health: per-status counts over its jobs plus a derived `state`
   * (`pending` / `completed` / `failed`) — for the operator dashboard and tests.
   *
   * Refuses an unknown id with `QUEUE_BATCH_NOT_FOUND` rather than reporting a
   * hollow zero-job batch, so a typo or a pruned batch is a loud, coded error.
   */
  async batch(id: number): Promise<BatchSummary> {
    const meta = (await this.db
      .prepare(`SELECT id, name, total, created_at FROM ${BATCHES_TABLE} WHERE id = ?`)
      .get([id])) as
      | { id: number; name: string; total: string | number; created_at: string }
      | undefined;

    if (!meta) {
      throw new QueueError("QUEUE_BATCH_NOT_FOUND", `No batch with id ${id}.`, { id });
    }

    // Per-status counts over the batch's jobs. `COUNT(*)` is a string on
    // Postgres → coerced via `Number()`, the same as `stats`.
    const rows = (await this.db
      .prepare(`SELECT status, COUNT(*) AS n FROM ${TABLE} WHERE batch_id = ? GROUP BY status`)
      .all([id])) as Array<{ status: JobStatus; n: string | number }>;

    const counts = rows.reduce<Partial<Record<JobStatus, number>>>((acc, row) => {
      acc[row.status] = Number(row.n);

      return acc;
    }, {});

    const total = Number(meta.total);

    return {
      id: Number(meta.id),
      name: meta.name,
      total,
      counts,
      // Reconcile against the batch's ORIGINAL `total`, so an all-discarded batch
      // (empty counts) is `pending`, not a false `completed` (see `batchState`).
      state: batchState(counts, total),
      createdAt: meta.created_at,
    };
  }

  /** Return any job stranded past its visibility deadline to `ready`. */
  async reclaim(): Promise<number> {
    const now = nowIso(this.clock);

    // `now` appears twice (SET updated_at, WHERE locked_until <) → repeated.
    const result = await this.db
      .prepare(
        `UPDATE ${TABLE}
            SET status = 'ready', locked_until = NULL, updated_at = ?
          WHERE status = 'running'
            AND locked_until IS NOT NULL
            AND locked_until < ?`,
      )
      .run([now, now]);

    return result.changes;
  }

  /**
   * Delete terminal jobs that finished more than `olderThanMs` ago. Returns how
   * many JOB rows were removed.
   *
   * Retention, not correctness: a `done`/`failed` row is inert — no worker will
   * ever claim it again — but it lingers forever as history, and an unbounded
   * `lesto_jobs` table eventually bloats the index every claim scans. `prune`
   * sheds that history on whatever cadence the caller chooses (the SQL stores'
   * `sweep` pattern — the framework starts no timer; see {@link retentionRecipe}).
   *
   * Only `finished_at IS NOT NULL` rows are eligible, so an in-flight `ready` or
   * `running` job is NEVER pruned regardless of age — `finished_at` is stamped
   * only by the terminal transitions. The cutoff is computed from the injected
   * clock, so it is deterministic under a frozen clock in tests. `olderThanMs`
   * is clamped at 0: a negative value would prune jobs "finished in the future"
   * and is meaningless, so it degrades to "everything already finished."
   *
   * The same transaction ALSO sheds the two satellite tables, so pruning jobs
   * does not leak their rows (and bloat the dep index `releaseReadyDependents`
   * scans): a `lesto_job_deps` edge whose `job_id` OR `depends_on_id` no longer
   * names a live job is orphaned, and a `lesto_job_batches` row with no surviving
   * jobs is orphaned. Both are deleted by `WHERE NOT EXISTS`, mirroring the
   * retention philosophy `retention.ts` states — delete the dead, leave the live.
   * All three deletes run in ONE transaction so a fault can never half-prune a
   * batch (drop its jobs but keep its batch/edge rows, or vice versa).
   */
  async prune(olderThanMs: number): Promise<number> {
    const cutoff = isoAfter(this.clock, -Math.max(0, olderThanMs));

    return this.db.transaction(async (tx) => {
      // `finished_at < cutoff` — ISO-8601 sorts chronologically, so a string
      // comparison is the age comparison (the same trick the claim/reclaim paths
      // use). The status guard is redundant with `finished_at IS NOT NULL` (only
      // terminal rows carry it) but states the intent and lets the planner use the
      // status index.
      const result = await tx
        .prepare(
          `DELETE FROM ${TABLE}
            WHERE status IN ('done', 'failed')
              AND finished_at IS NOT NULL
              AND finished_at < ?`,
        )
        .run([cutoff]);

      // Sweep dependency edges that no longer name a live job on EITHER side, so a
      // pruned job leaves no orphan edge bloating the dep index.
      await tx
        .prepare(
          `DELETE FROM ${DEPS_TABLE}
            WHERE NOT EXISTS (SELECT 1 FROM ${TABLE} j WHERE j.id = ${DEPS_TABLE}.job_id)
               OR NOT EXISTS (SELECT 1 FROM ${TABLE} j WHERE j.id = ${DEPS_TABLE}.depends_on_id)`,
        )
        .run([]);

      // Drop batch rows whose every job was pruned away — a batch with no
      // surviving jobs is dead history, the same as a terminal job row.
      await tx
        .prepare(
          `DELETE FROM ${BATCHES_TABLE}
            WHERE NOT EXISTS (SELECT 1 FROM ${TABLE} j WHERE j.batch_id = ${BATCHES_TABLE}.id)`,
        )
        .run([]);

      return result.changes;
    });
  }

  /** Atomically claim the next eligible row, or `undefined` if the queue is idle. */
  private async claimRow(queue: string, visibilityMs: number): Promise<Row | undefined> {
    const now = nowIso(this.clock);
    const lock = isoAfter(this.clock, visibilityMs);

    // On Postgres the subselect adds `FOR UPDATE SKIP LOCKED`: it row-locks the
    // one candidate it returns and SKIPS any row another worker already locked,
    // so N concurrent workers each claim a DISTINCT job in one round — never the
    // same one twice, never blocking on each other. SQLite needs no such clause:
    // the runtime serializes every transaction over its single connection, so the
    // `UPDATE … WHERE id = (SELECT … LIMIT 1)` is already atomic against rivals.
    const lockClause = this.dialect === "postgres" ? " FOR UPDATE SKIP LOCKED" : "";

    // `?` order: lock (SET locked_until), now (SET updated_at), queue, now
    // (WHERE run_at <=). The single UPDATE … RETURNING is atomic on both drivers.
    return (await this.db
      .prepare(
        `UPDATE ${TABLE}
            SET status = 'running', attempts = attempts + 1, locked_until = ?, updated_at = ?
          WHERE id = (
            SELECT id FROM ${TABLE}
             WHERE status = 'ready' AND queue = ? AND run_at <= ?
             ORDER BY priority DESC, run_at ASC, id ASC
             LIMIT 1${lockClause}
          )
        RETURNING *`,
      )
      .get([lock, now, queue, now])) as Row | undefined;
  }

  /** Atomically claim the next eligible job, or `null` if the queue is idle. */
  async claim(queue: string = this.defaultQueue, visibilityMs = 30_000): Promise<Job | null> {
    const row = await this.claimRow(queue, visibilityMs);

    return row ? hydrate(row) : null;
  }

  /**
   * Claim and run exactly one job. Returns the outcome, or `null` when idle.
   *
   * `runOnce` does NOT reclaim stalled jobs — that is now a separate cadence
   * (see {@link Queue.work}'s `reclaimMs`), so a hot poll loop no longer issues a
   * RECLAIM `UPDATE` on every empty tick. A caller driving the queue manually
   * (or in a test) calls {@link Queue.reclaim} on whatever cadence it wants;
   * `work()` runs it on its own timer.
   */
  async runOnce(
    options: { queue?: string; visibilityMs?: number; onJob?: JobObserver } = {},
  ): Promise<RunResult | null> {
    const row = await this.claimRow(
      options.queue ?? this.defaultQueue,
      options.visibilityMs ?? 30_000,
    );
    if (!row) {
      return null;
    }

    // Bracket the processing span here, the moment after the claim resolves, so
    // `durationMs` measures the WORK (parse + handler + terminal transition) and
    // never the time the job waited in the queue.
    const start = performance.now();

    // The row is claimed (attempts incremented, locked) BEFORE the payload is
    // parsed. A poison payload — invalid JSON a producer wrote — must not throw
    // out of the runner and leave the row to be reclaimed and re-poisoned forever;
    // it routes through `fail()` from the claimed metadata, so `maxAttempts`
    // eventually retires it to `failed` like any other unrunnable job.
    const meta = hydrateMeta(row);
    let payload: JsonValue;
    try {
      payload = JSON.parse(row.payload) as JsonValue;
    } catch (error) {
      // `JSON.parse` only ever throws a `SyntaxError` (an `Error`), so reading
      // `.message` needs no non-Error fallback here.
      const cause = (error as Error).message;
      const outcome = await this.fail(
        meta,
        new QueueError("QUEUE_POISON_PAYLOAD", `Job ${meta.id} has an unparseable payload.`, {
          id: meta.id,
          cause,
        }),
      );

      return this.observed(meta, outcome, start, options.onJob);
    }

    const job: Job = { ...meta, payload };

    const handler = this.handlers.get(job.name);
    if (!handler) {
      const outcome = await this.fail(
        job,
        new QueueError("QUEUE_HANDLER_NOT_FOUND", `No handler for job "${job.name}".`),
      );

      return this.observed(job, outcome, start, options.onJob);
    }

    try {
      await handler(job.payload, { job, attempt: job.attempts });
      await this.complete(job);

      return this.observed(job, "done", start, options.onJob);
    } catch (error) {
      const outcome = await this.fail(job, error);

      return this.observed(job, outcome, start, options.onJob);
    }
  }

  /**
   * Assemble the {@link RunResult} and, if a sink is present, report the processed
   * job through it. The sink runs on the same metadata every outcome shares, after
   * the terminal transition has landed; a throwing sink is contained so a broken
   * observer can never break job processing or resurrect the very loop it watches.
   */
  private observed(
    job: Job,
    outcome: RunOutcome,
    start: number,
    onJob: JobObserver | undefined,
  ): RunResult {
    if (onJob) {
      try {
        onJob({
          queue: job.queue,
          id: job.id,
          name: job.name,
          outcome,
          attempt: job.attempts,
          durationMs: performance.now() - start,
        });
      } catch {
        // A throwing observability sink is not allowed to break job processing.
      }
    }

    return { job, outcome };
  }

  /** Start a polling worker. The returned handle drains gracefully on `stop()`. */
  work(options: WorkOptions = {}): Worker {
    const queue = options.queue ?? this.defaultQueue;
    const visibilityMs = options.visibilityMs ?? 30_000;
    const pollMs = options.pollMs ?? 200;
    const reclaimMs = options.reclaimMs ?? visibilityMs;
    const concurrency = options.concurrency ?? 1;
    const sleep = options.sleep ?? defaultSleep;
    const onError = options.onError;
    const onJob = options.onJob;

    let running = true;

    // Surface a poll failure through the observability seam without ever letting
    // the report itself break the loop — a broken reporter must not resurrect
    // the very fault this boundary exists to contain.
    const report = (error: unknown): void => {
      if (!onError) {
        return;
      }

      const failure =
        error instanceof QueueError
          ? error
          : new QueueError("QUEUE_WORKER_POLL_FAILED", "The worker poll loop hit an error.", {
              cause: error instanceof Error ? error.message : String(error),
            });

      try {
        onError(failure);
      } catch {
        // A throwing error-reporter is not allowed to kill the worker.
      }
    };

    // The poll loop's error boundary: a transient fault on claim/reclaim must
    // not kill the worker permanently. We report it, back off `pollMs` to avoid
    // hot-spinning on a persistent fault, and keep polling. At-least-once holds:
    // a job claimed before the throw stays `running` until its visibility
    // deadline lapses, then RECLAIM returns it for a later attempt.
    const loop = async (): Promise<void> => {
      while (running) {
        try {
          const result = await this.runOnce(
            onJob ? { queue, visibilityMs, onJob } : { queue, visibilityMs },
          );
          if (result === null) {
            await sleep(pollMs);
          }
        } catch (error) {
          report(error);
          await sleep(pollMs);
        }
      }
    };

    // RECLAIM on its OWN cadence, not per-poll. One reclaim sweep per `reclaimMs`
    // returns every job whose visibility deadline has lapsed to `ready` for the
    // worker loops above to re-claim. It shares the poll loop's error boundary —
    // a transient fault is reported and the cadence keeps going.
    //
    // The wait is sliced into `pollMs` chunks rather than one `sleep(reclaimMs)`
    // so `stop()` stays responsive: `reclaimMs` defaults to `visibilityMs` (30s),
    // and a single 30s sleep would make `stop()` block on this loop for up to
    // that long. Re-checking `running` every `pollMs` (and on the next clock tick
    // for a fired sweep) bounds the drain to one `pollMs`, exactly like the poll
    // loop above.
    const reclaimLoop = async (): Promise<void> => {
      let lastReclaim = this.clock().getTime();

      while (running) {
        await sleep(pollMs);

        if (!running) break;

        if (this.clock().getTime() - lastReclaim < reclaimMs) continue;

        lastReclaim = this.clock().getTime();

        try {
          await this.reclaim();
        } catch (error) {
          report(error);
        }
      }
    };

    const drained = Promise.all([
      ...Array.from({ length: concurrency }, () => loop()),
      reclaimLoop(),
    ]);

    return {
      stop: async (): Promise<void> => {
        running = false;
        await drained;
      },
    };
  }

  /**
   * A queue's health: per-status counts plus the two backlog signals
   * (`depth`, `oldestReadyAgeMs`) — for dashboards, MCP, tracing, and tests.
   */
  async stats(queue: string = this.defaultQueue): Promise<QueueStats> {
    // `COUNT(*)` comes back a STRING from node-postgres (it returns `bigint`
    // columns as strings to avoid precision loss); better-sqlite3 returns a
    // number. Type each count as `string | number` and coerce with `Number(…)`
    // so `stats()` always yields the numbers its return type promises — the same
    // coercion every other read path applies to Postgres-stringified integers.
    const counts = (await this.db
      .prepare(`SELECT status, COUNT(*) AS n FROM ${TABLE} WHERE queue = ? GROUP BY status`)
      .all([queue])) as Array<{ status: JobStatus; n: string | number }>;

    // The backlog = jobs `ready` AND already eligible (`run_at <= now`): the work
    // a worker could claim this instant. `depth` is its count; `oldest` is the
    // earliest `run_at` among them (ISO-8601 sorts chronologically, so `MIN` is
    // the oldest), from which the wait age is derived. A future-scheduled `ready`
    // job is excluded from BOTH — it is not yet a backlog.
    const now = nowIso(this.clock);
    const backlog = (await this.db
      .prepare(
        `SELECT COUNT(*) AS n, MIN(run_at) AS oldest
           FROM ${TABLE}
          WHERE queue = ? AND status = 'ready' AND run_at <= ?`,
      )
      .get([queue, now])) as { n: string | number; oldest: string | null };

    const stats = counts.reduce<Partial<Record<JobStatus, number>>>((acc, row) => {
      acc[row.status] = Number(row.n);

      return acc;
    }, {});

    // An empty backlog has no oldest job: `MIN` over zero rows is SQL `NULL`, so
    // the age is `null` rather than a misleading 0.
    const oldestReadyAgeMs =
      backlog.oldest === null ? null : this.clock().getTime() - new Date(backlog.oldest).getTime();

    return { ...stats, depth: Number(backlog.n), oldestReadyAgeMs };
  }

  /** Fetch one job by id, or `null`. */
  async find(id: number): Promise<Job | null> {
    const row = (await this.db.prepare(`SELECT * FROM ${TABLE} WHERE id = ?`).get([id])) as
      | Row
      | undefined;

    return row ? hydrate(row) : null;
  }

  // ---- the operator surface: what a dashboard reads + acts on ----
  //
  // `list` is the dashboard's read (jobs by status, paged); `retry` and
  // `discard` are its two management verbs. They are deliberately OUTSIDE the
  // claim/fence lifecycle — an operator acting from a UI is not a worker holding
  // a visibility lock, so these transitions are unfenced and idempotent by their
  // WHERE clause (retry only a `failed` job, discard only a non-`running` one).

  /**
   * List jobs for a dashboard: filtered by `status` and/or `queue`, paged,
   * newest-updated first.
   *
   * Ordered by `updated_at DESC, id DESC` so the most recently-touched jobs (a
   * just-failed job, a just-finished one) surface at the top — what an operator
   * watching a queue wants to see first — with `id` breaking ties for a stable
   * page. A poison (unparseable) payload row is tolerated: it hydrates through
   * the same coded `QUEUE_POISON_PAYLOAD` path as `find`, so one corrupt row is a
   * loud, branchable error rather than a silent `SyntaxError` mid-list.
   */
  async list(options: ListJobsOptions = {}): Promise<Job[]> {
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;

    // Build the WHERE from only the filters that are present, so an absent
    // `status`/`queue` widens rather than matches `NULL`. Params track the
    // clauses positionally.
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (options.status !== undefined) {
      clauses.push("status = ?");
      params.push(options.status);
    }

    if (options.queue !== undefined) {
      clauses.push("queue = ?");
      params.push(options.queue);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

    const rows = (await this.db
      .prepare(
        `SELECT * FROM ${TABLE} ${where}
          ORDER BY updated_at DESC, id DESC
          LIMIT ? OFFSET ?`,
      )
      .all([...params, limit, offset])) as Row[];

    return rows.map(hydrate);
  }

  /**
   * Retry a `failed` job NOW — the dashboard's "retry" button.
   *
   * Resets the job to `ready` with its attempt counter cleared and `run_at` set
   * to now, so a worker claims it on the next poll. Fenced on `status = 'failed'`:
   * retrying a `done` or in-flight job is a no-op (returns `false`), so a
   * double-click or a stale dashboard view can never resurrect a running job.
   * Returns whether a row was actually re-queued.
   */
  async retry(id: number): Promise<boolean> {
    const now = nowIso(this.clock);

    const result = await this.db
      .prepare(
        `UPDATE ${TABLE}
            SET status = 'ready', attempts = 0, last_error = NULL,
                locked_until = NULL, finished_at = NULL, run_at = ?, updated_at = ?
          WHERE id = ? AND status = 'failed'`,
      )
      .run([now, now, id]);

    return result.changes > 0;
  }

  /**
   * Discard a job — the dashboard's "discard"/"delete" button.
   *
   * Deletes the row outright (and any dependency edges naming it). Refuses a
   * `running` job: discarding a row a worker holds would let that worker's
   * terminal write race a delete, so an operator must wait for it to finish or
   * for its visibility to lapse. Returns whether a row was removed (`false` for
   * an unknown id or a running job).
   *
   * Discarding a PREREQUISITE re-evaluates its dependents, so a discarded
   * prerequisite never strands a `blocked` dependent forever: the dependent is
   * treated as if that prerequisite had settled (the queue's chosen semantics —
   * discarding a prerequisite UNBLOCKS its dependents, releasing any whose every
   * other remaining prerequisite is already `done`). The order inside the
   * transaction is load-bearing: delete the row, THEN
   * {@link Queue.releaseReadyDependents} (the dependents are still discoverable
   * via the `depends_on_id` edges, and the JOIN no longer finds the deleted
   * prerequisite, so it counts as satisfied), THEN sweep the edges.
   */
  async discard(id: number): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const result = await tx
        .prepare(`DELETE FROM ${TABLE} WHERE id = ? AND status <> 'running'`)
        .run([id]);

      if (result.changes === 0) {
        return false;
      }

      // Re-evaluate this job's dependents BEFORE sweeping the edges that name it:
      // the release reads the dependents through the `depends_on_id = id` edges,
      // and the just-deleted prerequisite row no longer joins, so a dependent
      // whose only remaining unsettled prerequisite was this one is released
      // rather than stranded `blocked` forever. (`complete` only ever fires the
      // release, and a discarded prerequisite never completes — this is the
      // missing trigger.) Run it on `tx` so it stays inside this transaction.
      await this.releaseReadyDependents(id, tx);

      // Sweep the edges that named this job on either side, so a discarded job
      // leaves no dangling dependency that could block a sibling forever.
      await tx
        .prepare(`DELETE FROM ${DEPS_TABLE} WHERE job_id = ? OR depends_on_id = ?`)
        .run([id, id]);

      return true;
    });
  }

  // ---- private: the three terminal transitions ----
  //
  // Each is FENCED by the claim lock as a token: `status = 'running' AND
  // locked_until = <the value this worker stamped at claim>`. If a slow worker's
  // visibility deadline lapsed and RECLAIM returned the row to `ready` (or another
  // worker re-claimed it and stamped a fresh `locked_until`), this worker's
  // terminal update matches ZERO rows and is a no-op — it can never resurrect a
  // job another worker now owns, nor mark `done` a row that was already retried.

  private async complete(job: Job): Promise<void> {
    const now = nowIso(this.clock);

    // `?` order: now (finished_at), now (updated_at), id, locked_until (fence).
    const result = await this.db
      .prepare(
        `UPDATE ${TABLE}
            SET status = 'done', locked_until = NULL, finished_at = ?, updated_at = ?
          WHERE id = ? AND status = 'running' AND locked_until = ?`,
      )
      .run([now, now, job.id, job.lockedUntil]);

    // Release dependents ONLY if THIS worker actually landed the `done`
    // transition (the fence matched its row). A stale worker whose visibility
    // lapsed matches zero rows here — it no longer owns the job, so it must not
    // release the job's dependents on a completion it did not perform. Gating on
    // `changes` keeps the at-least-once `complete` from double-advancing a DAG.
    //
    // A batchless job has no rows in `lesto_job_deps`, so the release `UPDATE`
    // matches nothing and is a cheap no-op — the common path pays one indexed
    // statement and the dependency machinery stays invisible to non-batch work.
    if (result.changes > 0) {
      await this.releaseReadyDependents(job.id);
    }
  }

  private async fail(job: Job, error: unknown): Promise<"retry" | "failed"> {
    const now = nowIso(this.clock);
    const message = error instanceof Error ? error.message : String(error);

    // A handler can mark its failure PERMANENT (see `permanentFailure`): the
    // work can never succeed on a later attempt — an SSRF-blocked URL, a payload
    // no handler version can process — so retrying is pure waste. Treat it like
    // an exhausted job and retire it to `failed` after THIS attempt, regardless
    // of how many `maxAttempts` remain. A normal failure still retries below.
    if (job.attempts >= job.maxAttempts || isPermanentFailure(error)) {
      // `?` order: error (last_error), now (finished_at), now (updated_at), id,
      // locked_until (fence).
      await this.db
        .prepare(
          `UPDATE ${TABLE}
              SET status = 'failed', last_error = ?, locked_until = NULL,
                  finished_at = ?, updated_at = ?
            WHERE id = ? AND status = 'running' AND locked_until = ?`,
        )
        .run([message, now, now, job.id, job.lockedUntil]);

      return "failed";
    }

    // `?` order: error (last_error), runAt (run_at), now (updated_at), id,
    // locked_until (fence).
    await this.db
      .prepare(
        `UPDATE ${TABLE}
            SET status = 'ready', last_error = ?, locked_until = NULL,
                run_at = ?, updated_at = ?
          WHERE id = ? AND status = 'running' AND locked_until = ?`,
      )
      .run([
        message,
        isoAfter(this.clock, this.backoffMs(job.attempts)),
        now,
        job.id,
        job.lockedUntil,
      ]);

    return "retry";
  }

  private backoffMs(attempts: number): number {
    const exponential = this.baseBackoffMs * 2 ** (attempts - 1);

    return Math.min(this.maxBackoffMs, exponential);
  }
}

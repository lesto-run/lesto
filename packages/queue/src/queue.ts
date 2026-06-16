import { QueueError } from "./errors";
import { isoAfter, nowIso, systemClock } from "./time";

import type {
  Clock,
  Dialect,
  EnqueueOptions,
  Job,
  JobHandler,
  JobObserver,
  JobStatus,
  JsonValue,
  QueueStats,
  RunOutcome,
  RunResult,
  SqlDatabase,
} from "./types";

const TABLE = "keel_jobs";

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

  await db.exec(`
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
      created_at    TEXT    NOT NULL,
      updated_at    TEXT    NOT NULL,
      finished_at   TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_${TABLE}_claim
      ON ${TABLE} (status, queue, run_at);
  `);
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

  /** Claim and run exactly one job. Returns the outcome, or `null` when idle. */
  async runOnce(
    options: { queue?: string; visibilityMs?: number; onJob?: JobObserver } = {},
  ): Promise<RunResult | null> {
    await this.reclaim();

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

    const drained = Promise.all(Array.from({ length: concurrency }, () => loop()));

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
    await this.db
      .prepare(
        `UPDATE ${TABLE}
            SET status = 'done', locked_until = NULL, finished_at = ?, updated_at = ?
          WHERE id = ? AND status = 'running' AND locked_until = ?`,
      )
      .run([now, now, job.id, job.lockedUntil]);
  }

  private async fail(job: Job, error: unknown): Promise<"retry" | "failed"> {
    const now = nowIso(this.clock);
    const message = error instanceof Error ? error.message : String(error);

    if (job.attempts >= job.maxAttempts) {
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

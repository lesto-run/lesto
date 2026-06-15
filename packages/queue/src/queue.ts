import { QueueError } from "./errors";
import { isoAfter, nowIso, systemClock } from "./time";

import type {
  Clock,
  Dialect,
  EnqueueOptions,
  Job,
  JobHandler,
  JobStatus,
  JsonValue,
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
 */

/**
 * Create the jobs table. Idempotent; call it from a migration or once at boot.
 *
 * `dialect` defaults to `"sqlite"`; pass `"postgres"` to declare the surrogate
 * key as a `BIGINT … GENERATED ALWAYS AS IDENTITY` column (Postgres has no
 * `AUTOINCREMENT` keyword, and an int4 key would cap the queue at ~2.1B jobs).
 * Every other column is spelled identically on both engines.
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

function hydrate(row: Row): Job {
  return {
    // `id` is a BIGINT on Postgres, which node-postgres returns as a string;
    // coerce so `Job.id` is always the `number` its type promises (the integer
    // counters are int4 → already numbers, but `Number()` is idempotent on them).
    id: Number(row.id),
    queue: row.queue,
    name: row.name,
    payload: JSON.parse(row.payload) as JsonValue,
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

export interface QueueOptions {
  readonly db: SqlDatabase;
  readonly clock?: Clock;
  readonly defaultQueue?: string;
  readonly baseBackoffMs?: number;
  readonly maxBackoffMs?: number;
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

  private readonly handlers = new Map<string, JobHandler>();

  constructor(options: QueueOptions) {
    this.db = options.db;
    this.clock = options.clock ?? systemClock;
    this.defaultQueue = options.defaultQueue ?? "default";
    this.baseBackoffMs = options.baseBackoffMs ?? 1000;
    this.maxBackoffMs = options.maxBackoffMs ?? 60_000;
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

  /** Atomically claim the next eligible job, or `null` if the queue is idle. */
  async claim(queue: string = this.defaultQueue, visibilityMs = 30_000): Promise<Job | null> {
    const now = nowIso(this.clock);
    const lock = isoAfter(this.clock, visibilityMs);

    // `?` order: lock (SET locked_until), now (SET updated_at), queue, now
    // (WHERE run_at <=). The single UPDATE … RETURNING is atomic on both drivers.
    const row = (await this.db
      .prepare(
        `UPDATE ${TABLE}
            SET status = 'running', attempts = attempts + 1, locked_until = ?, updated_at = ?
          WHERE id = (
            SELECT id FROM ${TABLE}
             WHERE status = 'ready' AND queue = ? AND run_at <= ?
             ORDER BY priority DESC, run_at ASC, id ASC
             LIMIT 1
          )
        RETURNING *`,
      )
      .get([lock, now, queue, now])) as Row | undefined;

    return row ? hydrate(row) : null;
  }

  /** Claim and run exactly one job. Returns the outcome, or `null` when idle. */
  async runOnce(
    options: { queue?: string; visibilityMs?: number } = {},
  ): Promise<RunResult | null> {
    await this.reclaim();

    const job = await this.claim(
      options.queue ?? this.defaultQueue,
      options.visibilityMs ?? 30_000,
    );
    if (!job) {
      return null;
    }

    const handler = this.handlers.get(job.name);
    if (!handler) {
      const outcome = await this.fail(
        job,
        new QueueError("QUEUE_HANDLER_NOT_FOUND", `No handler for job "${job.name}".`),
      );

      return { job, outcome };
    }

    try {
      await handler(job.payload, { job, attempt: job.attempts });
      await this.complete(job);

      return { job, outcome: "done" };
    } catch (error) {
      const outcome = await this.fail(job, error);

      return { job, outcome };
    }
  }

  /** Start a polling worker. The returned handle drains gracefully on `stop()`. */
  work(options: WorkOptions = {}): Worker {
    const queue = options.queue ?? this.defaultQueue;
    const visibilityMs = options.visibilityMs ?? 30_000;
    const pollMs = options.pollMs ?? 200;
    const concurrency = options.concurrency ?? 1;
    const sleep = options.sleep ?? defaultSleep;
    const onError = options.onError;

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
          const result = await this.runOnce({ queue, visibilityMs });
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

  /** A count of jobs by status for one queue — for dashboards, MCP, and tests. */
  async stats(queue: string = this.defaultQueue): Promise<Partial<Record<JobStatus, number>>> {
    const rows = (await this.db
      .prepare(`SELECT status, COUNT(*) AS n FROM ${TABLE} WHERE queue = ? GROUP BY status`)
      .all([queue])) as Array<{ status: JobStatus; n: number }>;

    return rows.reduce<Partial<Record<JobStatus, number>>>((counts, row) => {
      counts[row.status] = row.n;

      return counts;
    }, {});
  }

  /** Fetch one job by id, or `null`. */
  async find(id: number): Promise<Job | null> {
    const row = (await this.db.prepare(`SELECT * FROM ${TABLE} WHERE id = ?`).get([id])) as
      | Row
      | undefined;

    return row ? hydrate(row) : null;
  }

  // ---- private: the three terminal transitions ----

  private async complete(job: Job): Promise<void> {
    const now = nowIso(this.clock);

    // `?` order: now (finished_at), now (updated_at), id.
    await this.db
      .prepare(
        `UPDATE ${TABLE}
            SET status = 'done', locked_until = NULL, finished_at = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run([now, now, job.id]);
  }

  private async fail(job: Job, error: unknown): Promise<"retry" | "failed"> {
    const now = nowIso(this.clock);
    const message = error instanceof Error ? error.message : String(error);

    if (job.attempts >= job.maxAttempts) {
      // `?` order: error (last_error), now (finished_at), now (updated_at), id.
      await this.db
        .prepare(
          `UPDATE ${TABLE}
              SET status = 'failed', last_error = ?, locked_until = NULL,
                  finished_at = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run([message, now, now, job.id]);

      return "failed";
    }

    // `?` order: error (last_error), runAt (run_at), now (updated_at), id.
    await this.db
      .prepare(
        `UPDATE ${TABLE}
            SET status = 'ready', last_error = ?, locked_until = NULL,
                run_at = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run([message, isoAfter(this.clock, this.backoffMs(job.attempts)), now, job.id]);

    return "retry";
  }

  private backoffMs(attempts: number): number {
    const exponential = this.baseBackoffMs * 2 ** (attempts - 1);

    return Math.min(this.maxBackoffMs, exponential);
  }
}

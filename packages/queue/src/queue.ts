import { QueueError } from "./errors";
import { isoAfter, nowIso, systemClock } from "./time";

import type {
  Clock,
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
 * RETURNING *`. The Postgres driver will swap in `… FOR UPDATE SKIP LOCKED` for
 * true multi-worker concurrency — behind this exact API.
 */

/** Create the jobs table. Idempotent; call it from a migration or once at boot. */
export function installSchema(db: SqlDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
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
    id: row.id,
    queue: row.queue,
    name: row.name,
    payload: JSON.parse(row.payload) as JsonValue,
    status: row.status,
    priority: row.priority,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
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
  enqueue(name: string, payload: JsonValue = {}, options: EnqueueOptions = {}): number {
    const now = nowIso(this.clock);
    const runAt = this.eligibleAt(options);

    const result = this.db
      .prepare(
        `INSERT INTO ${TABLE}
           (queue, name, payload, status, priority, max_attempts, run_at, created_at, updated_at)
         VALUES
           (@queue, @name, @payload, 'ready', @priority, @maxAttempts, @runAt, @now, @now)`,
      )
      .run({
        queue: options.queue ?? this.defaultQueue,
        name,
        payload: JSON.stringify(payload),
        priority: options.priority ?? 0,
        maxAttempts: options.maxAttempts ?? 5,
        runAt,
        now,
      });

    return Number(result.lastInsertRowid);
  }

  /** Return any job stranded past its visibility deadline to `ready`. */
  reclaim(): number {
    return this.db
      .prepare(
        `UPDATE ${TABLE}
            SET status = 'ready', locked_until = NULL, updated_at = @now
          WHERE status = 'running'
            AND locked_until IS NOT NULL
            AND locked_until < @now`,
      )
      .run({ now: nowIso(this.clock) }).changes;
  }

  /** Atomically claim the next eligible job, or `null` if the queue is idle. */
  claim(queue: string = this.defaultQueue, visibilityMs = 30_000): Job | null {
    const row = this.db
      .prepare(
        `UPDATE ${TABLE}
            SET status = 'running', attempts = attempts + 1, locked_until = @lock, updated_at = @now
          WHERE id = (
            SELECT id FROM ${TABLE}
             WHERE status = 'ready' AND queue = @queue AND run_at <= @now
             ORDER BY priority DESC, run_at ASC, id ASC
             LIMIT 1
          )
        RETURNING *`,
      )
      .get({ queue, now: nowIso(this.clock), lock: isoAfter(this.clock, visibilityMs) }) as
      | Row
      | undefined;

    return row ? hydrate(row) : null;
  }

  /** Claim and run exactly one job. Returns the outcome, or `null` when idle. */
  async runOnce(
    options: { queue?: string; visibilityMs?: number } = {},
  ): Promise<RunResult | null> {
    this.reclaim();

    const job = this.claim(options.queue ?? this.defaultQueue, options.visibilityMs ?? 30_000);
    if (!job) {
      return null;
    }

    const handler = this.handlers.get(job.name);
    if (!handler) {
      const outcome = this.fail(
        job,
        new QueueError("QUEUE_HANDLER_NOT_FOUND", `No handler for job "${job.name}".`),
      );

      return { job, outcome };
    }

    try {
      await handler(job.payload, { job, attempt: job.attempts });
      this.complete(job);

      return { job, outcome: "done" };
    } catch (error) {
      const outcome = this.fail(job, error);

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
  stats(queue: string = this.defaultQueue): Partial<Record<JobStatus, number>> {
    const rows = this.db
      .prepare(`SELECT status, COUNT(*) AS n FROM ${TABLE} WHERE queue = @queue GROUP BY status`)
      .all({ queue }) as Array<{ status: JobStatus; n: number }>;

    return rows.reduce<Partial<Record<JobStatus, number>>>((counts, row) => {
      counts[row.status] = row.n;

      return counts;
    }, {});
  }

  /** Fetch one job by id, or `null`. */
  find(id: number): Job | null {
    const row = this.db.prepare(`SELECT * FROM ${TABLE} WHERE id = @id`).get({ id }) as
      | Row
      | undefined;

    return row ? hydrate(row) : null;
  }

  // ---- private: the three terminal transitions ----

  private complete(job: Job): void {
    const now = nowIso(this.clock);

    this.db
      .prepare(
        `UPDATE ${TABLE}
            SET status = 'done', locked_until = NULL, finished_at = @now, updated_at = @now
          WHERE id = @id`,
      )
      .run({ id: job.id, now });
  }

  private fail(job: Job, error: unknown): "retry" | "failed" {
    const now = nowIso(this.clock);
    const message = error instanceof Error ? error.message : String(error);

    if (job.attempts >= job.maxAttempts) {
      this.db
        .prepare(
          `UPDATE ${TABLE}
              SET status = 'failed', last_error = @error, locked_until = NULL,
                  finished_at = @now, updated_at = @now
            WHERE id = @id`,
        )
        .run({ id: job.id, error: message, now });

      return "failed";
    }

    this.db
      .prepare(
        `UPDATE ${TABLE}
            SET status = 'ready', last_error = @error, locked_until = NULL,
                run_at = @runAt, updated_at = @now
          WHERE id = @id`,
      )
      .run({
        id: job.id,
        error: message,
        runAt: isoAfter(this.clock, this.backoffMs(job.attempts)),
        now,
      });

    return "retry";
  }

  private backoffMs(attempts: number): number {
    const exponential = this.baseBackoffMs * 2 ** (attempts - 1);

    return Math.min(this.maxBackoffMs, exponential);
  }
}

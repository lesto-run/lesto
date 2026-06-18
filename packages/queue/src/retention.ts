import { QueueError } from "./errors";

/**
 * An epoch-ms clock — `() => number`, NOT the queue's `() => Date` {@link
 * import("./types").Clock}. The sweeps this recipe drives (`cache.sweep`,
 * `session.deleteExpired`, `ratelimit.sweep`) all compare epoch-ms deadlines, so
 * the `now` handed to each task must be the millisecond number they expect — the
 * same `Clock` shape `@lesto/cache` and the SQL stores use. Declared locally so
 * the recipe takes no extra import and the type difference is explicit.
 */
export type RetentionClock = () => number;

/**
 * The retention recipe: run periodic SWEEPS on their own cadences.
 *
 * Lesto's durable stores all expose a cheap delete-the-dead verb — the queue's
 * {@link import("./queue").Queue.prune} (terminal jobs) and {@link
 * import("./queue").Queue.reclaim} (stalled jobs), `@lesto/cache`'s
 * `sqlStore(db).sweep(now)`, `@lesto/auth`'s `sqlSessionStore(db).deleteExpired(now)`,
 * `@lesto/ratelimit`'s `sqlRateLimitStore(db).sweep(before)` — but each deliberately
 * starts NO timer (the store stays a passive value; the caller owns the clock).
 * This recipe is where an app wires those verbs to a cadence, in ONE place,
 * without the queue taking a dependency on any of those packages — each task is
 * just a `run` closure the caller supplies.
 *
 * It mirrors the {@link import("./scheduler").Scheduler} shape: all the deciding
 * is in `tick(now)`, a pure function of the clock, so it is testable with no real
 * timers; `start()` is the thin wire that calls `tick` on a cadence with a
 * no-overlap guard. The SAME single-instance deployment constraint applies as the
 * scheduler's — a sweep is idempotent (deleting an already-deleted row is a
 * no-op), so a second instance double-sweeping is merely wasteful, never
 * incorrect, but running it on one designated instance is still the recipe.
 */

/** One retention task: delete the dead on its own cadence. */
export interface RetentionTask {
  /** A label for diagnostics (the `RETENTION_TASK_FAILED` error carries it). */
  readonly name: string;

  /** How often this task runs, in ms. Each task keeps its own clock. */
  readonly everyMs: number;

  /**
   * Do the sweep at `now` (epoch ms). Returns how many rows it deleted — purely
   * informational (summed into {@link RetentionResult.deleted}); the recipe never
   * branches on the count. Wrap the store verb here:
   *
   *   { name: "queue", everyMs: 3_600_000, run: () => queue.prune(7 * DAY_MS) }
   *   { name: "cache", everyMs:   600_000, run: (now) => cacheStore.sweep(now) }
   *   { name: "sessions", everyMs: 3_600_000, run: (now) => sessionStore.deleteExpired(now) }
   */
  readonly run: (now: number) => Promise<number>;
}

/** What one {@link RetentionScheduler.tick} did. */
export interface RetentionResult {
  /** How many tasks were due and ran this tick. */
  readonly ran: number;

  /** Total rows deleted across those tasks. */
  readonly deleted: number;
}

export interface RetentionOptions {
  readonly tasks: readonly RetentionTask[];

  /** Epoch-ms clock, injectable for deterministic tests. Defaults to `Date.now`. */
  readonly clock?: RetentionClock;
}

export interface RetentionStartOptions {
  /** How often the cadence fires (and re-evaluates which tasks are due). Defaults to 60s. */
  readonly intervalMs?: number;

  readonly setInterval?: (callback: () => void, ms: number) => unknown;
  readonly clearInterval?: (handle: unknown) => void;

  /**
   * Where a task's rejection goes. A sweep that throws (a transient DB fault)
   * must not become an unhandled rejection, and one failing task must not stop
   * the others — so each is caught and routed here as a coded
   * `RETENTION_TASK_FAILED` {@link QueueError} carrying the task name. Absent →
   * the fault is swallowed and retried next cadence (the scheduler's default).
   */
  readonly onError?: (error: QueueError) => void;
}

export interface RetentionHandle {
  stop(): void;
}

/** A per-task record of when it last ran (heap-local, like the scheduler's intervals). */
interface TaskState {
  readonly task: RetentionTask;
  lastRunAt: number | null;
}

/**
 * Drives a set of {@link RetentionTask}s, each on its own `everyMs` cadence.
 *
 * The {@link RetentionClock} is the epoch-ms shape `@lesto/cache` and the SQL
 * stores use (NOT the queue's `Date` clock — these sweeps compare epoch-ms
 * deadlines), so the `now` handed to each `run` is exactly what
 * `sweep`/`deleteExpired` expect.
 */
export class RetentionScheduler {
  private readonly clock: RetentionClock;

  private readonly states: TaskState[];

  constructor(options: RetentionOptions) {
    this.clock = options.clock ?? (() => Date.now());
    this.states = options.tasks.map((task) => ({ task, lastRunAt: null }));
  }

  /**
   * Run every task whose cadence is due at `now`. Returns how many ran and the
   * total rows they deleted. A task runs on its first ever tick, then whenever at
   * least `everyMs` has elapsed since its last run — the same interval rule the
   * {@link import("./scheduler").Scheduler}'s `every` entries use.
   *
   * Tasks run SEQUENTIALLY (not in parallel) so several large deletes never pile
   * onto one connection at once. A task that REJECTS aborts this `tick` at that
   * task — `start()`'s catch routes it to `onError`, and the next cadence retries
   * the whole set; tasks already run this tick keep their stamped `lastRunAt`.
   */
  async tick(now: number = this.clock()): Promise<RetentionResult> {
    let ran = 0;
    let deleted = 0;

    for (const state of this.states) {
      const due = state.lastRunAt === null || now - state.lastRunAt >= state.task.everyMs;

      if (!due) continue;

      state.lastRunAt = now;
      deleted += await state.task.run(now);
      ran += 1;
    }

    return { ran, deleted };
  }

  /** Begin sweeping on a cadence. The handle stops it. */
  start(options: RetentionStartOptions = {}): RetentionHandle {
    const intervalMs = options.intervalMs ?? 60_000;
    const setTimer = options.setInterval ?? ((callback, ms) => setInterval(callback, ms));
    const clearTimer = options.clearInterval ?? ((handle) => clearInterval(handle as never));
    const onError = options.onError;

    // No-overlap: a slow tick (a big delete) must not let the next cadence fire a
    // second concurrent tick over the same connection — skip instead, exactly as
    // the scheduler guards its async `tick`.
    let ticking = false;

    const handle = setTimer(() => {
      if (ticking) return;

      ticking = true;

      void this.tick()
        .catch((error: unknown) => {
          if (onError === undefined) return;

          // Surface the task fault as a coded, branchable error — without the
          // report itself escaping to crash the timer.
          const failure =
            error instanceof QueueError
              ? error
              : new QueueError("RETENTION_TASK_FAILED", "A retention sweep failed.", {
                  cause: error instanceof Error ? error.message : String(error),
                });

          try {
            onError(failure);
          } catch {
            // A throwing error-reporter must not kill the retention cadence.
          }
        })
        .finally(() => {
          ticking = false;
        });
    }, intervalMs);

    return {
      stop: (): void => clearTimer(handle),
    };
  }
}

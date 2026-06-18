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

/** A job moves: ready → running → (done | failed), with running → ready on reclaim. */
export type JobStatus = "ready" | "running" | "done" | "failed";

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

/** A clock we can stop. Injected everywhere time matters, so tests are deterministic. */
export type Clock = () => Date;

/**
 * Which SQL dialect the queue speaks. Defaults to `"sqlite"`. It selects the
 * surrogate-key DDL ({@link installSchema}) and the row-locking clause in the
 * atomic claim (`FOR UPDATE SKIP LOCKED` on Postgres). Mirrors `@volo/db`'s
 * `Dialect`.
 */
export type Dialect = "sqlite" | "postgres";

// ---- the minimal SQL surface (driver-agnostic) ----
//
// This surface is OWNED by `@volo/db`, not redeclared here. The queue once
// carried its own structurally-identical copy, which made `@volo/db`'s
// `SqlDatabase` and the queue's two *nominally distinct* types: sharing one
// `openSqlite` handle across `createDb` and `new Queue({ db })` forced a
// `handle as unknown as SqlDatabase` cast even though the shapes matched to the
// method. Re-exporting the canonical `@volo/db` types instead means a single
// handle flows into `createDb`, `new Queue({ db })`, and `installSchema` with NO
// cast (ADR 0006's async terminals, positional params, and sync `prepare` are
// all defined there). `@volo/queue` adding `@volo/db` to its dependencies is the
// only cost; the queue still speaks the same minimal surface, just by reference.
export type { SqlDatabase, SqlStatement } from "@volo/db";

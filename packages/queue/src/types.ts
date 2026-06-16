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

/** A clock we can stop. Injected everywhere time matters, so tests are deterministic. */
export type Clock = () => Date;

/**
 * Which SQL dialect the queue speaks. Defaults to `"sqlite"`. It selects the
 * surrogate-key DDL ({@link installSchema}) and the row-locking clause in the
 * atomic claim (`FOR UPDATE SKIP LOCKED` on Postgres). Mirrors `@keel/db`'s
 * `Dialect`.
 */
export type Dialect = "sqlite" | "postgres";

// ---- the minimal SQL surface (driver-agnostic) ----
//
// This surface is OWNED by `@keel/db`, not redeclared here. The queue once
// carried its own structurally-identical copy, which made `@keel/db`'s
// `SqlDatabase` and the queue's two *nominally distinct* types: sharing one
// `openSqlite` handle across `createDb` and `new Queue({ db })` forced a
// `handle as unknown as SqlDatabase` cast even though the shapes matched to the
// method. Re-exporting the canonical `@keel/db` types instead means a single
// handle flows into `createDb`, `new Queue({ db })`, and `installSchema` with NO
// cast (ADR 0006's async terminals, positional params, and sync `prepare` are
// all defined there). `@keel/queue` adding `@keel/db` to its dependencies is the
// only cost; the queue still speaks the same minimal surface, just by reference.
export type { SqlDatabase, SqlStatement } from "@keel/db";

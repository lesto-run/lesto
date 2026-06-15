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
// The terminals are **asynchronous** (ADR 0006): `run` / `get` / `all` and
// `exec` return Promises so a networked Postgres pool — which speaks over a
// socket — can back the same surface as in-process SQLite. `prepare(sql)` stays
// *synchronous*: it only compiles a statement object; binding + execution is
// what awaits. There is no sync escape hatch.
//
// Parameters are *positional* (an ordered array), to keep the contract scalar
// across SQLite (variadic binds) and Postgres (`$1`, `$2`). Where a value is
// reused inside one statement, it is repeated at each `?` position.

export interface SqlStatement {
  /**
   * Execute a write. `lastInsertRowid` is **optional**: SQLite supplies it
   * natively, but Postgres has no implicit row id (use `RETURNING id`), so a
   * driver may omit it.
   */
  run(params?: unknown[]): Promise<{ changes: number; lastInsertRowid?: number | bigint }>;
  get(params?: unknown[]): Promise<unknown>;
  all(params?: unknown[]): Promise<unknown[]>;
}

export interface SqlDatabase {
  exec(sql: string): Promise<void>;

  prepare(sql: string): SqlStatement;

  /**
   * Run `fn` inside a single transaction on a single connection. Commits when
   * `fn` resolves, rolls back when it rejects (re-raising the original error).
   *
   * First-class because correctness depends on it: on a pooled driver, separate
   * `exec("BEGIN")` / `exec("COMMIT")` calls would land on *different* pooled
   * connections and the transaction would silently wrap nothing.
   */
  transaction<T>(fn: (tx: SqlDatabase) => Promise<T>): Promise<T>;
}

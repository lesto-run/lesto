/**
 * The vocabulary of durable workflows.
 *
 * A workflow depends on a *minimal SQL surface* — not on any one driver.
 * better-sqlite3 satisfies it structurally in tests; a Postgres driver will
 * satisfy the same shape in production, and the engine never knows the difference.
 */

// ---- the minimal SQL surface (driver-agnostic, async per ADR 0006) ----
//
// The I/O terminals (`run`/`get`/`exec`) return Promises so the seam can be
// backed by a networked pool (Postgres) — not just an in-process engine.
// `prepare()` STAYS SYNCHRONOUS: it only builds a statement handle; binding +
// execution is what touches the wire. No sync-over-async shim, ever.

export interface SqlStatement {
  run(params?: unknown[]): Promise<{ changes: number }>;
  get(params?: unknown[]): Promise<unknown>;
}

export interface SqlDatabase {
  exec(sql: string): Promise<void>;
  prepare(sql: string): SqlStatement;
  /**
   * Run `fn` inside a single transaction, pinned to one connection. Commits on
   * resolve, rolls back on throw. First-class so atomic spans never rely on raw
   * `exec("BEGIN")` DDL, which would no-op across a pooled connection.
   */
  transaction<T>(fn: (tx: SqlDatabase) => Promise<T>): Promise<T>;
}

/** A sleep, made injectable — so tests never wait on a real timer. */
export type Sleep = (ms: number) => Promise<void>;

/**
 * The handle a workflow body uses to do durable work.
 *
 * `step` memoizes: its first run for a given (runId, key) persists the result;
 * every later run with the same key returns that result without calling `fn`.
 * `sleep` delegates to the injected sleep.
 */
export interface WorkflowContext {
  step<T>(key: string, fn: () => T | Promise<T>): Promise<T>;
  sleep(ms: number): Promise<void>;
}

/** A workflow is just an async function from input to output, given a context. */
export type WorkflowFn<I, O> = (input: I, ctx: WorkflowContext) => Promise<O>;

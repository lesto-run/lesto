/**
 * The vocabulary of durable workflows.
 *
 * A workflow depends on a *minimal SQL surface* — not on any one driver.
 * better-sqlite3 satisfies it structurally in tests; a Postgres driver will
 * satisfy the same shape in production, and the engine never knows the difference.
 */

// ---- the minimal SQL surface (driver-agnostic) ----

export interface SqlStatement {
  run(params?: unknown[]): { changes: number };
  get(params?: unknown[]): unknown;
}

export interface SqlDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): SqlStatement;
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

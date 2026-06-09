import { WorkflowError } from "./errors";
import { systemSleep } from "./sleep";

import type { Sleep, SqlDatabase, WorkflowContext, WorkflowFn } from "./types";

const TABLE = "keel_workflow_steps";

/**
 * Create the step-journal table. Idempotent; call it from a migration or once at boot.
 *
 * One row per completed step, keyed by (run_id, step_key). The presence of a row
 * IS the durable record that the step ran; its `result` is the memoized value.
 */
export function installWorkflowSchema(db: SqlDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      run_id    TEXT NOT NULL,
      step_key  TEXT NOT NULL,
      result    TEXT NOT NULL,
      PRIMARY KEY (run_id, step_key)
    );
  `);
}

/** The persisted shape of a step row. A true narrowing of the DB row. */
interface StepRow {
  result: string;
}

export interface EngineOptions {
  readonly db: SqlDatabase;
  readonly sleep?: Sleep;
}

/**
 * The durable workflow engine.
 *
 * A workflow is an async function composed of steps. Each step's result is
 * persisted the first time it runs, so re-running the same run id SKIPS already
 * completed steps and replays their results — crash-safe resume, DBOS-style.
 * No external engine, no Postgres required: it runs on any `SqlDatabase`.
 */
export class Engine {
  readonly #db: SqlDatabase;

  readonly #sleep: Sleep;

  // The registry of known workflows, by name.
  readonly #workflows = new Map<string, WorkflowFn<never, unknown>>();

  constructor(options: EngineOptions) {
    this.#db = options.db;

    // Honor an injected sleep; otherwise wait on a real timer.
    this.#sleep = options.sleep ?? systemSleep;
  }

  /** Register a workflow under a name. Chainable. */
  define<I, O>(name: string, fn: WorkflowFn<I, O>): this {
    this.#workflows.set(name, fn as WorkflowFn<never, unknown>);

    return this;
  }

  /** Look up a completed step's memoized result, or undefined if it never ran. */
  #read(runId: string, key: string): StepRow | undefined {
    const row = this.#db
      .prepare(`SELECT result FROM ${TABLE} WHERE run_id = ? AND step_key = ?`)
      .get([runId, key]);

    // No row means the step has not completed for this run.
    if (row === undefined || row === null) return undefined;

    return row as StepRow;
  }

  /** Persist a step's result so future runs replay it instead of re-executing. */
  #write(runId: string, key: string, result: string): void {
    this.#db
      .prepare(`INSERT INTO ${TABLE} (run_id, step_key, result) VALUES (?, ?, ?)`)
      .run([runId, key, result]);
  }

  /** Build the durable context bound to one run id. */
  #context(runId: string): WorkflowContext {
    return {
      step: async <T>(key: string, fn: () => T | Promise<T>): Promise<T> => {
        const existing = this.#read(runId, key);

        // Durable memoization: a completed step replays without calling `fn`.
        if (existing !== undefined) return JSON.parse(existing.result) as T;

        // First execution: run, persist, return.
        const result = await fn();

        this.#write(runId, key, JSON.stringify(result));

        return result;
      },

      sleep: (ms: number): Promise<void> => this.#sleep(ms),
    };
  }

  /** Run a registered workflow for a given run id and input. */
  async run<I, O>(name: string, runId: string, input: I): Promise<O> {
    const fn = this.#workflows.get(name);

    // An unknown name is a programmer error with a stable, branchable code.
    if (fn === undefined) {
      throw new WorkflowError("WORKFLOW_UNKNOWN", `No workflow named "${name}".`, { name });
    }

    const ctx = this.#context(runId);

    return (fn as WorkflowFn<I, O>)(input, ctx);
  }
}

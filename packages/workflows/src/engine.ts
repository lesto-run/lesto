import { WorkflowError } from "./errors";
import { systemSleep } from "./sleep";

import type {
  Dialect,
  Sleep,
  SqlDatabase,
  StepObserver,
  WorkflowContext,
  WorkflowFn,
} from "./types";

const TABLE = "keel_workflow_steps";

/**
 * Create the step-journal table. Idempotent; call it from a migration or once at boot.
 *
 * One row per completed step, keyed by (run_id, step_key). The presence of a row
 * IS the durable record that the step ran; its `result` is the memoized value.
 *
 * The table is all `TEXT` under a composite primary key, so its DDL needs no
 * dialect fork — `dialect` is accepted (defaulting to `"sqlite"`) only for
 * signature parity with the other installers; it is otherwise unused here.
 */
export async function installWorkflowSchema(
  db: SqlDatabase,
  dialect: Dialect = "sqlite",
): Promise<void> {
  // The DDL is dialect-identical; reference the param so it is not flagged unused
  // while keeping the installer's two-arg signature uniform across the repo.
  void dialect;

  await db.exec(`
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

  /**
   * Observability seam: fires once per step pass with its `durationMs` and a
   * `replayed` flag (executed `fn` vs. replayed a memoized result) — see
   * {@link StepObserver}. No step result is carried. Inert by default.
   */
  readonly onStep?: StepObserver;
}

/**
 * The durable workflow engine.
 *
 * A workflow is an async function composed of steps. Each step's result is
 * persisted the first time it runs, so re-running the same run id SKIPS already
 * completed steps and replays their results — crash-safe resume, DBOS-style.
 * No external engine, no Postgres required: it runs on any `SqlDatabase`.
 *
 * An optional `onStep` sink ({@link EngineOptions.onStep}) observes every step
 * pass (executed or replayed, with a `durationMs`) for tracing; inert by default.
 */
export class Engine {
  readonly #db: SqlDatabase;

  readonly #sleep: Sleep;

  readonly #onStep: StepObserver | undefined;

  // The registry of known workflows, by name.
  readonly #workflows = new Map<string, WorkflowFn<never, unknown>>();

  constructor(options: EngineOptions) {
    this.#db = options.db;

    // Honor an injected sleep; otherwise wait on a real timer.
    this.#sleep = options.sleep ?? systemSleep;

    // The optional per-step observability sink; undefined = inert.
    this.#onStep = options.onStep;
  }

  /** Register a workflow under a name. Chainable. */
  define<I, O>(name: string, fn: WorkflowFn<I, O>): this {
    this.#workflows.set(name, fn as WorkflowFn<never, unknown>);

    return this;
  }

  /** Look up a completed step's memoized result, or undefined if it never ran. */
  async #read(runId: string, key: string): Promise<StepRow | undefined> {
    const row = await this.#db
      .prepare(`SELECT result FROM ${TABLE} WHERE run_id = ? AND step_key = ?`)
      .get([runId, key]);

    // No row means the step has not completed for this run.
    if (row === undefined || row === null) return undefined;

    return row as StepRow;
  }

  /** Persist a step's result so future runs replay it instead of re-executing. */
  async #write(runId: string, key: string, result: string): Promise<void> {
    await this.#db
      .prepare(`INSERT INTO ${TABLE} (run_id, step_key, result) VALUES (?, ?, ?)`)
      .run([runId, key, result]);
  }

  /**
   * Report one step pass through the observability sink, if present. A throwing
   * sink is contained: an observer must never break the workflow it observes.
   */
  #report(workflow: string, runId: string, key: string, replayed: boolean, start: number): void {
    if (this.#onStep === undefined) return;

    try {
      this.#onStep({
        runId,
        workflow,
        step: key,
        replayed,
        durationMs: performance.now() - start,
      });
    } catch {
      // A throwing observability sink is not allowed to break the workflow.
    }
  }

  /** Build the durable context bound to one run id of a named workflow. */
  #context(workflow: string, runId: string): WorkflowContext {
    return {
      step: async <T>(key: string, fn: () => T | Promise<T>): Promise<T> => {
        const start = performance.now();

        const existing = await this.#read(runId, key);

        // Durable memoization: a completed step replays without calling `fn`. The
        // replay still reports — a tracer wants to see the resumed step too.
        if (existing !== undefined) {
          this.#report(workflow, runId, key, true, start);

          return JSON.parse(existing.result) as T;
        }

        // First execution: run, persist, return.
        const result = await fn();

        // A void step returns undefined, and JSON.stringify(undefined) is itself
        // undefined — not a string — which would violate `result TEXT NOT NULL`
        // and leave NO row, so resume would RE-RUN the step (breaking exactly-once).
        // Coalesce to JSON null so every completed step records a durable row.
        await this.#write(runId, key, JSON.stringify(result ?? null));

        this.#report(workflow, runId, key, false, start);

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

    const ctx = this.#context(name, runId);

    return (fn as WorkflowFn<I, O>)(input, ctx);
  }
}

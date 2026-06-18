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

const TABLE = "lesto_workflow_steps";

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
 * The resumable step-memoization engine.
 *
 * A workflow is an async function composed of steps. Each step's result is
 * persisted the first time it runs, so re-invoking `run()` with the SAME `runId`
 * SKIPS already-completed steps and replays their results instead of re-executing
 * them. No external engine, no Postgres required: it runs on any `SqlDatabase`.
 *
 * **This is step memoization, not crash-safe durable execution.** There is no run
 * journal, no scheduler, and nothing re-invokes a workflow after a crash: resume
 * is *caller-driven*. To resume an interrupted run, the application must call
 * `run(name, runId, input)` again with the same `runId` (e.g. from a retry queue);
 * completed steps then replay and execution continues from the first incomplete
 * step. A durable run journal + queue-backed resume driver is deferred post-1.0.
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

  /**
   * Persist a step's result so future runs replay it instead of re-executing.
   *
   * `ON CONFLICT DO NOTHING` makes the write idempotent under the step-journal
   * race: if two passes of the same `(runId, key)` execute concurrently (this is
   * memoization, not a distributed lock — `run()` is re-invoked by the caller),
   * both can find no row in `#read`, both run `fn`, and both reach here. The
   * composite PRIMARY KEY would make the second INSERT throw; `DO NOTHING`
   * collapses it to a no-op so the first writer wins and the loser does not crash.
   * The caller re-reads the row afterward to return the winning memoized value,
   * so the two passes converge on one result. The clause is identical on SQLite
   * and Postgres, so no dialect fork is needed.
   *
   * Returns whether THIS call inserted the row (`true`) or lost the race to an
   * existing one (`false`), via the driver's reported `changes`.
   */
  async #write(runId: string, key: string, result: string): Promise<boolean> {
    const { changes } = await this.#db
      .prepare(
        `INSERT INTO ${TABLE} (run_id, step_key, result) VALUES (?, ?, ?)
         ON CONFLICT (run_id, step_key) DO NOTHING`,
      )
      .run([runId, key, result]);

    // 0 changes = a concurrent pass already journaled this step; we lost the race.
    return changes > 0;
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
        const won = await this.#write(runId, key, JSON.stringify(result ?? null));

        // Step-journal race: if a concurrent pass of the same (runId, key) wrote
        // the row first, our INSERT was a no-op (`changes === 0`). The conflicting
        // row provably exists now, so re-read it and return the WINNING memoized
        // value — both passes converge on one result instead of the caller seeing
        // a locally-computed value the journal does not hold.
        if (!won) {
          const winner = (await this.#read(runId, key)) as StepRow;

          this.#report(workflow, runId, key, true, start);

          return JSON.parse(winner.result) as T;
        }

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

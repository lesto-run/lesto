/**
 * The tables this example stands up beyond the queue's own.
 *
 * `@lesto/queue`'s `installSchema` owns `lesto_jobs`, `lesto_job_batches`, and
 * `lesto_job_deps` — the live queue state the dashboard reads + manages. This
 * file adds ONE more table, `job_runs`, the throughput/inspection ledger the
 * worker's `onJob` observer appends to: one row per processed job, carrying the
 * outcome, attempt, and `durationMs`. It is the surface `@lesto/admin` manages
 * for the dashboard's "throughput" + "recent runs" panels — a generic CRUD table,
 * so the admin layer's projection + pagination do real work here, while the
 * queue-specific verbs (retry / discard) go straight to `@lesto/queue`'s operator
 * surface (they are queue operations, not generic CRUD).
 *
 * A plain `@lesto/db` schema value (no `extends Model`), migrated through
 * `createApp({ migrations })` — the same shape `examples/admin` + `examples/blog`
 * use.
 */

import {
  createTableSql,
  defineTable,
  dropTableSql,
  integer,
  text,
  type Db,
  type InferRow,
} from "@lesto/db";
import type { MigrationEntry } from "@lesto/migrate";
import { z } from "zod";

/**
 * The throughput ledger: one row per job the worker processed, written by the
 * `onJob` observer (see `src/operator.ts`). `name` is the job name, `outcome` one
 * of `done` / `retry` / `failed`, `attempt` the attempt number, `durationMs` the
 * processing span (rounded to a whole ms for a clean column), and `at` an ISO
 * timestamp. This is what the dashboard's throughput panel reads back, and what
 * `@lesto/admin` lists + projects.
 */
export const jobRuns = defineTable("job_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  jobId: integer("job_id").notNull(),
  name: text("name").notNull(),
  outcome: text("outcome").notNull(),
  attempt: integer("attempt").notNull(),
  durationMs: integer("duration_ms").notNull(),
  at: text("at").notNull(),
});

/** A run-ledger row, as SELECT yields it. */
export type JobRun = InferRow<typeof jobRuns>;

/**
 * The Zod schema fronting the admin's `create` for `job_runs`. The dashboard
 * never creates a run by hand (the observer does), but the admin resource still
 * declares its validation contract — so a manual `POST /admin/runs` is validated
 * the same way every admin write is (ADR 0005).
 */
export const jobRunInsertSchema = z.object({
  jobId: z.number().int().nonnegative(),
  name: z.string().min(1),
  outcome: z.enum(["done", "retry", "failed"]),
  attempt: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  at: z.string().min(1),
});

/** The `update` schema — every field optional, the usual patch shape. */
export const jobRunUpdateSchema = z.object({
  jobId: z.number().int().nonnegative().optional(),
  name: z.string().min(1).optional(),
  outcome: z.enum(["done", "retry", "failed"]).optional(),
  attempt: z.number().int().nonnegative().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  at: z.string().min(1).optional(),
});

/** The migration entries `createApp({ migrations })` runs on boot (the queue's own tables come from `schemas: [installSchema]`). */
export const migrations: MigrationEntry[] = [
  {
    version: "001_create_job_runs",
    migration: {
      up: (schema) => schema.execute(createTableSql(jobRuns)),
      down: (schema) => schema.execute(dropTableSql(jobRuns)),
    },
  },
];

/** Append one run to the ledger — what the worker's `onJob` observer calls. */
export async function recordRun(
  db: Db,
  run: { jobId: number; name: string; outcome: string; attempt: number; durationMs: number },
): Promise<void> {
  await db
    .insert(jobRuns)
    .values({ ...run, at: new Date().toISOString() })
    .run();
}

/**
 * The dashboard snapshot — the DTO the operator board island renders.
 *
 * A pure value type plus the function that builds it from the live queue. It is
 * what `dashboardSource` resolves at render (inlined into the `ssr: true` island,
 * 0 RTT — the canonical island, ADR 0012) and what the JSON poll route returns,
 * so the server-rendered board and a client refresh read the identical shape.
 *
 * The snapshot is everything an operator sees at a glance: the per-status counts
 * (the "in-flight / failed / scheduled" tabs), the backlog `depth` +
 * `oldestReadyAgeMs` latency signal, a sample of the most recently failed jobs
 * (the DLQ / poison inspection), and the recent processed-run throughput.
 */

import type { Db } from "@lesto/db";
import type { JobStatus, Queue } from "@lesto/queue";

import { jobRuns } from "./schema";
import type { JobRun } from "./schema";

/** One failed job as the board shows it — enough to inspect + decide retry/discard. */
export interface FailedJobView {
  readonly id: number;
  readonly name: string;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly lastError: string | null;
  readonly batchId: number | null;
}

/** One recent run as the throughput panel shows it. */
export interface RunView {
  readonly jobId: number;
  readonly name: string;
  readonly outcome: string;
  readonly durationMs: number;
}

/** The whole board, in one value. */
export interface QueueSnapshot {
  /** Per-status job counts for the queue (ready / running / done / failed / blocked). */
  readonly counts: Partial<Record<JobStatus, number>>;

  /** The claimable backlog right now (ready AND eligible). */
  readonly depth: number;

  /** How long the oldest eligible job has waited, in ms, or `null` when idle. */
  readonly oldestReadyAgeMs: number | null;

  /** The most recently failed jobs — the DLQ / poison inspection sample. */
  readonly failed: readonly FailedJobView[];

  /** The most recent processed runs — the throughput sample. */
  readonly recentRuns: readonly RunView[];

  /** Total runs ever recorded — the lifetime throughput counter. */
  readonly totalRuns: number;
}

/**
 * Build the snapshot from the live queue + the run ledger.
 *
 * `stats()` gives the per-status counts and the backlog signals; `list({ status:
 * "failed" })` gives the DLQ sample (newest-updated first, capped); the `job_runs`
 * table gives recent throughput. All three are real reads through the same handle
 * the worker writes through, so the board is never stale fixtures.
 */
export async function buildSnapshot(queue: Queue, db: Db, sampleSize = 5): Promise<QueueSnapshot> {
  const stats = await queue.stats();

  const failedJobs = await queue.list({ status: "failed", limit: sampleSize });

  const runs = (await db
    .select()
    .from(jobRuns)
    .orderBy(jobRuns.id, "desc")
    .limit(sampleSize)
    .all()) as JobRun[];

  const totalRuns = await db.select().from(jobRuns).count();

  const { depth, oldestReadyAgeMs, ...counts } = stats;

  return {
    counts,
    depth,
    oldestReadyAgeMs,
    failed: failedJobs.map((job) => ({
      id: job.id,
      name: job.name,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      lastError: job.lastError,
      batchId: job.batchId,
    })),
    recentRuns: runs.map((run) => ({
      jobId: run.jobId,
      name: run.name,
      outcome: run.outcome,
      durationMs: run.durationMs,
    })),
    totalRuns,
  };
}

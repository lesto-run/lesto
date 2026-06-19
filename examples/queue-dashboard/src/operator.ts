/**
 * The queue + its handlers + the throughput observer — the operator's engine.
 *
 * This is where the demo queue is defined: a `Queue` over the shared SQL handle,
 * three job handlers (one that always succeeds, one that always fails to seed the
 * DLQ, and a two-step image pipeline used by the batch demo), and the `onJob`
 * observer that appends every processed job to the `job_runs` ledger so the
 * dashboard's throughput panel has real data.
 *
 * The handlers are deliberately trivial — the point of this example is the
 * OPERATOR surface (list / retry / discard / batches), not the work itself.
 */

import type { Db } from "@lesto/db";
import { Queue } from "@lesto/queue";
import type { JobObserver, SqlDatabase } from "@lesto/queue";

import { recordRun } from "./schema";

/** The two-step pipeline the batch demo runs: `ingest` then `thumbnail`, in order. */
export const INGEST = "ingest";

export const THUMBNAIL = "thumbnail";

/** A job that always succeeds — the happy-path throughput. */
export const NOTIFY = "notify";

/** A job that always fails — seeds the DLQ so the dashboard has a failed job to show. */
export const FLAKY = "flaky";

/**
 * Build the queue over `handle`, register the demo handlers, and return it.
 *
 * The throughput observer is built separately ({@link makeRunObserver}) over the
 * typed `@lesto/db` wrapper of the SAME handle, so a recorded run and the job's
 * terminal transition share one connection and stay consistent.
 */
export function buildQueue(handle: SqlDatabase): Queue {
  const queue = new Queue({ db: handle });

  queue.define(NOTIFY, () => {
    /* a no-op success — the demo's steady throughput */
  });

  queue.define(FLAKY, () => {
    // Always throws, so after its attempts it lands in the DLQ — the dashboard's
    // "failed" tab and the retry button both need a real failed job to act on.
    throw new Error("downstream unavailable");
  });

  queue.define(INGEST, () => {
    /* step one of the pipeline — succeeds, releasing the thumbnail step */
  });

  queue.define(THUMBNAIL, () => {
    /* step two — only ever runs AFTER ingest, by the dependency edge */
  });

  return queue;
}

/**
 * The `onJob` observer: append one `job_runs` row per processed job.
 *
 * Fire-and-forget — `JobObserver` is synchronous (`(e) => void`) and a throw
 * would be swallowed by the queue's observer guard anyway, so we kick the async
 * insert and let a failure log rather than break processing. `durationMs` is
 * rounded to a whole ms for a clean integer column.
 */
export function makeRunObserver(db: Db): JobObserver {
  return (event): void => {
    void recordRun(db, {
      jobId: event.id,
      name: event.name,
      outcome: event.outcome,
      attempt: event.attempt,
      durationMs: Math.round(event.durationMs),
    }).catch((error: unknown) => {
      // The job already transitioned; a broken ledger write must not crash the
      // worker. A real app routes this to its logger.
      console.error("[queue-dashboard] failed to record run:", error);
    });
  };
}

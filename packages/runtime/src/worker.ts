import type { Queue, Worker } from "@keel/queue";

export interface RunWorkerOptions {
  readonly concurrency?: number;
}

/**
 * Start a queue worker draining jobs in the background.
 *
 * A thin wire over `queue.work`: the queue owns the at-least-once claim/reclaim
 * loop and graceful drain; the runner only forwards the knobs and hands back the
 * handle so a process can `stop()` it on SIGTERM.
 */
export function runWorker(queue: Queue, options: RunWorkerOptions = {}): Worker {
  return queue.work(options.concurrency === undefined ? {} : { concurrency: options.concurrency });
}

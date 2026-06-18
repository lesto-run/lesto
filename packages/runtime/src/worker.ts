import type { Queue, QueueError, Worker } from "@lesto/queue";

/**
 * Where a worker poll-loop fault goes — the runner's observability seam.
 *
 * A job *handler* that throws routes through the queue's own retry/backoff and
 * never reaches here; this fires only for a fault raised *outside* a handler (a
 * transient DB error on claim/reclaim), which the queue surfaces as a coded
 * `QUEUE_WORKER_POLL_FAILED` `QueueError`. Branch on its `code`, log it, ship it
 * to a tracer. Defaults to {@link defaultWorkerErrorSink} (structured stderr) so
 * a poll fault is never silently dropped.
 */
export type WorkerErrorSink = (error: QueueError) => void;

export interface RunWorkerOptions {
  readonly concurrency?: number;

  /**
   * Where poll-loop faults are reported. Injected so a test can assert without
   * writing to the console, and so operability-dx item 3 can wire this to OTLP.
   * Defaults to {@link defaultWorkerErrorSink}: a structured JSON line on stderr.
   */
  readonly onError?: WorkerErrorSink;
}

/**
 * The default sink for a worker poll-loop fault: one structured line on stderr.
 *
 * Structured (JSON) so a log pipeline can branch on `code` rather than scrape a
 * message — the same posture the access log takes. A poll fault is the worker's
 * to explain; it was silently dropped before this seam existed.
 */
export function defaultWorkerErrorSink(error: QueueError): void {
  console.error(
    JSON.stringify({
      level: "error",
      event: "worker.poll_failed",
      code: error.code,
      message: error.message,
    }),
  );
}

/**
 * Start a queue worker draining jobs in the background.
 *
 * A thin wire over `queue.work`: the queue owns the at-least-once claim/reclaim
 * loop and graceful drain; the runner forwards the knobs and the `onError` sink
 * — so a poll-loop fault that used to vanish now reaches an operator by default
 * — and hands back the handle so a process can `stop()` it on SIGTERM.
 */
export function runWorker(queue: Queue, options: RunWorkerOptions = {}): Worker {
  return queue.work({
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
    onError: options.onError ?? defaultWorkerErrorSink,
  });
}

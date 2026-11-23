/**
 * A FIFO queue of async work over ONE connection.
 *
 * A single connection (a synchronous SQLite engine, the OPFS worker, a Worker's one
 * Hyperdrive connection) runs at most one `BEGIN`…`COMMIT` span at a time. Every
 * caller that needs the connection to itself enqueues its work here, and the work
 * starts only after every earlier item has settled.
 *
 * Two promises carry two concerns. The caller receives `result`, which rejects with
 * the work's ORIGINAL error. The internal `chain` link swallows that rejection, so a
 * rolled-back span never wedges the items queued behind it.
 */

/** Run async work strictly one item at a time, in the order it was enqueued. */
export interface FifoQueue {
  run<T>(work: () => Promise<T>): Promise<T>;
}

/** Create an empty {@link FifoQueue}. */
export function createFifoQueue(): FifoQueue {
  let chain: Promise<unknown> = Promise.resolve();

  return {
    run: <T>(work: () => Promise<T>): Promise<T> => {
      const result = chain.then(work);

      chain = result.then(
        () => undefined,
        () => undefined,
      );

      return result;
    },
  };
}

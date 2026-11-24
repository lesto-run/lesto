/**
 * Refuse a root-handle statement issued from INSIDE the handle's own open span.
 *
 * A single-connection adapter queues every span (and, for sync SQLite, every root
 * statement) FIFO. A span's callback that calls the ROOT handle instead of `tx`
 * would queue behind the very span it runs in, and wait forever. The guard turns
 * that hang into the coded `DB_ROOT_STATEMENT_IN_SPAN`.
 *
 * Telling "inside my own span" from "a different concurrent caller" needs async
 * context, which `@lesto/db` cannot import itself: it also runs in the browser
 * (the OPFS driver), where `node:async_hooks` does not exist. So the adapter's
 * caller INJECTS it — `@lesto/runtime`'s `openSqlite` passes a Node/Bun
 * `AsyncLocalStorage`, and a Worker on `nodejs_compat` can pass one to
 * `hyperdriveToSqlDatabase`. With no context injected the guard never fires and
 * the old waiting behaviour stays: the error is best-effort, by design.
 */

import { DbError } from "./errors";

/**
 * The slice of `AsyncLocalStorage` the guard uses. A Node, Bun or workerd
 * (`nodejs_compat`) `new AsyncLocalStorage<object>()` satisfies it as-is.
 */
export interface AsyncContext<T> {
  run<R>(store: T, fn: () => R): R;
  getStore(): T | undefined;
}

/** Marks a span's async scope, and checks whether the current call is inside one. */
export interface SpanGuard {
  /** Run `fn` (a span's callback) marked as inside this handle's span. */
  enter<R>(fn: () => R): R;

  /**
   * Start root work (`start`), or — when called from inside this handle's span —
   * reject with `DB_ROOT_STATEMENT_IN_SPAN` without starting it.
   */
  outside<T>(operation: string, start: () => Promise<T>): Promise<T>;
}

/** Build the guard for one handle. Without `context` it marks nothing and never throws. */
export function createSpanGuard(context: AsyncContext<object> | undefined): SpanGuard {
  // Unique per handle: a span of ANOTHER handle is not this handle's span.
  const marker = {};

  return {
    enter: (fn) => (context === undefined ? fn() : context.run(marker, fn)),

    outside: (operation, start) => {
      if (context?.getStore() !== marker) return start();

      return Promise.reject(
        new DbError(
          "DB_ROOT_STATEMENT_IN_SPAN",
          `\`${operation}\` was called on the root database handle from inside one of its own ` +
            "transactions or batches. It would wait for that span to end and never run. " +
            "Use the `tx` handle the transaction callback receives.",
          { operation },
        ),
      );
    },
  };
}

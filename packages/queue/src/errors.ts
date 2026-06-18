/**
 * Errors carry codes, not just prose.
 *
 * Every failure in Lesto surfaces a stable, machine-readable `code`. Logs,
 * tests, API responses, and the MCP surface branch on the code — never on a
 * message string, which is free to change for humans without breaking machines.
 */

import { LestoError } from "@lesto/errors";

export { LestoError };

export type QueueErrorCode =
  | "QUEUE_HANDLER_NOT_A_FUNCTION"
  | "QUEUE_HANDLER_NOT_FOUND"
  | "QUEUE_INVALID_CRON_EXPRESSION"
  | "QUEUE_PERMANENT_FAILURE"
  | "QUEUE_POISON_PAYLOAD"
  | "QUEUE_WORKER_POLL_FAILED"
  | "RETENTION_TASK_FAILED";

/** Anything the queue can refuse to do. */
export class QueueError extends LestoError<QueueErrorCode> {
  constructor(code: QueueErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);

    this.name = "QueueError";
  }
}

/**
 * The structural marker a handler stamps to say "this failure is PERMANENT — do
 * not retry me, even if attempts remain." The {@link Queue}'s `fail()` path reads
 * this flag (via {@link isPermanentFailure}) and retires the job straight to
 * `failed`, skipping the backoff/reschedule it would otherwise apply under
 * `maxAttempts`.
 *
 * It is a single boolean property — `true` — rather than an `instanceof` check so
 * ANY error a handler throws can opt in: wrap a thrown error with
 * {@link permanentFailure}, or set the flag on a coded error class of your own
 * (e.g. `@lesto/webhooks`'s `WEBHOOK_URL_BLOCKED`). The queue never inspects the
 * error's identity, only this flag, so the signal crosses package boundaries
 * without either side importing the other's error type.
 */
export const PERMANENT_FAILURE = "lestoQueuePermanentFailure" as const;

/** An error a handler can throw to mark its failure non-retryable. */
export interface PermanentFailure {
  readonly [PERMANENT_FAILURE]: true;
}

/**
 * Does `error` carry the {@link PERMANENT_FAILURE} marker?
 *
 * Read structurally — never by `instanceof` — so a permanent failure from any
 * package (or a plain object) is recognized. A non-object, or one without the
 * flag set to literal `true`, is a normal (retryable) failure.
 */
export function isPermanentFailure(error: unknown): error is PermanentFailure {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as Record<string, unknown>)[PERMANENT_FAILURE] === true
  );
}

/**
 * Mark a failure as permanent so the queue stops re-attempting it.
 *
 * Throw the returned value from a job handler when the failure can NEVER succeed
 * on a later attempt — an SSRF-blocked webhook URL, a 4xx the receiver will keep
 * returning, a payload no handler version can process. `fail()` honors the marker
 * and retires the job to `failed` after this one attempt, instead of burning the
 * remaining `maxAttempts` on a retry that is doomed to fail identically.
 *
 * If `error` is already an object it is stamped in place and returned (its code,
 * message, and `instanceof` identity are preserved — a coded `LestoError` stays
 * branchable). A non-object is wrapped in a coded `QUEUE_PERMANENT_FAILURE`
 * `QueueError` carrying its string form, so the thrown value is always an `Error`.
 */
export function permanentFailure<E>(error: E): E & PermanentFailure {
  if (typeof error === "object" && error !== null) {
    (error as Record<string, unknown>)[PERMANENT_FAILURE] = true;

    return error as E & PermanentFailure;
  }

  const wrapped = new QueueError(
    "QUEUE_PERMANENT_FAILURE",
    typeof error === "string" ? error : String(error),
  );

  (wrapped as unknown as Record<string, unknown>)[PERMANENT_FAILURE] = true;

  return wrapped as unknown as E & PermanentFailure;
}

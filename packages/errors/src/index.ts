/**
 * @lesto/errors — the shared error foundation every Lesto package builds on.
 *
 *   class QueueError extends LestoError<"QUEUE_HANDLER_NOT_FOUND"> { ... }
 *
 *   const result = mightFail();
 *   if (isErr(result)) return result.error;
 *   use(unwrap(result));
 */

export { hasCode, isLestoError, LestoError } from "./errors";

export { err, isErr, isOk, ok, unwrap } from "./result";
export type { Result } from "./result";

/**
 * @volo/errors — the shared error foundation every Volo package builds on.
 *
 *   class QueueError extends VoloError<"QUEUE_HANDLER_NOT_FOUND"> { ... }
 *
 *   const result = mightFail();
 *   if (isErr(result)) return result.error;
 *   use(unwrap(result));
 */

export { hasCode, isVoloError, VoloError } from "./errors";

export { err, isErr, isOk, ok, unwrap } from "./result";
export type { Result } from "./result";

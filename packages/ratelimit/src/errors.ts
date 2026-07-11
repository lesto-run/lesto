/**
 * Errors carry codes, not just prose.
 *
 * Every failure surfaces a stable, machine-readable `code`. Callers branch on
 * the code, never on a message string, which is free to change for humans.
 */

import { LestoError } from "@lesto/errors";

export type RateLimitErrorCode =
  | "RATELIMIT_STORE_CONFLICT"
  | "RATELIMIT_STORE_CAPACITY_MISMATCH";

/** Anything the rate-limit store can refuse to do. */
export class RateLimitError extends LestoError<RateLimitErrorCode> {
  constructor(code: RateLimitErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);

    this.name = "RateLimitError";
  }
}

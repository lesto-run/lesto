/**
 * Errors carry codes, not just prose.
 *
 * Every failure surfaces a stable, machine-readable `code`. Callers branch on
 * the code, never on a message string, which is free to change for humans.
 */

import { KeelError } from "@keel/errors";

export type RateLimitErrorCode = "RATELIMIT_STORE_CONFLICT";

/** Anything the rate-limit store can refuse to do. */
export class RateLimitError extends KeelError<RateLimitErrorCode> {
  constructor(code: RateLimitErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);

    this.name = "RateLimitError";
  }
}

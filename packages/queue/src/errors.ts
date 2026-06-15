/**
 * Errors carry codes, not just prose.
 *
 * Every failure in Keel surfaces a stable, machine-readable `code`. Logs,
 * tests, API responses, and the MCP surface branch on the code — never on a
 * message string, which is free to change for humans without breaking machines.
 */

import { KeelError } from "@keel/errors";

export { KeelError };

export type QueueErrorCode =
  | "QUEUE_HANDLER_NOT_A_FUNCTION"
  | "QUEUE_HANDLER_NOT_FOUND"
  | "QUEUE_INVALID_CRON_EXPRESSION"
  | "QUEUE_POISON_PAYLOAD"
  | "QUEUE_WORKER_POLL_FAILED";

/** Anything the queue can refuse to do. */
export class QueueError extends KeelError<QueueErrorCode> {
  constructor(code: QueueErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);

    this.name = "QueueError";
  }
}

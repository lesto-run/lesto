/**
 * Errors carry codes, not just prose.
 *
 * Every failure in Keel surfaces a stable, machine-readable `code`. Logs,
 * tests, API responses, and the MCP surface branch on the code — never on a
 * message string, which is free to change for humans without breaking machines.
 */

import { KeelError } from "@keel/errors";

export { KeelError };

export type StorageErrorCode =
  | "STORAGE_NOT_FOUND"
  | "STORAGE_INVALID_KEY"
  | "STORAGE_BACKEND_ERROR"
  | "STORAGE_URL_UNSUPPORTED";

/** Anything object storage can refuse to do. */
export class StorageError extends KeelError<StorageErrorCode> {
  constructor(code: StorageErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);

    this.name = "StorageError";
  }
}

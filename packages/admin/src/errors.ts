/**
 * Admin failures, coded.
 *
 * As everywhere in Lesto, callers branch on `code` — never on the message.
 * The admin UI maps "unknown resource" to a 404 page, "record not found"
 * to a row-level not-found, and "validation failed" to per-field form
 * errors, all off the stable code.
 */

import { LestoError } from "@lesto/errors";

export type AdminErrorCode =
  | "ADMIN_UNKNOWN_RESOURCE"
  | "ADMIN_RECORD_NOT_FOUND"
  | "ADMIN_NO_PRIMARY_KEY"
  | "ADMIN_VALIDATION_FAILED"
  | "ADMIN_EMPTY_UPDATE"
  | "ADMIN_FORBIDDEN";

/** Anything the admin layer can refuse to do. */
export class AdminError extends LestoError<AdminErrorCode> {
  constructor(code: AdminErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);

    this.name = "AdminError";
  }
}

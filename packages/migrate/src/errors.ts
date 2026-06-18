/**
 * Migrator failures, coded.
 *
 * As everywhere in Lesto, callers branch on `code` — never on the message.
 */

import { LestoError } from "@lesto/errors";

export type MigrateErrorCode = "MIGRATE_MISSING_MIGRATION";

export class MigrateError extends LestoError<MigrateErrorCode> {
  constructor(code: MigrateErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);

    this.name = "MigrateError";
  }
}

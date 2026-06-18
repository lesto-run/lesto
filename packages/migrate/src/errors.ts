/**
 * Migrator failures, coded.
 *
 * As everywhere in Volo, callers branch on `code` — never on the message.
 */

import { VoloError } from "@volo/errors";

export type MigrateErrorCode = "MIGRATE_MISSING_MIGRATION";

export class MigrateError extends VoloError<MigrateErrorCode> {
  constructor(code: MigrateErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);

    this.name = "MigrateError";
  }
}

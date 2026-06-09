/**
 * Migrator failures, coded.
 *
 * As everywhere in Keel, callers branch on `code` — never on the message.
 */

import { KeelError } from "@keel/errors";

export type MigrateErrorCode = "MIGRATE_MISSING_MIGRATION";

export class MigrateError extends KeelError<MigrateErrorCode> {
  constructor(code: MigrateErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);

    this.name = "MigrateError";
  }
}

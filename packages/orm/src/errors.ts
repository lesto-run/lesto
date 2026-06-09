/**
 * ORM failures, coded.
 *
 * As everywhere in Keel, callers branch on `code` — never on the message.
 */

import { KeelError } from "@keel/errors";

export type OrmErrorCode = "ORM_NO_CONNECTION" | "ORM_RECORD_NOT_FOUND" | "ORM_UNKNOWN_VALIDATION";

export class OrmError extends KeelError<OrmErrorCode> {
  constructor(code: OrmErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);

    this.name = "OrmError";
  }
}

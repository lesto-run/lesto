/**
 * Mailing-list failures, coded.
 *
 * As everywhere in Keel, callers branch on `code` — never on the message,
 * which is free to change for humans without breaking machines.
 */

import { KeelError } from "@keel/errors";

export type MailingListErrorCode = "MAILING_LIST_INVALID_TOKEN";

export class MailingListError extends KeelError<MailingListErrorCode> {
  constructor(code: MailingListErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);

    this.name = "MailingListError";
  }
}

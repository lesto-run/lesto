/**
 * Mailing-list failures, coded.
 *
 * As everywhere in Volo, callers branch on `code` — never on the message,
 * which is free to change for humans without breaking machines.
 */

import { VoloError } from "@volo/errors";

export type MailingListErrorCode =
  /** No subscriber matched a presented confirm/unsubscribe token. */
  | "MAILING_LIST_INVALID_TOKEN"
  /** A subscribe email failed shape validation before it could be stored. */
  | "MAILING_LIST_INVALID_EMAIL"
  /** A resumed broadcast referenced an id with no broadcast row. */
  | "MAILING_LIST_UNKNOWN_BROADCAST";

export class MailingListError extends VoloError<MailingListErrorCode> {
  constructor(code: MailingListErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);

    this.name = "MailingListError";
  }
}

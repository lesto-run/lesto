import { LestoError } from "@lesto/errors";

/**
 * Every failure this package raises carries one of these stable codes. Branch on
 * the code, never the message — the message is for humans, the code is the API.
 */
export type ContentStoreErrorCode =
  /** An entry reached persistence without the identity a content row requires. */
  | "CONTENT_STORE_INVALID_ENTRY"
  /** A stored document column could not be parsed back into an entry. */
  | "CONTENT_STORE_CORRUPT_DOCUMENT"
  /** A `create` named an entry that already exists. */
  | "CONTENT_STORE_ENTRY_EXISTS"
  /** An `update` or read named an entry that is not there. */
  | "CONTENT_STORE_ENTRY_NOT_FOUND";

/** The error type for the content store, codes drawn from the union above. */
export class ContentStoreError extends LestoError<ContentStoreErrorCode> {}

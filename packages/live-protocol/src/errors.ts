/**
 * Errors carry codes, not just prose.
 *
 * Every failure in the local-first protocol surfaces a stable, machine-readable
 * `code`. Logs, tests, and the sync client branch on the code — never on a message
 * string, which is free to change for humans without breaking machines.
 */

import { LestoError } from "@lesto/errors";

export { LestoError };

export type LiveProtocolErrorCode =
  /** A shape descriptor failed structural validation (bad table/key/columns/where/orderBy). */
  | "LIVE_PROTOCOL_INVALID_SHAPE"
  /** A row is missing the value of its key column, so it cannot be identified. */
  | "LIVE_PROTOCOL_MISSING_KEY"
  /** A wire frame (or its `id:` cursor) was malformed on encode or decode. */
  | "LIVE_PROTOCOL_MALFORMED_FRAME";

/** Anything the local-first wire protocol can refuse to encode, decode, or accept. */
export class LiveProtocolError extends LestoError<LiveProtocolErrorCode> {
  constructor(code: LiveProtocolErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);

    this.name = "LiveProtocolError";
  }
}

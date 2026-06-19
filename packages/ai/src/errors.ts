/**
 * Errors carry codes, not just prose.
 *
 * Every failure in `@lesto/ai` surfaces a stable, machine-readable `code`. Logs,
 * the boundary that maps an AI failure to an HTTP response, and tests branch on
 * the code — never on a message string, which is free to change for humans.
 */

import { LestoError } from "@lesto/errors";

export { LestoError };

export type AiErrorCode =
  /** The model provider returned a non-2xx HTTP status. The status is in `details`. */
  | "AI_HTTP_ERROR"
  /** The provider's streaming (SSE) response was malformed and could not be parsed. */
  | "AI_STREAM_MALFORMED"
  /** The model asked to call a tool that was not registered for this run. */
  | "AI_TOOL_NOT_FOUND"
  /** The agent loop hit its `maxSteps` budget without the model stopping — a runaway, refused loudly. */
  | "AI_MAX_STEPS_EXCEEDED"
  /** A guardrail eval refused the output before it could be returned. The eval's own code is in `details`. */
  | "AI_GUARDRAIL_BLOCKED"
  /** A call was made with an invalid configuration (e.g. `maxSteps < 1`) — nothing to do. */
  | "AI_INVALID_OPTION";

/** Anything the app-builder AI layer can refuse to do. */
export class AiError extends LestoError<AiErrorCode> {
  constructor(code: AiErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);

    this.name = "AiError";
  }
}

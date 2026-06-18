import { LestoError } from "@lesto/errors";

export { LestoError };

export type ClientErrorCode =
  /** The server answered with a non-2xx status (the parsed body is on `details.body`). */
  | "CLIENT_HTTP_ERROR"
  /** A path declared a `:param` the call did not supply. */
  | "CLIENT_MISSING_PARAM";

/** Anything the typed fetch client refuses, or surfaces from the server, with a stable code. */
export class ClientError extends LestoError<ClientErrorCode> {
  constructor(code: ClientErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);
    this.name = "ClientError";
  }
}

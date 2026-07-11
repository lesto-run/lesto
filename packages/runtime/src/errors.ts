/**
 * Errors carry codes, not just prose.
 *
 * Every failure in Lesto surfaces a stable, machine-readable `code`. Logs,
 * tests, API responses, and the MCP surface branch on the code — never on a
 * message string, which is free to change for humans without breaking machines.
 */

import { LestoError } from "@lesto/errors";

export { LestoError };

export type RuntimeErrorCode =
  | "RUNTIME_STATIC_PATH_TRAVERSAL"
  /**
   * The request target was not an origin-form path — an authority-form (`//host/…`)
   * or absolute-form (`http://host/…`) target whose authority would be discarded
   * while its path routed, a proxy-ACL-bypass smuggling shape. Refused before
   * routing; maps to a 400.
   */
  | "RUNTIME_INVALID_REQUEST_TARGET"
  /** The request body was not valid JSON for its declared content-type — a 400. */
  | "RUNTIME_INVALID_JSON"
  /** The request body exceeded the configured size limit — a 413. */
  | "RUNTIME_BODY_TOO_LARGE"
  /** A request handler ran past its time budget; the socket is freed with a 503. */
  | "RUNTIME_HANDLER_TIMEOUT"
  /** The client hung up before the response finished — the abort-signal reason. */
  | "RUNTIME_CLIENT_DISCONNECTED"
  /**
   * No SQLite engine could be constructed: better-sqlite3's native addon failed
   * to load (commonly a Node ABI mismatch) AND `bun:sqlite` isn't available
   * because we're not under Bun. Thrown by {@link openSqlite}'s fallback path.
   */
  | "RUNTIME_SQLITE_ENGINE_UNAVAILABLE";

/** Anything the transport tier can refuse to do. */
export class RuntimeError extends LestoError<RuntimeErrorCode> {
  constructor(code: RuntimeErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);

    this.name = "RuntimeError";
  }
}

/**
 * The stable codes the typed-mutation boundary refuses or fails a call under
 * (ADR 0022). They ride a {@link MutationError} and serialize verbatim into the
 * result union's failure arm, so an island branches on `error.code`, never prose.
 */
export type MutationErrorCode =
  /** No mutation is registered under the requested `:name` — a 404. */
  | "MUTATION_NOT_FOUND"
  /** The CSRF check refused the request (missing or forged token) — a 403. */
  | "MUTATION_CSRF_FAILED"
  /** The request body failed the mutation's Zod input schema — a 422. */
  | "MUTATION_INVALID_INPUT"
  /** A handler raised a domain refusal (default 400; the code is the app's own). */
  | "MUTATION_FAILED";

/**
 * A coded mutation refusal — thrown by the boundary, or by a handler that wants
 * the typed error arm deliberately.
 *
 * A handler `throw new MutationError("LISTING_LOCKED", "…", { status: 409 })`
 * reaches the island as `{ ok: false, error: { code: "LISTING_LOCKED", … } }`
 * with a 409, exactly like the framework's own codes — so a domain refusal is a
 * typed value, not a leaked stack. The `status` rides on `details.status` (the
 * boundary reads it); the rest of `details` is the app's to populate.
 */
export class MutationError extends LestoError<MutationErrorCode | string> {
  constructor(
    code: MutationErrorCode | string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(code, message, details);

    this.name = "MutationError";
  }
}

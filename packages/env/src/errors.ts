/**
 * Errors carry codes, not just prose.
 *
 * Every failure in Lesto surfaces a stable, machine-readable `code`. Logs, tests,
 * API responses, and the MCP surface branch on the code — never on a message
 * string, which is free to change for humans without breaking machines.
 */

import { LestoError } from "@lesto/errors";

export { LestoError };

export type EnvErrorCode =
  /** The environment did not validate against the schema (one or more bad vars). */
  | "ENV_VALIDATION_FAILED"
  /** A field's `.default(value)` is itself invalid for that field (e.g. a bad port). */
  | "ENV_INVALID_DEFAULT"
  /**
   * A `client` field was named without the `PUBLIC_` prefix the convention requires.
   * Thrown as the schema is built: a client var is inlined into browser bundles, so
   * its name must announce that it is public — the prefix is the leak-prevention
   * contract (mirrors t3-env's `NEXT_PUBLIC_` / Vite's `VITE_` / astro's `PUBLIC_`).
   */
  | "ENV_CLIENT_NOT_PUBLIC"
  /**
   * A SERVER-only value was read from a browser context. The split `defineEnv({ server,
   * client })` guards every server key behind this: an island that reaches a server
   * secret throws LOUD + EARLY (the first read) with the offending var named, rather
   * than leaking the secret or silently reading `undefined`.
   */
  | "ENV_SERVER_LEAK";

/**
 * Anything the env layer refuses: an environment that did not validate against its
 * schema (`ENV_VALIDATION_FAILED` — the message lists EVERY offending variable so a
 * single boot surfaces the whole set), a schema whose own `.default(value)` is invalid
 * for its field (`ENV_INVALID_DEFAULT`, thrown as the schema is built), a `client`
 * field whose name omits the required `PUBLIC_` prefix (`ENV_CLIENT_NOT_PUBLIC`), or a
 * server-only value reached from the browser (`ENV_SERVER_LEAK`). Callers branch on the
 * `code`.
 */
export class EnvError extends LestoError<EnvErrorCode> {
  constructor(code: EnvErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);

    this.name = "EnvError";
  }
}

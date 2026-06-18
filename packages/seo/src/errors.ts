/**
 * Errors carry codes, not just prose.
 *
 * Every failure in Volo surfaces a stable, machine-readable `code`. Logs,
 * tests, API responses, and the MCP surface branch on the code — never on a
 * message string, which is free to change for humans without breaking machines.
 */

import { VoloError } from "@volo/errors";

export { VoloError };

export type SeoErrorCode = "SEO_INJECTED_NEWLINE" | "SEO_INJECTED_FRAGMENT";

/** Anything the SEO builders can refuse to do. */
export class SeoError extends VoloError<SeoErrorCode> {
  constructor(code: SeoErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);

    this.name = "SeoError";
  }
}

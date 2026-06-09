/**
 * Errors carry codes, not just prose.
 *
 * Every failure in Keel surfaces a stable, machine-readable `code`. Logs,
 * tests, API responses, and the MCP surface branch on the code — never on a
 * message string, which is free to change for humans without breaking machines.
 */

import { KeelError } from "@keel/errors";

export { KeelError };

export type ConfigErrorCode = "CONFIG_MISSING" | "CONFIG_INVALID";

/** Anything config loading can refuse: a required field absent, or a value that won't coerce. */
export class ConfigError extends KeelError<ConfigErrorCode> {
  constructor(code: ConfigErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);

    this.name = "ConfigError";
  }
}

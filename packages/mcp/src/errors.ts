/**
 * Errors carry codes, not just prose.
 *
 * Every failure in the MCP control plane surfaces a stable, machine-readable
 * `code`. Agents, logs, and tests branch on the code — never on a message
 * string, which is free to change for humans without breaking machines.
 */

import { VoloError } from "@volo/errors";

export type McpErrorCode =
  | "MCP_UNKNOWN_TOOL"
  | "MCP_GENERATE_UNAVAILABLE"
  | "MCP_CONTENT_STORE_UNAVAILABLE"
  | "MCP_OPERATOR_REQUIRED";

/** Anything the MCP control plane can refuse to do. */
export class McpError extends VoloError<McpErrorCode> {
  constructor(code: McpErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);

    this.name = "McpError";
  }
}

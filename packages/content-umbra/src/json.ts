import { ParseError } from "@lesto/content-shared/errors";
import { sanitizeObject } from "@lesto/content-shared/sanitize";
import type { Parser, ParseOutput } from "./types";

/**
 * @deprecated Use ParseError from @lesto/content-shared/errors instead.
 * Kept for backwards compatibility.
 */
export class JsonParseError extends ParseError {
  readonly filePath: string;

  constructor(filePath: string, cause: unknown) {
    const message = cause instanceof SyntaxError ? cause.message : String(cause);
    super(`Failed to parse JSON at ${filePath}: ${message}`, { filePath, cause });
    this.name = "JsonParseError";
    this.filePath = filePath;
  }
}

export const jsonParser: Parser = {
  name: "json",
  extensions: ["json"],
  hasContent: false,

  parse(content: string, filePath: string): ParseOutput {
    try {
      const data = JSON.parse(content);

      if (typeof data !== "object" || data === null || Array.isArray(data)) {
        throw new Error("JSON must be an object at the root level");
      }

      // Sanitize to prevent prototype pollution
      const sanitized = sanitizeObject(data as Record<string, unknown>);

      return {
        data: sanitized,
        content: "",
      };
    } catch (error) {
      throw new JsonParseError(filePath, error);
    }
  },
};

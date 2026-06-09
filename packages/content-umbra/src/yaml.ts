import yaml from "js-yaml";
import { ParseError } from "@keel/content-shared/errors";
import { sanitizeObject } from "@keel/content-shared/sanitize";
import type { Parser, ParseOutput } from "./types";

/**
 * @deprecated Use ParseError from @keel/content-shared/errors instead.
 * Kept for backwards compatibility.
 */
export class YamlParseError extends ParseError {
  readonly filePath: string;

  constructor(filePath: string, cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(`Failed to parse YAML at ${filePath}: ${message}`, { filePath, cause });
    this.name = "YamlParseError";
    this.filePath = filePath;
  }
}

export const yamlParser: Parser = {
  name: "yaml",
  extensions: ["yaml", "yml"],
  hasContent: false,

  parse(content: string, filePath: string): ParseOutput {
    try {
      const data = yaml.load(content);

      if (data === null) {
        return {
          data: {},
          content: "",
        };
      }

      if (typeof data !== "object" || Array.isArray(data)) {
        throw new Error("YAML must be an object at the root level");
      }

      // Sanitize to prevent prototype pollution
      const sanitized = sanitizeObject(data as Record<string, unknown>);

      return {
        data: sanitized,
        content: "",
      };
    } catch (error) {
      if (error instanceof YamlParseError) throw error;
      throw new YamlParseError(filePath, error);
    }
  },
};

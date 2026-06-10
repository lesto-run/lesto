/**
 * Shared tool utilities for MCP server implementations.
 * Consolidates zodToMcpSchema and ToolBuilder to avoid duplication.
 */

import { z } from "zod";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

// Constants for tool defaults
export const DEFAULT_SEARCH_LIMIT = 10;
export const MAX_SEARCH_LIMIT = 100;

/**
 * Convert a Zod schema to MCP-compatible JSON Schema format.
 * Removes the $schema property, which is not allowed in MCP tool definitions.
 *
 * WHY zod v4's native `z.toJSONSchema`: this package runs on zod v4, whose
 * internal representation `zod-to-json-schema@3` cannot read — it would silently
 * emit an empty `{ $schema }` object, dropping every property and the `required`
 * list. That empty schema both misinforms the model AND defeats argument
 * validation (see http.ts#validateToolArgs). The built-in serializer produces a
 * faithful schema with properties/required.
 */
export function zodToMcpSchema(schema: z.ZodType): {
  type: "object";
  properties?: { [key: string]: object };
  required?: string[];
  [key: string]: unknown;
} {
  const jsonSchema = z.toJSONSchema(schema) as { $schema?: string; [key: string]: unknown };

  const { $schema: _, ...rest } = jsonSchema;

  return rest as {
    type: "object";
    properties?: { [key: string]: object };
    required?: string[];
    [key: string]: unknown;
  };
}

/**
 * Fluent builder for creating MCP tool definitions.
 * Provides a declarative API for defining tools with type-safe schemas.
 */
export class ToolBuilder {
  private tool: Partial<Tool> = {};

  static create(name: string): ToolBuilder {
    return new ToolBuilder().name(name);
  }

  name(n: string): this {
    this.tool.name = n;
    return this;
  }

  description(d: string): this {
    this.tool.description = d;
    return this;
  }

  params(schema: z.ZodObject<z.ZodRawShape>): this {
    this.tool.inputSchema = zodToMcpSchema(schema.strict());
    return this;
  }

  noParams(): this {
    return this.params(z.object({}));
  }

  build(): Tool {
    return this.tool as Tool;
  }
}

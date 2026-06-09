/**
 * Schema Introspector
 *
 * Provides runtime introspection of schema structures for type generation
 * and frontmatter scaffolding. Supports multiple schema libraries.
 *
 * ## Supported Libraries
 * - Zod (v4) - full introspection via internal .def structure
 * - Other Standard Schema implementations - limited support (types only)
 *
 * For libraries that don't expose internal structure, we fall back to
 * `Record<string, unknown>` for type generation.
 */

import type { StandardSchemaV1 } from "@standard-schema/spec";

// ============================================================================
// Types
// ============================================================================

export interface SchemaDef {
  type: string;
  shape?: Record<string, unknown>;
  element?: unknown;
  keyType?: unknown;
  valueType?: unknown;
  entries?: Record<string, unknown>;
  values?: unknown[];
  options?: unknown[];
  left?: unknown;
  right?: unknown;
  innerType?: unknown;
  in?: unknown;
  defaultValue?: unknown;
}

// ============================================================================
// Schema Detection
// ============================================================================

/**
 * Check if a value implements Standard Schema v1.
 */
export function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  return (
    value !== null &&
    typeof value === "object" &&
    "~standard" in value &&
    typeof (value as StandardSchemaV1)["~standard"] === "object"
  );
}

/**
 * Check if a value is a Zod schema by looking for the internal ._def structure.
 * Zod exposes schema internals via ._def property.
 */
export function isZodSchema(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    "_def" in value &&
    typeof (value as { ["_def"]: unknown })["_def"] === "object"
  );
}

// ============================================================================
// Zod-specific Introspection
// ============================================================================

/**
 * Get the internal definition from a Zod schema.
 * Returns undefined for non-Zod schemas.
 *
 * Supports both Zod v3 (._def.typeName) and Zod v4 (._def.type / .def.type).
 */
export function getZodDef(schema: unknown): SchemaDef | undefined {
  if (!schema || typeof schema !== "object") return undefined;

  const obj = schema as Record<string, unknown>;

  // Try ._def first (both Zod v3 and v4 use this for internal definition)
  const defSource = obj["_def"] ?? obj["def"];
  if (!defSource || typeof defSource !== "object") return undefined;

  const typedDef = defSource as Record<string, unknown>;

  // Zod v3 uses 'typeName' (e.g., "ZodString"), v4 uses 'type' directly (e.g., "string")
  let type: string | undefined;
  if (typeof typedDef["typeName"] === "string") {
    // Zod v3: "ZodString" -> "string"
    type = (typedDef["typeName"] as string).replace(/^Zod/, "").toLowerCase();
  } else if (typeof typedDef["type"] === "string") {
    // Zod v4: "string" (already lowercase)
    type = typedDef["type"] as string;
  }

  if (!type) return undefined;

  // For object schemas, shape may be a function (Zod v3) or an object (Zod v4)
  const shapeRaw = typedDef["shape"];
  const shape =
    typeof shapeRaw === "function"
      ? (shapeRaw as () => Record<string, unknown>)()
      : (shapeRaw as Record<string, unknown> | undefined);

  const entriesRaw = typedDef["entries"] ?? typedDef["values"];
  const entries =
    entriesRaw !== null && typeof entriesRaw === "object"
      ? (entriesRaw as Record<string, unknown>)
      : undefined;

  const valuesRaw = typedDef["values"] as unknown[] | undefined;
  const optionsRaw = typedDef["options"] as unknown[] | undefined;

  return {
    type,
    ...(shape === undefined ? {} : { shape }),
    element: typedDef["element"] ?? typedDef["type"],
    valueType: typedDef["valueType"],
    ...(entries === undefined ? {} : { entries }),
    ...(valuesRaw === undefined ? {} : { values: valuesRaw }),
    ...(optionsRaw === undefined ? {} : { options: optionsRaw }),
    left: typedDef["left"],
    right: typedDef["right"],
    innerType: typedDef["innerType"],
    in: typedDef["in"],
    defaultValue: typedDef["defaultValue"],
  };
}

/**
 * Get the type name from a Zod schema.
 * Unwraps wrapper types (optional, default, nullable) to get the base type.
 */
export function getZodTypeName(schema: unknown): string {
  const def = getZodDef(schema);
  if (!def) return "unknown";

  if (def.type === "default" || def.type === "optional" || def.type === "nullable") {
    return getZodTypeName(def.innerType ?? def.in);
  }

  return def.type;
}

// ============================================================================
// Generic Schema Introspection
// ============================================================================

/**
 * Get schema definition, supporting multiple schema libraries.
 *
 * Tries in order:
 * 1. Zod introspection (if it's a Zod schema)
 * 2. Returns undefined for non-introspectable schemas
 *
 * @param schema - Any schema (Zod, Valibot, ArkType, etc.)
 * @returns Schema definition or undefined
 */
export function getSchemaDef(schema: unknown): SchemaDef | undefined {
  // Zod has the most complete introspection support
  if (isZodSchema(schema)) {
    return getZodDef(schema);
  }

  // Future: Add support for other libraries here
  // - Valibot: Could potentially read .type and other properties
  // - ArkType: Has its own introspection API

  return undefined;
}

/**
 * Get the type name from any supported schema.
 */
export function getSchemaTypeName(schema: unknown): string {
  const def = getSchemaDef(schema);
  if (!def) return "unknown";

  // Unwrap wrapper types
  if (def.type === "default" || def.type === "optional" || def.type === "nullable") {
    return getSchemaTypeName(def.innerType ?? def.in);
  }

  return def.type;
}

/**
 * Check if a schema is introspectable (can provide structural information).
 */
export function isIntrospectable(schema: unknown): boolean {
  return getSchemaDef(schema) !== undefined;
}

/**
 * Get the object shape from a schema, if it's an object schema.
 */
export function getSchemaShape(schema: unknown): Record<string, unknown> | undefined {
  const def = getSchemaDef(schema);
  if (!def || def.type !== "object") return undefined;
  return def.shape as Record<string, unknown> | undefined;
}

/**
 * Get the element type from an array schema.
 */
export function getArrayElement(schema: unknown): unknown | undefined {
  const def = getSchemaDef(schema);
  if (!def || def.type !== "array") return undefined;
  return def.element;
}

// ============================================================================
// JSON Schema Conversion
// ============================================================================

export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  additionalProperties?: JsonSchema | boolean;
  enum?: unknown[];
  const?: unknown;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  allOf?: JsonSchema[];
  description?: string;
  default?: unknown;
  $schema?: string;
  [key: string]: unknown;
}

/**
 * Check if a schema implements StandardJSONSchemaV1 (has jsonSchema.input method).
 */
function hasJsonSchemaMethod(schema: unknown): schema is {
  "~standard": { jsonSchema: { input: (opts?: unknown) => JsonSchema } };
} {
  if (!isStandardSchema(schema)) return false;
  const std = (schema as unknown as { "~standard": Record<string, unknown> })["~standard"];
  return (
    "jsonSchema" in std &&
    std["jsonSchema"] !== null &&
    typeof std["jsonSchema"] === "object" &&
    "input" in (std["jsonSchema"] as Record<string, unknown>) &&
    typeof (std["jsonSchema"] as Record<string, unknown>)["input"] === "function"
  );
}

/**
 * Convert a schema definition type to JSON Schema type.
 */
function defTypeToJsonType(type: string): string | undefined {
  const TYPE_MAP: Record<string, string> = {
    string: "string",
    number: "number",
    int: "integer",
    bigint: "integer",
    boolean: "boolean",
    null: "null",
    undefined: "null",
    object: "object",
    array: "array",
  };
  return TYPE_MAP[type];
}

/** Handler for converting a Zod type to JSON Schema */
type ZodTypeHandler = (
  def: SchemaDef,
  depth: number,
  recurse: (schema: unknown, depth: number) => JsonSchema,
) => JsonSchema | null;

/** Unwrap inner type from wrapper schemas */
function getInnerSchema(def: SchemaDef): unknown {
  return def.innerType ?? def.in;
}

/** Check if a field definition is required (not optional/nullable) */
function isRequiredField(value: unknown): boolean {
  const fieldDef = getZodDef(value);
  return fieldDef !== undefined && fieldDef.type !== "optional" && fieldDef.type !== "nullable";
}

/** Handler registry for Zod type conversion - per AGENTS.md pattern */
const ZOD_TYPE_HANDLERS: Record<string, ZodTypeHandler> = {
  optional: (def, depth, recurse) => recurse(getInnerSchema(def), depth + 1),

  nullable: (def, depth, recurse) => ({
    anyOf: [recurse(getInnerSchema(def), depth + 1), { type: "null" }],
  }),

  default: (def, depth, recurse) => ({
    ...recurse(getInnerSchema(def), depth + 1),
    default: def.defaultValue,
  }),

  object: (def, depth, recurse) => {
    if (!def.shape) return null;
    const entries = Object.entries(def.shape);
    const properties = Object.fromEntries(
      entries.map(([key, value]) => [key, recurse(value, depth + 1)]),
    );
    const required = entries.filter(([, value]) => isRequiredField(value)).map(([key]) => key);
    return {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
    };
  },

  array: (def, depth, recurse) =>
    def.element ? { type: "array", items: recurse(def.element, depth + 1) } : null,

  record: (def, depth, recurse) =>
    def.valueType
      ? { type: "object", additionalProperties: recurse(def.valueType, depth + 1) }
      : null,

  enum: (def) => (def.entries ? { enum: Object.values(def.entries) } : null),

  literal: (def) => {
    if (def.values === undefined) return null;
    const values = def.values;
    return Array.isArray(values) && values.length === 1 ? { const: values[0] } : { enum: values };
  },

  union: (def, depth, recurse) =>
    def.options
      ? { anyOf: (def.options as unknown[]).map((opt) => recurse(opt, depth + 1)) }
      : null,

  intersection: (def, depth, recurse) =>
    def.left && def.right
      ? { allOf: [recurse(def.left, depth + 1), recurse(def.right, depth + 1)] }
      : null,
};

/**
 * Convert a Zod schema definition to JSON Schema recursively.
 * This is a minimal implementation for MCP schema discovery.
 */
function zodDefToJsonSchema(schema: unknown, depth = 0): JsonSchema {
  if (depth > 20) return {};

  const def = getZodDef(schema);
  if (!def) return {};

  // Try handler registry first
  const handler = ZOD_TYPE_HANDLERS[def.type];
  if (handler) {
    const result = handler(def, depth, zodDefToJsonSchema);
    if (result !== null) return result;
  }

  // Primitive types
  const jsonType = defTypeToJsonType(def.type);
  if (jsonType && def.type !== "object" && def.type !== "array") {
    return { type: jsonType };
  }

  return {};
}

/**
 * Convert any Standard Schema to JSON Schema.
 *
 * Tries in order:
 * 1. StandardJSONSchemaV1 interface (~standard.jsonSchema.input())
 * 2. Zod-specific introspection via .def
 * 3. Returns minimal object schema as fallback
 *
 * @param schema - Any Standard Schema (Zod, Valibot, ArkType, etc.)
 * @returns JSON Schema representation
 */
export function schemaToJsonSchema(schema: unknown): JsonSchema {
  // Try StandardJSONSchemaV1 interface first
  if (hasJsonSchemaMethod(schema)) {
    try {
      const result = schema["~standard"].jsonSchema.input();
      // Remove $schema field if present for MCP compatibility
      const { $schema: _, ...rest } = result;
      return rest;
    } catch {
      // Fall through to other methods
    }
  }

  // Try Zod-specific introspection
  if (isZodSchema(schema)) {
    return zodDefToJsonSchema(schema);
  }

  // Fallback: return minimal object schema
  return { type: "object" };
}

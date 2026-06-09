import type * as ZodModule from "zod";
import type { z as ZodNamespace } from "zod";

/** Symbol used to mark schemas as Docks references */
const REFERENCE_MARKER = "__docksReference" as const;

/**
 * Mark any schema as a reference to another collection.
 *
 * This is a schema-agnostic way to add reference metadata to schemas.
 * The schema will be mutated to include reference information.
 *
 * @param schema - Any string schema (from Zod, Valibot, etc.)
 * @param collectionName - The target collection name
 * @returns The same schema with reference metadata added
 *
 * @example
 * ```ts
 * // With Zod
 * import { z } from "zod";
 * const authorRef = markAsReference(z.string(), "authors");
 *
 * // With Valibot
 * import * as v from "valibot";
 * const authorRef = markAsReference(v.string(), "authors");
 * ```
 */
export function markAsReference<T extends object>(schema: T, collectionName: string): T {
  // Try to add marker to _def (Zod-style)
  // Note: This mutates the schema's _def object. In practice, each schema created with
  // z.string() etc. is a new instance, so mutation is safe in typical usage.
  // For truly shared schemas, users should create new instances for each reference.
  const schemaDef = (schema as { ["_def"]?: unknown })["_def"];
  if ("_def" in schema && typeof schemaDef === "object" && schemaDef !== null) {
    (schemaDef as Record<string, unknown>)[REFERENCE_MARKER] = collectionName;
    return schema;
  }

  // Add marker directly to the schema object as fallback
  (schema as Record<string, unknown>)[REFERENCE_MARKER] = collectionName;
  return schema;
}

// Cache for lazily imported Zod namespace
let zodNamespace: typeof ZodNamespace | null = null;
let zodImportAttempted = false;

/**
 * Try to load Zod's z namespace dynamically.
 * Returns null if Zod is not installed.
 *
 * TODO: Replace require() with dynamic import() when reference() can be made async.
 * This would require a breaking API change since reference() is currently synchronous.
 */
function tryLoadZod(): typeof ZodNamespace | null {
  if (zodImportAttempted) return zodNamespace;
  zodImportAttempted = true;

  try {
    // Use require() for synchronous loading - works in both Bun and Node.js
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("zod") as typeof ZodModule;
    zodNamespace = mod.z;
    return zodNamespace;
  } catch {
    return null;
  }
}

/**
 * Create a Zod reference schema pointing to another collection.
 *
 * This function requires Zod to be installed. For schema-agnostic code,
 * use `markAsReference` instead.
 *
 * @param collectionName - The target collection name
 * @returns A Zod string schema with reference metadata
 *
 * @example
 * ```ts
 * const postSchema = z.object({
 *   title: z.string(),
 *   author: reference("authors"),
 * });
 * ```
 */
export function reference(collectionName: string): unknown {
  const z = tryLoadZod();
  if (!z) {
    throw new Error(
      `The 'reference()' function requires Zod to be installed. ` +
      `Either install Zod ('npm install zod') or use 'markAsReference()' with your schema library.`
    );
  }

  const schema = z.string();
  return markAsReference(schema, collectionName);
}

/**
 * Check if a schema is marked as a reference.
 * Works with any schema library.
 */
export function isReference(schema: unknown): boolean {
  if (!schema || typeof schema !== "object") return false;

  // Check _def (Zod-style)
  const def = (schema as { ["_def"]?: Record<string, unknown> })["_def"];
  if (def !== undefined && REFERENCE_MARKER in def) {
    return true;
  }

  // Check direct property (fallback)
  return REFERENCE_MARKER in schema;
}

/**
 * Get the target collection name from a reference schema.
 * Works with any schema library.
 */
export function getReferenceTarget(schema: unknown): string | undefined {
  if (!schema || typeof schema !== "object") return undefined;

  // Check _def (Zod-style)
  const def = (schema as { ["_def"]?: Record<string, unknown> })["_def"];
  if (def && REFERENCE_MARKER in def) {
    return def[REFERENCE_MARKER] as string;
  }

  // Check direct property (fallback)
  if (REFERENCE_MARKER in schema) {
    return (schema as Record<string, unknown>)[REFERENCE_MARKER] as string;
  }

  return undefined;
}

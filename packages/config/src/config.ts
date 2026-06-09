/**
 * Typed configuration loading with validation.
 *
 * `loadConfig` reads a schema against a raw string source (think `process.env`),
 * enforces required fields, fills defaults, and coerces each present value to
 * the declared type. It refuses — with a coded `ConfigError` — anything it
 * cannot honor: a missing required field, or a value that won't parse.
 */

import { ConfigError } from "./errors";
import type { ConfigValue, Field, Schema } from "./types";

/** The truthy string spellings a boolean field accepts. */
const BOOLEAN_TRUE = new Set(["true", "1"]);

/** The falsy string spellings a boolean field accepts. */
const BOOLEAN_FALSE = new Set(["false", "0"]);

/**
 * Coerce one present raw value into its declared type.
 *
 * The caller has already established the value is present; here we only decide
 * whether it is *valid* for the field's type, throwing `CONFIG_INVALID` if not.
 */
function coerce(name: string, field: Field, raw: string): ConfigValue {
  if (field.type === "string") {
    return raw;
  }

  if (field.type === "number") {
    const value = Number(raw);

    // `Number("")` is 0 and `Number("12px")` is NaN; only NaN is a real failure.
    if (Number.isNaN(value)) {
      throw new ConfigError("CONFIG_INVALID", `Config field "${name}" is not a number.`, {
        name,
        type: field.type,
        value: raw,
      });
    }

    return value;
  }

  // Booleans accept a small, explicit vocabulary — nothing else passes.
  if (BOOLEAN_TRUE.has(raw)) {
    return true;
  }

  if (BOOLEAN_FALSE.has(raw)) {
    return false;
  }

  throw new ConfigError("CONFIG_INVALID", `Config field "${name}" is not a boolean.`, {
    name,
    type: field.type,
    value: raw,
  });
}

/**
 * Load and validate config for a schema against a raw string source.
 *
 * For each field we read `source[field.env ?? fieldName]`. Absent and required
 * is fatal; absent and optional falls back to the field's default (or is simply
 * omitted when there is none). A present value is coerced to its declared type.
 */
export function loadConfig<S extends Schema>(
  schema: S,
  source: Record<string, string | undefined>,
): Record<string, ConfigValue> {
  const result: Record<string, ConfigValue> = {};

  for (const [name, field] of Object.entries(schema)) {
    // A field may read from a differently-named source key; default to its own.
    const sourceKey = field.env ?? name;

    const raw = source[sourceKey];

    if (raw === undefined) {
      if (field.required === true) {
        throw new ConfigError("CONFIG_MISSING", `Config field "${name}" is required.`, {
          name,
          sourceKey,
        });
      }

      // Optional and absent: fall back to a default, or omit the key entirely.
      if (field.default !== undefined) {
        result[name] = field.default;
      }

      continue;
    }

    result[name] = coerce(name, field, raw);
  }

  return result;
}

/**
 * The vocabulary of a config schema.
 *
 * A schema is a flat map of field name -> declaration. Each field names the
 * type it coerces to, whether it is required, an optional default, and the
 * source key it reads from (which defaults to the field name itself).
 */

/** The scalar kinds a field can coerce a raw string into. */
export type FieldType = "string" | "number" | "boolean";

/** A single field's declaration within a schema. */
export interface Field {
  type: FieldType;

  required?: boolean;

  default?: string | number | boolean;

  /** The source key to read; defaults to the field's own name when absent. */
  env?: string;
}

/** A flat map of field name to its declaration. */
export type Schema = Record<string, Field>;

/** A coerced config value: the runtime result of reading one field. */
export type ConfigValue = string | number | boolean;

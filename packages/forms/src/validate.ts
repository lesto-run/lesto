/**
 * Submission validation: take the raw values a form posted and reconcile them
 * against the spec. Pure — no throws, no I/O. It returns a per-field error map
 * and an overall `valid` flag the caller acts on.
 *
 * The rules, per field:
 *   required  — a missing or blank value is an error
 *   email     — must match a simple address shape
 *   number    — must parse to a finite number (Number, not NaN)
 *   checkbox  — coerced to a boolean; never an error on its own
 *   select    — the value must be one of the field's options
 *
 * Validation runs only on a *present* value; an absent value is the `required`
 * check's business, so an optional, omitted field is silently fine.
 */

import type { FormField, FormSpec } from "./types";

/** A deliberately simple address shape — one `@`, a dotted domain. Not RFC 5322. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Is a value absent or blank? Blank = an all-whitespace string. */
function isBlank(value: unknown): boolean {
  if (value === undefined || value === null) return true;

  if (typeof value === "string") return value.trim() === "";

  return false;
}

/**
 * Does this value parse to a finite number?
 *
 * A blank string never reaches here — `fieldError` filters blanks through
 * `isBlank` before any type rule runs — so this only judges a non-blank value.
 */
function isNumeric(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);

  if (typeof value === "string") return Number.isFinite(Number(value));

  return false;
}

/** The single error message for one field, or `undefined` when it passes. */
function fieldError(field: FormField, present: boolean, value: unknown): string | undefined {
  // Required comes first: a blank required field fails before type rules run.
  if (field.required === true && isBlank(value)) {
    return `${field.name} is required`;
  }

  // Type rules only judge a value that is actually there and non-blank. An
  // absent or blank optional field has nothing left to check.
  if (!present || isBlank(value)) {
    return undefined;
  }

  if (field.type === "email" && (typeof value !== "string" || !EMAIL.test(value))) {
    return `${field.name} must be a valid email`;
  }

  if (field.type === "number" && !isNumeric(value)) {
    return `${field.name} must be a number`;
  }

  if (field.type === "select" && !(field.options ?? []).includes(stringOf(value))) {
    return `${field.name} must be one of the allowed options`;
  }

  return undefined;
}

/** The string form of a value for option membership; non-strings never match. */
function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Validate `values` against `spec`. Collects one message per failing field.
 *
 * Note: a `checkbox` field carries no failure mode of its own — any value
 * coerces to a boolean — so it only participates via the `required` check.
 */
export function validateSubmission(
  spec: FormSpec,
  values: Record<string, unknown>,
): { valid: boolean; errors: Record<string, string> } {
  const errors: Record<string, string> = {};

  for (const field of spec.fields) {
    const present = Object.hasOwn(values, field.name);

    const message = fieldError(field, present, values[field.name]);

    if (message !== undefined) {
      errors[field.name] = message;
    }
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

/**
 * Prop validation: take whatever the AI emitted and reconcile it against a
 * component's declared `PropSpec`s. The result is a clean prop bag the renderer
 * can trust, plus a list of human-readable errors for anything that went wrong.
 *
 * The rules, per spec:
 *   - unknown props (not in the schema) are silently dropped
 *   - an absent prop falls back to its `default`, if one is declared
 *   - a missing *required* prop is an error
 *   - values are coerced to their declared type where it's safe
 *   - an enum value outside the allowed `values` is an error
 */

import type { PropSpec, PropType } from "./types";

/** Coerce a raw value toward `type`. Returns the value unchanged if it can't. */
function coerce(type: PropType, value: unknown): unknown {
  if (type === "number") return coerceNumber(value);

  if (type === "boolean") return coerceBoolean(value);

  // string / enum / object / array pass through; the renderer and enum check
  // handle them. We never invent structure that wasn't there.
  return value;
}

/** A numeric string becomes a number; anything non-finite is left as-is. */
function coerceNumber(value: unknown): unknown {
  if (typeof value === "number") return value;

  if (typeof value === "string") {
    const n = Number(value);

    if (value.trim() !== "" && Number.isFinite(n)) return n;
  }

  return value;
}

/** The strings "true"/"false" become booleans; everything else is left as-is. */
function coerceBoolean(value: unknown): unknown {
  if (typeof value === "boolean") return value;

  if (value === "true") return true;

  if (value === "false") return false;

  return value;
}

/** Is `value` one of these allowed enum strings? A non-string is never a member. */
function isAllowed(values: readonly string[], value: unknown): boolean {
  return typeof value === "string" && values.includes(value);
}

/**
 * Validate `props` against `specs`. Pure: no throws, no mutation of the input.
 */
export function validateProps(
  specs: Record<string, PropSpec>,
  props: Record<string, unknown>,
): { props: Record<string, unknown>; errors: string[] } {
  const out: Record<string, unknown> = {};

  const errors: string[] = [];

  for (const [name, spec] of Object.entries(specs)) {
    const present = Object.hasOwn(props, name);

    // Absent prop: apply a default if one exists, else flag if required.
    if (!present) {
      if (spec.default !== undefined) {
        out[name] = spec.default;
      } else if (spec.required === true) {
        errors.push(`missing required prop "${name}"`);
      }

      continue;
    }

    const value = coerce(spec.type, props[name]);

    // An enum value must be one of the declared options. An enum spec with no
    // `values` constrains nothing, so only a present-and-mismatched value errs.
    if (spec.type === "enum" && spec.values !== undefined && !isAllowed(spec.values, value)) {
      errors.push(`prop "${name}" must be one of [${spec.values.join(", ")}]`);

      continue;
    }

    out[name] = value;
  }

  return { props: out, errors };
}

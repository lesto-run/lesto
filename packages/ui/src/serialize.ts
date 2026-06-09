/**
 * The wire guard for island props.
 *
 * Island props are serialized on the server and revived in the browser, so they
 * must be pure JSON — the values `JSON.stringify`/`JSON.parse` round-trip
 * losslessly. A function, a `Date`, a class instance, a `Symbol`, a `bigint`, or
 * `undefined` would either vanish or arrive as something the client cannot use.
 * We reject them at the boundary with a stable code, rather than let a prop
 * silently disappear between server and client.
 *
 * The check is structural and reports the FIRST offending path (e.g.
 * `props.user.onClick`), so the author is told exactly which value to fix.
 */

import { UiError } from "./errors";

/** A JSON-shaped value: the closure of null/boolean/number/string under array/object. */
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/**
 * The first path at which `value` is not JSON-serializable, or `undefined` if
 * the whole structure is clean. `path` seeds the reported location.
 */
function firstNonSerializable(value: unknown, path: string): string | undefined {
  if (value === null) return undefined;

  // Primitives that JSON round-trips losslessly. A non-finite number (NaN,
  // Infinity) becomes `null` through JSON, so it is not faithfully serializable.
  if (typeof value === "boolean" || typeof value === "string") return undefined;

  if (typeof value === "number") return Number.isFinite(value) ? undefined : path;

  // Arrays: clean iff every element is clean, reported left to right.
  if (Array.isArray(value)) {
    for (const [index, element] of value.entries()) {
      const offender = firstNonSerializable(element, `${path}[${index}]`);

      if (offender !== undefined) return offender;
    }

    return undefined;
  }

  // A plain object: clean iff every own value is clean. Anything with a custom
  // prototype (Date, Map, class instance) is rejected — it would not round-trip
  // as the author intends.
  if (typeof value === "object" && isPlainObject(value)) {
    for (const [key, nested] of Object.entries(value)) {
      const offender = firstNonSerializable(nested, `${path}.${key}`);

      if (offender !== undefined) return offender;
    }

    return undefined;
  }

  // Everything else — function, symbol, bigint, undefined, exotic object — is
  // not JSON and so cannot cross the wire.
  return path;
}

/** Is `value` a plain `{}`-style object (Object.prototype or null prototype)? */
function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as object | null;

  return proto === null || proto === Object.prototype;
}

/**
 * Assert that `props` is pure JSON, returning the same bag typed as JSON. Throws
 * `UI_ISLAND_PROPS_NOT_SERIALIZABLE` naming the offending path otherwise.
 */
export function assertSerializable(
  component: string,
  props: Record<string, unknown>,
): Record<string, JsonValue> {
  const offender = firstNonSerializable(props, "props");

  if (offender !== undefined) {
    throw new UiError(
      "UI_ISLAND_PROPS_NOT_SERIALIZABLE",
      `island "${component}" has a non-serializable prop at ${offender}`,
      { component, path: offender },
    );
  }

  // The structural walk above proves the cast true: every reachable value is JSON.
  return props as Record<string, JsonValue>;
}

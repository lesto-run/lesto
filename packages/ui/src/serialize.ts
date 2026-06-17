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

import type { IslandMount } from "./island";

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

/**
 * Serialize a page-wide island manifest ARRAY for safe embedding in an inline
 * `<script>` — the DEMOTED Registry/`UiNode` content path's emission (ADR 0011
 * Increment 2). The canonical `.page` path uses {@link serializeScriptJson} on
 * one mount object per island (co-located, streaming-safe); this array form is
 * the niche where `renderPage` walks an AI-/DB-driven tree into one
 * `#keel-islands` manifest. Same audited escape, applied to the whole array.
 *
 * `JSON.stringify` alone is NOT safe to drop into HTML. A string value carrying
 * `</script>` (or `<!--`, or the JS line terminators U+2028 / U+2029) terminates
 * the surrounding element and lets attacker-influenced prop data execute — a
 * textbook SSR-serialization XSS. HTML-entity escaping does not help either:
 * entities are not decoded inside `<script>`. So we escape the breakout
 * characters to their `\uXXXX` JSON escapes, which `JSON.parse` reads back as the
 * byte-identical string — `<` and `>` (defeat `</script>` and `<!--`), `&`
 * (belt-and-braces), and the two separators a JS parser treats as line breaks.
 *
 * The emission that consumes this MUST use `<script type="application/json">` and
 * revive with `JSON.parse(el.textContent)` on the client: a non-executable type
 * keeps even a future escaping miss inert, and the payload stays compatible with
 * a strict, nonce-based CSP. This is the one audited seam every manifest payload
 * crosses — never hand-roll `JSON.stringify` into a `<script>`, and never splice
 * it in with `String.prototype.replace`, whose `$&`/`$'` tokens are themselves an
 * injection vector.
 *
 * Mirrors the script-context escape that `@keel/seo` and `@keel/content-shared`
 * already apply to inline JSON-LD; kept local so `@keel/ui`'s render hot path
 * pulls in no extra dependency for it.
 */
export function serializeManifest(manifest: readonly IslandMount[]): string {
  return serializeScriptJson(manifest);
}

/**
 * Serialize any value to JSON safe to embed inside a `<script>` element.
 *
 * The same script-context escape {@link serializeManifest} applies, generalized
 * to one value — used by the per-island co-located mount script (ADR 0011),
 * where each island emits its OWN `IslandMount` object rather than the page-wide
 * array. The same rules and the same one-audited-seam discipline apply: emit only
 * as `<script type="application/json">`, revive with `JSON.parse`, never a bare
 * `JSON.stringify` into a `<script>`.
 */
export function serializeScriptJson(value: unknown): string {
  // The JS line/paragraph separators, built from code points so no raw
  // U+2028/U+2029 byte sits in this source (where tooling may mangle it).
  const lineSeparator = String.fromCharCode(0x2028);
  const paragraphSeparator = String.fromCharCode(0x2029);

  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll(lineSeparator, "\\u2028")
    .replaceAll(paragraphSeparator, "\\u2029");
}

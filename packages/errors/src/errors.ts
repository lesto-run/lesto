/**
 * Errors carry codes, not just prose.
 *
 * Every failure in Lesto surfaces a stable, machine-readable `code`. Logs,
 * tests, API responses, and the MCP surface branch on the code — never on a
 * message string, which is free to change for humans without breaking machines.
 */

/**
 * The process-global brand every {@link LestoError} carries, so error identity is
 * recognized by BRAND rather than by `instanceof`.
 *
 * A monorepo install can end up with two copies of `@lesto/errors` (a version
 * mispin, a transitive-dep dedupe miss — the router/ui 0.1.3 mispin did exactly
 * this): an error built by copy A is not `instanceof` copy B's class, so a coded
 * refusal thrown across that seam silently fell through every `instanceof` gate
 * and downgraded — a 400 became a 500. `Symbol.for` reads from the process-global
 * registry, so BOTH copies resolve the SAME symbol. The brand survives the split
 * where class identity does not, and a future dep-dup can never again silently
 * remap error → status. (Mirrors `@lesto/web`'s `Symbol.for("lesto.file-route.notFound")`.)
 */
const LESTO_ERROR_BRAND = Symbol.for("lesto.error");

/** The root of every Lesto error. Generic over its code union for exhaustiveness. */
export class LestoError<Code extends string = string> extends Error {
  readonly code: Code;

  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: Code, message: string, details: Record<string, unknown> = {}) {
    super(message);

    this.name = "LestoError";
    this.code = code;
    this.details = Object.freeze({ ...details });

    // Stamp the cross-copy brand so recognition is by {@link isLestoError}, not
    // `instanceof` — a duplicate `@lesto/errors` copy breaks class identity but not
    // this process-global symbol. Non-enumerable (the defineProperty default): a
    // symbol key is already invisible to `JSON.stringify`/`Object.keys`, and
    // non-enumerability additionally keeps the marker out of `{ ...error }` spreads
    // and `Object.assign`, so an error's public shape stays its `code`/`message`/
    // `details`. Set in the constructor, not as a class field, because a computed
    // `Symbol.for(...)` key is a plain `symbol`, not the `unique symbol` a class
    // field's computed name requires.
    Object.defineProperty(this, LESTO_ERROR_BRAND, { value: true });
  }
}

/**
 * True iff `value` is a `LestoError` (or a subclass) — recognized by BRAND, not
 * `instanceof`.
 *
 * Duck-types the process-global {@link LESTO_ERROR_BRAND} rather than walking the
 * prototype chain, so a coded error built by a SECOND copy of `@lesto/errors` (a
 * version mispin, a dedupe miss) is still recognized: `instanceof` compares class
 * identity, which a duplicate copy breaks, but `Symbol.for` resolves the same
 * brand in every copy. A plain `{ code }` object carries no brand and so is NOT a
 * LestoError. The guard also requires a string `code` (which every `LestoError`
 * ctor sets), so the `value is LestoError` assertion cannot lie to a caller that
 * then reads `.code`/`.details` off a branded-but-shapeless object — a real copy,
 * near or foreign, always went through the ctor and carries both.
 */
export function isLestoError(value: unknown): value is LestoError {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[LESTO_ERROR_BRAND] === true &&
    typeof (value as Record<PropertyKey, unknown>).code === "string"
  );
}

/** True iff `value` is a `LestoError` whose code matches exactly. */
export function hasCode(value: unknown, code: string): boolean {
  return isLestoError(value) && value.code === code;
}

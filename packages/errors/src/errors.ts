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
    // this process-global symbol. Non-enumerable (the defineProperty default): an
    // error's public shape is its `code`/`message`/`details`, and the marker must
    // stay out of JSON, spreads, and `Object.keys`. Set in the constructor, not as
    // a class field, because a computed `Symbol.for(...)` key is a plain `symbol`,
    // not the `unique symbol` a class field's computed name requires.
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
 * LestoError — callers that branch on `.code` after this guard stay honest.
 */
export function isLestoError(value: unknown): value is LestoError {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[LESTO_ERROR_BRAND] === true
  );
}

/** True iff `value` is a `LestoError` whose code matches exactly. */
export function hasCode(value: unknown, code: string): boolean {
  return isLestoError(value) && value.code === code;
}

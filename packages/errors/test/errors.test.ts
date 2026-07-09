import { describe, expect, it } from "vitest";

import { hasCode, isLestoError, LestoError } from "../src/errors";

class FooError extends LestoError<"FOO"> {
  constructor(message: string, details?: Record<string, unknown>) {
    super("FOO", message, details);

    this.name = "FooError";
  }
}

describe("LestoError", () => {
  it("carries its code, message, and name", () => {
    const error = new LestoError("THING_BROKE", "the thing broke", { id: 7 });

    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("THING_BROKE");
    expect(error.message).toBe("the thing broke");
    expect(error.name).toBe("LestoError");
  });

  it("freezes the details bag", () => {
    const error = new LestoError("THING_BROKE", "the thing broke", { id: 7 });

    expect(error.details).toEqual({ id: 7 });
    expect(Object.isFrozen(error.details)).toBe(true);
    expect(() => {
      (error.details as Record<string, unknown>)["id"] = 9;
    }).toThrow();
  });

  it("defaults details to an empty frozen object", () => {
    const error = new LestoError("THING_BROKE", "the thing broke");

    expect(error.details).toEqual({});
    expect(Object.isFrozen(error.details)).toBe(true);
  });

  it("supports subclassing with a narrowed code", () => {
    const error = new FooError("foo went wrong", { x: 1 });

    expect(error).toBeInstanceOf(LestoError);
    expect(error.code).toBe("FOO");
    expect(error.name).toBe("FooError");
    expect(error.details).toEqual({ x: 1 });
  });
});

/**
 * Build a `LestoError`-shaped value as a SECOND copy of `@lesto/errors` would: it
 * carries the same process-global brand but is NOT `instanceof` this copy's class.
 * This is the router/ui 0.1.3 dep-dup that downgraded a coded 400 to a 500 through
 * an `instanceof` gate — the case brand-based recognition exists to survive.
 */
function foreignCopyError(code: string): unknown {
  const error: Record<PropertyKey, unknown> = { name: "LestoError", code, message: "x" };

  Object.defineProperty(error, Symbol.for("lesto.error"), { value: true });

  return error;
}

describe("isLestoError", () => {
  it("is true for a LestoError", () => {
    expect(isLestoError(new LestoError("X", "x"))).toBe(true);
  });

  it("is true for a LestoError subclass", () => {
    expect(isLestoError(new FooError("foo"))).toBe(true);
  });

  it("recognizes a foreign-copy LestoError by brand, not instanceof", () => {
    const foreign = foreignCopyError("ROUTER_MALFORMED_PARAM");

    // The old `instanceof`-based recognition would have MISSED this (proving the
    // downgrade bug); the brand duck-type catches it across the duplicate copy.
    expect(foreign instanceof LestoError).toBe(false);
    expect(isLestoError(foreign)).toBe(true);
  });

  it("is false for a plain Error", () => {
    expect(isLestoError(new Error("nope"))).toBe(false);
  });

  it("is false for a non-error", () => {
    expect(isLestoError({ code: "X" })).toBe(false);
  });

  it("is false for null and non-object values", () => {
    // The two guards before the brand check: `null` is `typeof "object"` yet carries
    // no brand, and a primitive is not an object at all.
    expect(isLestoError(null)).toBe(false);
    expect(isLestoError("ROUTER_MALFORMED_PARAM")).toBe(false);
    expect(isLestoError(undefined)).toBe(false);
  });
});

describe("hasCode", () => {
  it("is true when the code matches", () => {
    expect(hasCode(new LestoError("WANTED", "x"), "WANTED")).toBe(true);
  });

  it("is false when the code does not match", () => {
    expect(hasCode(new LestoError("OTHER", "x"), "WANTED")).toBe(false);
  });

  it("is false for a non-LestoError", () => {
    expect(hasCode(new Error("x"), "WANTED")).toBe(false);
  });

  it("matches a foreign-copy LestoError by brand and code", () => {
    // Cross-copy `code`-branching (e.g. `@lesto/cli`'s `hasCode`) must survive a
    // duplicate `@lesto/errors` install too, not just same-copy errors.
    expect(hasCode(foreignCopyError("WANTED"), "WANTED")).toBe(true);
    expect(hasCode(foreignCopyError("OTHER"), "WANTED")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import { hasCode, isKeelError, KeelError } from "../src/errors";

class FooError extends KeelError<"FOO"> {
  constructor(message: string, details?: Record<string, unknown>) {
    super("FOO", message, details);

    this.name = "FooError";
  }
}

describe("KeelError", () => {
  it("carries its code, message, and name", () => {
    const error = new KeelError("THING_BROKE", "the thing broke", { id: 7 });

    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("THING_BROKE");
    expect(error.message).toBe("the thing broke");
    expect(error.name).toBe("KeelError");
  });

  it("freezes the details bag", () => {
    const error = new KeelError("THING_BROKE", "the thing broke", { id: 7 });

    expect(error.details).toEqual({ id: 7 });
    expect(Object.isFrozen(error.details)).toBe(true);
    expect(() => {
      (error.details as Record<string, unknown>)["id"] = 9;
    }).toThrow();
  });

  it("defaults details to an empty frozen object", () => {
    const error = new KeelError("THING_BROKE", "the thing broke");

    expect(error.details).toEqual({});
    expect(Object.isFrozen(error.details)).toBe(true);
  });

  it("supports subclassing with a narrowed code", () => {
    const error = new FooError("foo went wrong", { x: 1 });

    expect(error).toBeInstanceOf(KeelError);
    expect(error.code).toBe("FOO");
    expect(error.name).toBe("FooError");
    expect(error.details).toEqual({ x: 1 });
  });
});

describe("isKeelError", () => {
  it("is true for a KeelError", () => {
    expect(isKeelError(new KeelError("X", "x"))).toBe(true);
  });

  it("is true for a KeelError subclass", () => {
    expect(isKeelError(new FooError("foo"))).toBe(true);
  });

  it("is false for a plain Error", () => {
    expect(isKeelError(new Error("nope"))).toBe(false);
  });

  it("is false for a non-error", () => {
    expect(isKeelError({ code: "X" })).toBe(false);
  });
});

describe("hasCode", () => {
  it("is true when the code matches", () => {
    expect(hasCode(new KeelError("WANTED", "x"), "WANTED")).toBe(true);
  });

  it("is false when the code does not match", () => {
    expect(hasCode(new KeelError("OTHER", "x"), "WANTED")).toBe(false);
  });

  it("is false for a non-KeelError", () => {
    expect(hasCode(new Error("x"), "WANTED")).toBe(false);
  });
});

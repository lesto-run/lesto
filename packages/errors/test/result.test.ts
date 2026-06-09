import { describe, expect, it } from "vitest";

import { KeelError } from "../src/errors";
import { err, isErr, isOk, ok, type Result, unwrap } from "../src/result";

describe("ok / err", () => {
  it("wraps a value as a success", () => {
    expect(ok(42)).toEqual({ ok: true, value: 42 });
  });

  it("wraps an error as a failure", () => {
    const error = new KeelError("BOOM", "boom");

    expect(err(error)).toEqual({ ok: false, error });
  });
});

describe("isOk / isErr", () => {
  it("identifies a success", () => {
    const result: Result<number> = ok(1);

    expect(isOk(result)).toBe(true);
    expect(isErr(result)).toBe(false);
  });

  it("identifies a failure", () => {
    const result: Result<number> = err(new KeelError("BOOM", "boom"));

    expect(isOk(result)).toBe(false);
    expect(isErr(result)).toBe(true);
  });
});

describe("unwrap", () => {
  it("returns the value for a success", () => {
    expect(unwrap(ok("hello"))).toBe("hello");
  });

  it("throws the error as-is when it is an Error", () => {
    const error = new KeelError("BOOM", "boom");

    expect(() => unwrap(err(error))).toThrow(error);
  });

  it("wraps a non-Error failure in a KeelError", () => {
    const result: Result<number, string> = err("plain string");

    try {
      unwrap(result);
      expect.unreachable("unwrap should have thrown");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(KeelError);
      const error = thrown as KeelError;
      expect(error.code).toBe("UNWRAP_NON_ERROR");
      expect(error.details).toEqual({ error: "plain string" });
    }
  });
});

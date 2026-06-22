import { describe, expect, it } from "vitest";

import { EnvError } from "../src/errors";
import { envField } from "../src/fields";

describe("envField.string", () => {
  it("accepts a present value verbatim", () => {
    expect(envField.string().parse("hello")).toEqual({ ok: true, value: "hello" });
  });

  it("rejects a missing required value", () => {
    expect(envField.string().parse(undefined)).toEqual({
      ok: false,
      error: "is required but not set",
    });
  });

  it('treats an empty string as missing (the repo\'s `""`-is-unset convention)', () => {
    expect(envField.string().parse("").ok).toBe(false);
  });
});

describe("envField.number", () => {
  it("parses an integer and a float", () => {
    expect(envField.number().parse("3000")).toEqual({ ok: true, value: 3000 });
    expect(envField.number().parse("3.14")).toEqual({ ok: true, value: 3.14 });
  });

  it("rejects a non-number", () => {
    expect(envField.number().parse("abc")).toEqual({ ok: false, error: "must be a number" });
  });
});

describe("envField.port", () => {
  it("accepts a port in range", () => {
    expect(envField.port().parse("8080")).toEqual({ ok: true, value: 8080 });
  });

  it("rejects a non-integer, a zero, an over-range, and a non-number", () => {
    expect(envField.port().parse("1.5").ok).toBe(false);
    expect(envField.port().parse("0").ok).toBe(false);
    expect(envField.port().parse("70000").ok).toBe(false);
    expect(envField.port().parse("abc").ok).toBe(false);
  });
});

describe("envField.boolean", () => {
  it("reads the true words, case-insensitive and trimmed", () => {
    for (const raw of ["true", "1", "yes", "on", " TRUE ", "On"]) {
      expect(envField.boolean().parse(raw)).toEqual({ ok: true, value: true });
    }
  });

  it("reads the false words", () => {
    for (const raw of ["false", "0", "no", "off", "FALSE"]) {
      expect(envField.boolean().parse(raw)).toEqual({ ok: true, value: false });
    }
  });

  it('rejects a non-boolean word — no `Boolean("false") === true` footgun', () => {
    expect(envField.boolean().parse("maybe").ok).toBe(false);
    // The footgun made concrete: a plain truthiness cast would call "0"/"false" true.
    expect(envField.boolean().parse("0")).toEqual({ ok: true, value: false });
  });
});

describe("envField.oneOf", () => {
  it("accepts a member and rejects a non-member, naming the allowed set", () => {
    const field = envField.oneOf(["development", "production"]);

    expect(field.parse("production")).toEqual({ ok: true, value: "production" });
    expect(field.parse("staging")).toEqual({
      ok: false,
      error: "must be one of: development, production",
    });
  });
});

describe("EnvField.optional / default", () => {
  it("optional yields undefined when unset, the coerced value when set", () => {
    const field = envField.string().optional();

    expect(field.parse(undefined)).toEqual({ ok: true, value: undefined });
    expect(field.parse("x")).toEqual({ ok: true, value: "x" });
  });

  it("default fills in when unset, coerces when set", () => {
    const field = envField.number().default(3000);

    expect(field.parse(undefined)).toEqual({ ok: true, value: 3000 });
    expect(field.parse("8080")).toEqual({ ok: true, value: 8080 });
  });

  it("still coerces a present value — a bad value is rejected even with a default", () => {
    expect(envField.number().default(3000).parse("abc")).toEqual({
      ok: false,
      error: "must be a number",
    });
  });

  it("is immutable — optional()/default() return NEW fields, the base stays required", () => {
    const base = envField.string();

    expect(base.optional()).not.toBe(base);
    expect(base.default("x")).not.toBe(base);
    expect(base.parse(undefined).ok).toBe(false);
  });

  it("rejects an invalid default EAGERLY — a right-typed but out-of-range value throws at build", () => {
    // `70000` is a `number`, so TS allows it as a `port()` default — but it is not a
    // valid port, and a "validated" env must never carry it. Caught when the schema
    // is built, not silently slipped through.
    let thrown: unknown;

    try {
      envField.port().default(70000);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(EnvError);
    expect((thrown as EnvError).code).toBe("ENV_INVALID_DEFAULT");
    expect((thrown as EnvError).message).toContain("70000");
    expect((thrown as EnvError).message).toContain("must be a port");

    // The same for a NaN number default and an over-long... every field's own rule applies.
    expect(() => envField.number().default(Number.NaN)).toThrow(EnvError);
  });

  it("accepts a valid default (the common case) without throwing", () => {
    expect(() => envField.port().default(3000)).not.toThrow();
    expect(() => envField.boolean().default(false)).not.toThrow();
    expect(() => envField.oneOf(["a", "b"]).default("a")).not.toThrow();
  });
});

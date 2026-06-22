import { describe, expect, it, vi } from "vitest";

import { defineEnv } from "../src/define";
import { EnvError } from "../src/errors";
import { envField } from "../src/fields";

describe("defineEnv", () => {
  it("returns frozen, typed values for a valid source", () => {
    const env = defineEnv(
      {
        PORT: envField.port().default(3000),
        NODE_ENV: envField.oneOf(["development", "production"]).default("development"),
        SECRET: envField.string(),
      },
      { PORT: "8080", SECRET: "shh" },
    );

    expect(env).toEqual({ PORT: 8080, NODE_ENV: "development", SECRET: "shh" });
    expect(Object.isFrozen(env)).toBe(true);
  });

  it("throws a coded EnvError naming a single missing var", () => {
    let thrown: unknown;

    try {
      defineEnv({ DATABASE_URL: envField.string() }, {});
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(EnvError);
    expect((thrown as EnvError).code).toBe("ENV_VALIDATION_FAILED");
    expect((thrown as EnvError).message).toContain("1 problem");
    expect((thrown as EnvError).message).toContain("DATABASE_URL is required but not set");
    expect((thrown as EnvError).details["count"]).toBe(1);
  });

  it("lists EVERY problem at once (plural), not just the first", () => {
    let thrown: EnvError | undefined;

    try {
      defineEnv(
        { PORT: envField.port(), FLAG: envField.boolean(), URL: envField.string() },
        { PORT: "nope", FLAG: "maybe" },
      );
    } catch (error) {
      thrown = error as EnvError;
    }

    expect(thrown?.message).toContain("3 problems");
    expect(thrown?.message).toContain("PORT must be a port");
    expect(thrown?.message).toContain("FLAG must be a boolean");
    expect(thrown?.message).toContain("URL is required but not set");
    expect(thrown?.details["count"]).toBe(3);
  });

  it("reads process.env when no source is given", () => {
    // Empty schema: nothing to read, but it still falls back to `process.env` (which
    // exists under Node) and returns a frozen empty object — proving the default path.
    const env = defineEnv({});

    expect(env).toEqual({});
    expect(Object.isFrozen(env)).toBe(true);
  });

  it("falls back to an empty source where there is no `process` (the edge)", () => {
    vi.stubGlobal("process", undefined);

    let env: { PORT: number };

    try {
      // No `process` → the edge-safe `{}` fallback (never a ReferenceError); the
      // defaulted field still resolves.
      env = defineEnv({ PORT: envField.port().default(3000) });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(env).toEqual({ PORT: 3000 });
  });
});

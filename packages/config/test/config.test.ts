import { describe, expect, it } from "vitest";

import { ConfigError, loadConfig } from "../src/index";
import type { Schema } from "../src/index";

describe("loadConfig", () => {
  it("passes a string field through unchanged", () => {
    const schema = { name: { type: "string" } } satisfies Schema;

    const config = loadConfig(schema, { name: "ada" });

    expect(config).toEqual({ name: "ada" });
    expect(typeof config.name).toBe("string");
  });

  it("coerces a number field via Number()", () => {
    const schema = { port: { type: "number" } } satisfies Schema;

    const config = loadConfig(schema, { port: "8080" });

    expect(config).toEqual({ port: 8080 });
    expect(typeof config.port).toBe("number");
  });

  it("coerces boolean 'true' and '1' to true", () => {
    const schema = {
      a: { type: "boolean" },
      b: { type: "boolean" },
    } satisfies Schema;

    const config = loadConfig(schema, { a: "true", b: "1" });

    expect(config).toEqual({ a: true, b: true });
    expect(typeof config.a).toBe("boolean");
  });

  it("coerces boolean 'false' and '0' to false", () => {
    const schema = {
      a: { type: "boolean" },
      b: { type: "boolean" },
    } satisfies Schema;

    const config = loadConfig(schema, { a: "false", b: "0" });

    expect(config).toEqual({ a: false, b: false });
  });

  it("throws CONFIG_MISSING when a required field is absent", () => {
    const schema = { token: { type: "string", required: true } } satisfies Schema;

    try {
      loadConfig(schema, {});

      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);

      const configError = error as ConfigError;

      expect(configError.code).toBe("CONFIG_MISSING");
      expect(configError.details).toEqual({ name: "token", sourceKey: "token" });
    }
  });

  it("uses the default for an optional field that is absent", () => {
    const schema = { port: { type: "number", default: 3000 } } satisfies Schema;

    const config = loadConfig(schema, {});

    expect(config).toEqual({ port: 3000 });
  });

  it("omits an optional field that is absent and has no default", () => {
    const schema = { note: { type: "string" } } satisfies Schema;

    const config = loadConfig(schema, {});

    expect(config).toEqual({});
    expect("note" in config).toBe(false);
  });

  it("throws CONFIG_INVALID for a value that is not a number", () => {
    const schema = { port: { type: "number" } } satisfies Schema;

    try {
      loadConfig(schema, { port: "not-a-number" });

      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);

      const configError = error as ConfigError;

      expect(configError.code).toBe("CONFIG_INVALID");
      expect(configError.details).toEqual({
        name: "port",
        type: "number",
        value: "not-a-number",
      });
    }
  });

  it("throws CONFIG_INVALID for a value that is not a boolean", () => {
    const schema = { debug: { type: "boolean" } } satisfies Schema;

    try {
      loadConfig(schema, { debug: "maybe" });

      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).code).toBe("CONFIG_INVALID");
    }
  });

  it("reads from a remapped source key via field.env", () => {
    const schema = {
      databaseUrl: { type: "string", required: true, env: "DATABASE_URL" },
    } satisfies Schema;

    const config = loadConfig(schema, { DATABASE_URL: "postgres://localhost/app" });

    expect(config).toEqual({ databaseUrl: "postgres://localhost/app" });
  });
});

import { describe, it, expect } from "vitest";
import {
  DocksError,
  ValidationError,
  ParseError,
  NetworkError,
  SecurityError,
  ConfigError,
  ok,
  err,
  isOk,
  isErr,
  unwrap,
  unwrapOr,
} from "../errors.js";

describe("DocksError", () => {
  it("creates error with message, code, and context", () => {
    const error = new DocksError("Test error", "TEST_ERROR", { foo: "bar" });

    expect(error.message).toBe("Test error");
    expect(error.code).toBe("TEST_ERROR");
    expect(error.context).toEqual({ foo: "bar" });
    expect(error.name).toBe("DocksError");
    expect(error.timestamp).toBeInstanceOf(Date);
  });

  it("defaults context to empty object", () => {
    const error = new DocksError("Test error", "TEST_ERROR");
    expect(error.context).toEqual({});
  });

  it("serializes to JSON", () => {
    const error = new DocksError("Test error", "TEST_ERROR", { foo: "bar" });
    const json = error.toJSON();

    expect(json.name).toBe("DocksError");
    expect(json.code).toBe("TEST_ERROR");
    expect(json.message).toBe("Test error");
    expect(json.context).toEqual({ foo: "bar" });
    expect(typeof json.timestamp).toBe("string");
    expect(json.stack).toBeDefined();
  });

  it("is instanceof Error", () => {
    const error = new DocksError("Test", "TEST");
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(DocksError);
  });
});

describe("ValidationError", () => {
  it("creates with correct code and name", () => {
    const error = new ValidationError("Invalid input");

    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.name).toBe("ValidationError");
    expect(error.message).toBe("Invalid input");
  });

  it("accepts context", () => {
    const error = new ValidationError("Invalid input", { field: "email" });
    expect(error.context).toEqual({ field: "email" });
  });

  it("is instanceof DocksError", () => {
    const error = new ValidationError("Test");
    expect(error).toBeInstanceOf(DocksError);
  });
});

describe("ParseError", () => {
  it("creates with correct code and name", () => {
    const error = new ParseError("Syntax error");

    expect(error.code).toBe("PARSE_ERROR");
    expect(error.name).toBe("ParseError");
  });

  it("captures line and column", () => {
    const error = new ParseError("Syntax error", { line: 10, column: 5 });

    expect(error.line).toBe(10);
    expect(error.column).toBe(5);
    expect(error.context).toEqual({ line: 10, column: 5 });
  });

  it("handles missing line and column", () => {
    const error = new ParseError("Syntax error");

    expect(error.line).toBeUndefined();
    expect(error.column).toBeUndefined();
  });
});

describe("NetworkError", () => {
  it("creates with correct code and name", () => {
    const error = new NetworkError("Connection failed");

    expect(error.code).toBe("NETWORK_ERROR");
    expect(error.name).toBe("NetworkError");
  });

  it("captures statusCode and url", () => {
    const error = new NetworkError("Not found", {
      statusCode: 404,
      url: "https://example.com/api",
    });

    expect(error.statusCode).toBe(404);
    expect(error.url).toBe("https://example.com/api");
  });

  it("handles missing statusCode and url", () => {
    const error = new NetworkError("Connection failed");

    expect(error.statusCode).toBeUndefined();
    expect(error.url).toBeUndefined();
  });
});

describe("SecurityError", () => {
  it("creates with correct code and name", () => {
    const error = new SecurityError("XSS detected");

    expect(error.code).toBe("SECURITY_ERROR");
    expect(error.name).toBe("SecurityError");
    expect(error.message).toBe("XSS detected");
  });

  it("accepts context", () => {
    const error = new SecurityError("Path traversal", { path: "../etc/passwd" });
    expect(error.context).toEqual({ path: "../etc/passwd" });
  });
});

describe("ConfigError", () => {
  it("creates with correct code and name", () => {
    const error = new ConfigError("Invalid config");

    expect(error.code).toBe("CONFIG_ERROR");
    expect(error.name).toBe("ConfigError");
  });

  it("accepts context", () => {
    const error = new ConfigError("Missing field", { field: "apiKey" });
    expect(error.context).toEqual({ field: "apiKey" });
  });
});

describe("Result type utilities", () => {
  describe("ok", () => {
    it("creates success result", () => {
      const result = ok("data");

      expect(result.success).toBe(true);
      expect(result).toEqual({ success: true, data: "data" });
    });

    it("works with complex types", () => {
      const result = ok({ foo: "bar", count: 42 });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.foo).toBe("bar");
        expect(result.data.count).toBe(42);
      }
    });
  });

  describe("err", () => {
    it("creates error result", () => {
      const error = new ValidationError("Invalid");
      const result = err(error);

      expect(result.success).toBe(false);
      expect(result).toEqual({ success: false, error });
    });
  });

  describe("isOk", () => {
    it("returns true for success results", () => {
      const result = ok("data");
      expect(isOk(result)).toBe(true);
    });

    it("returns false for error results", () => {
      const result = err(new Error("fail"));
      expect(isOk(result)).toBe(false);
    });

    it("narrows type correctly", () => {
      const result = ok("data") as ReturnType<typeof ok<string>>;

      if (isOk(result)) {
        // TypeScript should know result.data is string here
        expect(result.data.toUpperCase()).toBe("DATA");
      }
    });
  });

  describe("isErr", () => {
    it("returns true for error results", () => {
      const result = err(new Error("fail"));
      expect(isErr(result)).toBe(true);
    });

    it("returns false for success results", () => {
      const result = ok("data");
      expect(isErr(result)).toBe(false);
    });
  });

  describe("unwrap", () => {
    it("returns data from success result", () => {
      const result = ok("data");
      expect(unwrap(result)).toBe("data");
    });

    it("throws on error result", () => {
      const error = new ValidationError("Invalid");
      const result = err(error);

      expect(() => unwrap(result)).toThrow(ValidationError);
      expect(() => unwrap(result)).toThrow("Invalid");
    });
  });

  describe("unwrapOr", () => {
    it("returns data from success result", () => {
      const result = ok("data");
      expect(unwrapOr(result, "default")).toBe("data");
    });

    it("returns default value from error result", () => {
      const result = err(new Error("fail"));
      expect(unwrapOr(result, "default")).toBe("default");
    });
  });
});

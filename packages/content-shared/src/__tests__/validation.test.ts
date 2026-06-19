import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  validateUrl,
  paginationSchema,
  validatePagination,
  slugSchema,
  validateSlug,
  packageNameSchema,
  entrySchema,
  createValidator,
  validateRange,
  validateNotEmpty,
} from "../validation.js";
import { ValidationError } from "../errors.js";

describe("validateUrl", () => {
  it("validates and returns URL object for valid URLs", () => {
    const result = validateUrl("https://example.com/path?query=1");

    expect(result).toBeInstanceOf(URL);
    expect(result.hostname).toBe("example.com");
    expect(result.pathname).toBe("/path");
    expect(result.search).toBe("?query=1");
  });

  it("validates URLs with different protocols", () => {
    expect(validateUrl("http://example.com")).toBeInstanceOf(URL);
    expect(validateUrl("ftp://files.example.com")).toBeInstanceOf(URL);
    expect(validateUrl("file:///path/to/file")).toBeInstanceOf(URL);
  });

  it("throws ValidationError for invalid URLs", () => {
    expect(() => validateUrl("not-a-url")).toThrow(ValidationError);
    expect(() => validateUrl("")).toThrow(ValidationError);
    expect(() => validateUrl("://missing-protocol.com")).toThrow(ValidationError);
  });

  it("includes context in error message", () => {
    expect(() => validateUrl("invalid", "base URL")).toThrow("Invalid base URL: invalid");
  });

  it("uses default context when not provided", () => {
    expect(() => validateUrl("invalid")).toThrow("Invalid URL: invalid");
  });

  it("throws ValidationError with correct properties", () => {
    try {
      validateUrl("invalid", "API endpoint");
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      const error = e as ValidationError;
      expect(error.context).toEqual({ url: "invalid", context: "API endpoint" });
    }
  });
});

describe("paginationSchema", () => {
  it("provides default values", () => {
    const result = paginationSchema.parse({});

    expect(result.limit).toBe(10);
    expect(result.offset).toBe(0);
  });

  it("accepts valid pagination parameters", () => {
    const result = paginationSchema.parse({
      limit: 50,
      offset: 100,
      page: 2,
      perPage: 25,
    });

    expect(result.limit).toBe(50);
    expect(result.offset).toBe(100);
    expect(result.page).toBe(2);
    expect(result.perPage).toBe(25);
  });

  it("enforces limit constraints", () => {
    expect(() => paginationSchema.parse({ limit: -1 })).toThrow();
    expect(() => paginationSchema.parse({ limit: 1001 })).toThrow();
    expect(paginationSchema.parse({ limit: 0 }).limit).toBe(0);
    expect(paginationSchema.parse({ limit: 1000 }).limit).toBe(1000);
  });

  it("enforces offset constraints", () => {
    expect(() => paginationSchema.parse({ offset: -1 })).toThrow();
    expect(paginationSchema.parse({ offset: 0 }).offset).toBe(0);
    expect(paginationSchema.parse({ offset: 1000000 }).offset).toBe(1000000);
  });

  it("enforces page constraints", () => {
    expect(() => paginationSchema.parse({ page: 0 })).toThrow();
    expect(() => paginationSchema.parse({ page: -1 })).toThrow();
    expect(paginationSchema.parse({ page: 1 }).page).toBe(1);
  });

  it("enforces perPage constraints", () => {
    expect(() => paginationSchema.parse({ perPage: 0 })).toThrow();
    expect(() => paginationSchema.parse({ perPage: 101 })).toThrow();
    expect(paginationSchema.parse({ perPage: 1 }).perPage).toBe(1);
    expect(paginationSchema.parse({ perPage: 100 }).perPage).toBe(100);
  });

  it("requires integers", () => {
    expect(() => paginationSchema.parse({ limit: 10.5 })).toThrow();
    expect(() => paginationSchema.parse({ offset: 5.5 })).toThrow();
    expect(() => paginationSchema.parse({ page: 1.5 })).toThrow();
  });
});

describe("validatePagination", () => {
  it("returns validated pagination params", () => {
    const result = validatePagination({ limit: 20, offset: 10 });

    expect(result.limit).toBe(20);
    expect(result.offset).toBe(10);
  });

  it("applies defaults for missing values", () => {
    const result = validatePagination({});

    expect(result.limit).toBe(10);
    expect(result.offset).toBe(0);
  });

  it("throws ValidationError for invalid params", () => {
    expect(() => validatePagination({ limit: -5 })).toThrow(ValidationError);
    expect(() => validatePagination({ limit: "ten" })).toThrow(ValidationError);
  });

  it("includes error details in ValidationError", () => {
    try {
      validatePagination({ limit: -5, offset: -10 });
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      const error = e as ValidationError;
      expect(error.message).toBe("Invalid pagination parameters");
      expect(error.context.errors).toBeDefined();
    }
  });
});

describe("slugSchema", () => {
  it("accepts valid slugs", () => {
    expect(slugSchema.parse("hello")).toBe("hello");
    expect(slugSchema.parse("hello-world")).toBe("hello-world");
    expect(slugSchema.parse("my-post-123")).toBe("my-post-123");
    expect(slugSchema.parse("a")).toBe("a");
  });

  it("rejects invalid slug formats", () => {
    expect(() => slugSchema.parse("")).toThrow();
    expect(() => slugSchema.parse("Hello")).toThrow(); // uppercase
    expect(() => slugSchema.parse("hello_world")).toThrow(); // underscore
    expect(() => slugSchema.parse("hello--world")).toThrow(); // double dash
    expect(() => slugSchema.parse("-hello")).toThrow(); // leading dash
    expect(() => slugSchema.parse("hello-")).toThrow(); // trailing dash
    expect(() => slugSchema.parse("hello world")).toThrow(); // space
  });

  it("enforces length constraints", () => {
    const longSlug = "a".repeat(201);
    expect(() => slugSchema.parse(longSlug)).toThrow();

    const maxSlug = "a".repeat(200);
    expect(slugSchema.parse(maxSlug)).toBe(maxSlug);
  });
});

describe("validateSlug", () => {
  it("returns validated slug", () => {
    expect(validateSlug("hello-world")).toBe("hello-world");
  });

  it("throws ValidationError for invalid slugs", () => {
    expect(() => validateSlug("UPPERCASE")).toThrow(ValidationError);
    expect(() => validateSlug("has spaces")).toThrow(ValidationError);
  });

  it("includes slug in error context", () => {
    try {
      validateSlug("INVALID");
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      const error = e as ValidationError;
      expect(error.message).toBe("Invalid slug: INVALID");
      expect(error.context.slug).toBe("INVALID");
      expect(error.context.errors).toBeDefined();
    }
  });
});

describe("packageNameSchema", () => {
  it("accepts valid package names", () => {
    expect(packageNameSchema.parse("my-package")).toBe("my-package");
    expect(packageNameSchema.parse("package123")).toBe("package123");
    expect(packageNameSchema.parse("@scope/package")).toBe("@scope/package");
    expect(packageNameSchema.parse("@my-scope/my-package")).toBe("@my-scope/my-package");
  });

  it("rejects names starting with . or _", () => {
    expect(() => packageNameSchema.parse(".hidden")).toThrow();
    expect(() => packageNameSchema.parse("_private")).toThrow();
  });

  it("rejects invalid characters", () => {
    expect(() => packageNameSchema.parse("UPPERCASE")).toThrow();
    expect(() => packageNameSchema.parse("has spaces")).toThrow();
    expect(() => packageNameSchema.parse("special!chars")).toThrow();
  });

  it("enforces length constraints", () => {
    expect(() => packageNameSchema.parse("")).toThrow();

    const longName = "a".repeat(215);
    expect(() => packageNameSchema.parse(longName)).toThrow();
  });

  it("validates scoped packages correctly", () => {
    expect(() => packageNameSchema.parse("@/package")).toThrow(); // empty scope
    expect(() => packageNameSchema.parse("@scope/")).toThrow(); // empty package
    expect(packageNameSchema.parse("@a/b")).toBe("@a/b"); // minimal valid
  });
});

describe("entrySchema", () => {
  it("accepts valid entries", () => {
    const result = entrySchema.parse({
      id: "entry-1",
      collection: "posts",
    });

    expect(result.id).toBe("entry-1");
    expect(result.collection).toBe("posts");
    expect(result.slug).toBeUndefined();
  });

  it("accepts entries with valid slug", () => {
    const result = entrySchema.parse({
      id: "entry-1",
      collection: "posts",
      slug: "my-post",
    });

    expect(result.slug).toBe("my-post");
  });

  it("rejects empty id", () => {
    expect(() =>
      entrySchema.parse({
        id: "",
        collection: "posts",
      }),
    ).toThrow();
  });

  it("rejects empty collection", () => {
    expect(() =>
      entrySchema.parse({
        id: "entry-1",
        collection: "",
      }),
    ).toThrow();
  });

  it("validates slug format when provided", () => {
    expect(() =>
      entrySchema.parse({
        id: "entry-1",
        collection: "posts",
        slug: "INVALID SLUG",
      }),
    ).toThrow();
  });
});

describe("createValidator", () => {
  const numberSchema = z.number().min(0).max(100);
  const validateNumber = createValidator(numberSchema, "score");

  it("returns validated data", () => {
    expect(validateNumber(50)).toBe(50);
    expect(validateNumber(0)).toBe(0);
    expect(validateNumber(100)).toBe(100);
  });

  it("throws ValidationError for invalid data", () => {
    expect(() => validateNumber(-1)).toThrow(ValidationError);
    expect(() => validateNumber(101)).toThrow(ValidationError);
    expect(() => validateNumber("fifty")).toThrow(ValidationError);
  });

  it("includes context in error", () => {
    try {
      validateNumber(-1);
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      const error = e as ValidationError;
      expect(error.message).toBe("Invalid score");
      expect(error.context.context).toBe("score");
      expect(error.context.errors).toBeDefined();
    }
  });

  it("works with object schemas", () => {
    const userSchema = z.object({
      name: z.string().min(1),
      age: z.number().int().positive(),
    });
    const validateUser = createValidator(userSchema, "user");

    const result = validateUser({ name: "Alice", age: 30 });
    expect(result).toEqual({ name: "Alice", age: 30 });

    expect(() => validateUser({ name: "", age: 30 })).toThrow(ValidationError);
    expect(() => validateUser({ name: "Alice", age: -5 })).toThrow(ValidationError);
  });

  it("works with array schemas", () => {
    const tagsSchema = z.array(z.string().min(1)).min(1).max(5);
    const validateTags = createValidator(tagsSchema, "tags");

    expect(validateTags(["a", "b"])).toEqual(["a", "b"]);
    expect(() => validateTags([])).toThrow(ValidationError);
    expect(() => validateTags([""])).toThrow(ValidationError);
  });
});

describe("validateRange", () => {
  it("returns value when within range", () => {
    expect(validateRange(5, 0, 10, "count")).toBe(5);
    expect(validateRange(0, 0, 10, "count")).toBe(0);
    expect(validateRange(10, 0, 10, "count")).toBe(10);
  });

  it("throws ValidationError when below minimum", () => {
    expect(() => validateRange(-1, 0, 10, "count")).toThrow(ValidationError);
    expect(() => validateRange(-1, 0, 10, "count")).toThrow(
      "count must be between 0 and 10, got -1",
    );
  });

  it("throws ValidationError when above maximum", () => {
    expect(() => validateRange(11, 0, 10, "count")).toThrow(ValidationError);
    expect(() => validateRange(11, 0, 10, "count")).toThrow(
      "count must be between 0 and 10, got 11",
    );
  });

  it("throws ValidationError for NaN instead of degrading to an empty slice", () => {
    expect(() => validateRange(Number.NaN, 1, 100, "page")).toThrow(ValidationError);
    expect(() => validateRange(Number.NaN, 1, 100, "page")).toThrow(
      "page must be a finite number, got NaN",
    );
  });

  it("throws ValidationError for a non-finite value (Infinity)", () => {
    expect(() => validateRange(Number.POSITIVE_INFINITY, 1, 100, "perPage")).toThrow(
      "perPage must be a finite number, got Infinity",
    );
  });

  it("includes context in error", () => {
    try {
      validateRange(150, 0, 100, "percentage");
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      const error = e as ValidationError;
      expect(error.context).toEqual({
        value: 150,
        min: 0,
        max: 100,
        name: "percentage",
      });
    }
  });

  it("works with negative ranges", () => {
    expect(validateRange(-5, -10, -1, "temperature")).toBe(-5);
    expect(() => validateRange(0, -10, -1, "temperature")).toThrow(ValidationError);
  });

  it("works with floating point numbers", () => {
    expect(validateRange(0.5, 0, 1, "ratio")).toBe(0.5);
    expect(() => validateRange(1.5, 0, 1, "ratio")).toThrow(ValidationError);
  });
});

describe("validateNotEmpty", () => {
  it("returns value when not empty", () => {
    expect(validateNotEmpty("hello", "name")).toBe("hello");
    expect(validateNotEmpty("  hello  ", "name")).toBe("  hello  ");
    expect(validateNotEmpty("a", "name")).toBe("a");
  });

  it("throws ValidationError for empty string", () => {
    expect(() => validateNotEmpty("", "name")).toThrow(ValidationError);
    expect(() => validateNotEmpty("", "name")).toThrow("name cannot be empty");
  });

  it("throws ValidationError for whitespace-only string", () => {
    expect(() => validateNotEmpty("   ", "title")).toThrow(ValidationError);
    expect(() => validateNotEmpty("\t\n", "title")).toThrow(ValidationError);
  });

  it("includes name in error context", () => {
    try {
      validateNotEmpty("", "description");
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      const error = e as ValidationError;
      expect(error.context).toEqual({ name: "description" });
    }
  });

  it("preserves leading/trailing whitespace in return value", () => {
    const value = "  content  ";
    expect(validateNotEmpty(value, "text")).toBe(value);
  });
});

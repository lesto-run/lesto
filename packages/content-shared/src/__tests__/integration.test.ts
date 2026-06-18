/**
 * Integration tests for @lesto/content-shared
 *
 * These tests verify that modules work correctly together in real-world scenarios,
 * testing cross-module interactions and end-to-end workflows.
 */

import { describe, it, expect } from "vitest";

// Import from multiple modules to test integration
import { sanitizeHtml, serializeJsonLd, sanitizeObject, sanitizePath } from "../sanitize.js";
import {
  DocksError,
  ValidationError,
  SecurityError,
  ok,
  err,
  isOk,
  isErr,
  unwrap,
  unwrapOr,
} from "../errors.js";
import { createCache, createImmutableCache, deepClone, CACHE_LIMITS, CACHE_TTL } from "../cache.js";
import {
  validateUrl,
  validatePagination,
  validateSlug,
  validateRange,
  validateNotEmpty,
} from "../validation.js";
import { AsyncMutex, ReadWriteLock, createSingletonLoader } from "../mutex.js";
import { escapeXml, decodeXml, formatXmlDate, wrapCdata } from "../xml.js";
import { slugify, createSlugger, slugifyOnce } from "../slugify.js";
import { encodeBase64, decodeBase64, encodeFloat32Array, decodeFloat32Array } from "../encoding.js";
import { DANGEROUS_HTML_SAMPLES } from "./fixtures.js";

const safeValidateSlug = (slug: string) => {
  try {
    return ok(validateSlug(slug));
  } catch (e) {
    return err(e as ValidationError);
  }
};

const validateDocument = (doc: { title: string; slug: string; url: string; page: number }) => {
  const errors: ValidationError[] = [];

  try {
    validateNotEmpty(doc.title, "title");
  } catch (e) {
    errors.push(e as ValidationError);
  }

  try {
    validateSlug(doc.slug);
  } catch (e) {
    errors.push(e as ValidationError);
  }

  try {
    validateUrl(doc.url);
  } catch (e) {
    errors.push(e as ValidationError);
  }

  try {
    validateRange(doc.page, 1, 100, "page");
  } catch (e) {
    errors.push(e as ValidationError);
  }

  return errors;
};

const validatePaginatedRequest = (params: unknown) => {
  // First validate structure with zod
  const pagination = validatePagination(params);

  // Then apply custom business logic
  if (pagination.limit === 0 && pagination.offset > 0) {
    throw new ValidationError("Cannot have offset without limit", {
      limit: pagination.limit,
      offset: pagination.offset,
    });
  }

  return pagination;
};

describe("Integration: Error Handling with Validation", () => {
  it("validation errors include proper error hierarchy", () => {
    try {
      validateUrl("not-a-url");
      expect.fail("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      expect(e).toBeInstanceOf(DocksError);
      expect((e as ValidationError).code).toBe("VALIDATION_ERROR");
      expect((e as ValidationError).context.url).toBe("not-a-url");
    }
  });

  it("security errors from sanitization work with error utilities", () => {
    const result = (() => {
      try {
        sanitizePath("../../../etc/passwd", "/app");
        return ok("success");
      } catch (e) {
        return err(e as SecurityError);
      }
    })();

    expect(isErr(result)).toBe(true);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(SecurityError);
      expect(result.error.code).toBe("SECURITY_ERROR");
    }
  });

  it("Result type works with validation functions", () => {
    const goodResult = safeValidateSlug("hello-world");
    expect(isOk(goodResult)).toBe(true);
    expect(unwrap(goodResult)).toBe("hello-world");

    const badResult = safeValidateSlug("Invalid Slug!");
    expect(isErr(badResult)).toBe(true);
    expect(unwrapOr(badResult, "fallback")).toBe("fallback");
  });
});

describe("Integration: Cache with Sanitization", () => {
  it("caches sanitized HTML results", () => {
    const cache = createCache<string>({ max: 100 });

    const rawHtml = "<div><script>evil()</script>Safe content</div>";
    const cacheKey = `html:${rawHtml}`;

    // First call - sanitize and cache
    if (!cache.has(cacheKey)) {
      const sanitized = sanitizeHtml(rawHtml);
      cache.set(cacheKey, sanitized);
    }

    // Second call - get from cache
    const cachedResult = cache.get(cacheKey);
    expect(cachedResult).toBe("<div>Safe content</div>");
    expect(cachedResult).not.toContain("<script>");
  });

  it("immutable cache prevents mutation of cached sanitized objects", () => {
    const cache = createImmutableCache<Record<string, unknown>>({ max: 50 }, deepClone);

    const originalObj = { title: "Test", __proto__: { bad: true } };
    const sanitized = sanitizeObject(originalObj);

    cache.set("key1", sanitized);

    // Get and mutate
    const retrieved = cache.get("key1")!;
    retrieved.title = "Modified";

    // Original cache entry should be unchanged
    const retrievedAgain = cache.get("key1")!;
    expect(retrievedAgain.title).toBe("Test");
  });

  it("cache respects limits with sanitized JSON-LD", () => {
    const cache = createCache<string>({ max: 3 });

    for (let i = 0; i < 5; i++) {
      const jsonLd = { "@context": "https://schema.org", id: i };
      cache.set(`key${i}`, serializeJsonLd(jsonLd));
    }

    // Only last 3 should remain
    expect(cache.size).toBe(3);
    expect(cache.has("key0")).toBe(false);
    expect(cache.has("key1")).toBe(false);
    expect(cache.has("key4")).toBe(true);
  });
});

describe("Integration: Mutex with Cache", () => {
  it("mutex protects cache updates from race conditions", async () => {
    const mutex = new AsyncMutex();
    const cache = createCache<number>({ max: 100 });
    let updateCount = 0;

    const updateCache = async (key: string, value: number) => {
      await mutex.runExclusive(async () => {
        // Simulate async operation
        await new Promise((resolve) => setTimeout(resolve, 10));
        cache.set(key, value);
        updateCount++;
      });
    };

    // Run multiple updates concurrently
    await Promise.all([
      updateCache("counter", 1),
      updateCache("counter", 2),
      updateCache("counter", 3),
    ]);

    // All updates should have completed sequentially
    expect(updateCount).toBe(3);
    expect(cache.get("counter")).toBeDefined();
  });

  it("singleton loader prevents duplicate sanitization work", async () => {
    let sanitizeCallCount = 0;
    const expensiveSanitize = async (html: string) => {
      sanitizeCallCount++;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return sanitizeHtml(html);
    };

    const dangerousHtml = "<div><script>alert(1)</script>Content</div>";
    const getSanitized = createSingletonLoader(() => expensiveSanitize(dangerousHtml));

    // Call multiple times concurrently
    const results = await Promise.all([getSanitized(), getSanitized(), getSanitized()]);

    // Should only sanitize once
    expect(sanitizeCallCount).toBe(1);

    // All results should be the same
    results.forEach((result) => {
      expect(result).toBe("<div>Content</div>");
    });
  });

  it("read-write lock allows concurrent reads of cached data", async () => {
    const rwLock = new ReadWriteLock();
    const cache = createCache<string>({ max: 100 });
    cache.set("data", sanitizeHtml("<p>Safe content</p>"));

    let concurrentReads = 0;
    let maxConcurrentReads = 0;

    const readCache = async () => {
      const release = await rwLock.acquireRead();
      concurrentReads++;
      maxConcurrentReads = Math.max(maxConcurrentReads, concurrentReads);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const result = cache.get("data");
      concurrentReads--;
      release();
      return result;
    };

    // Multiple concurrent reads should all succeed
    const results = await Promise.all([readCache(), readCache(), readCache()]);

    expect(maxConcurrentReads).toBe(3);
    results.forEach((result) => {
      expect(result).toBe("<p>Safe content</p>");
    });
  });
});

describe("Integration: Validation with Slugify", () => {
  it("validated slugs match slugify output", () => {
    const text = "Hello World! This is a Test";
    const slug = slugifyOnce(text);

    // The generated slug should pass validation
    expect(() => validateSlug(slug)).not.toThrow();
  });

  it("slugger creates valid slugs for headings", () => {
    const slugger = createSlugger();
    const headings = [
      "Introduction",
      "Getting Started",
      "Getting Started", // Duplicate
      "API Reference",
    ];

    const slugs = headings.map((h) => slugify(h, slugger));

    // All slugs should be valid
    slugs.forEach((slug) => {
      expect(() => validateSlug(slug)).not.toThrow();
    });

    // Duplicates should be handled
    expect(slugs[1]).toBe("getting-started");
    expect(slugs[2]).toBe("getting-started-1");
  });
});

describe("Integration: XML and Sanitization", () => {
  it("XML escaping works with JSON-LD content", () => {
    const content = {
      "@type": "Article",
      headline: "Breaking: News & Updates <Today>",
    };

    const jsonLd = serializeJsonLd(content);

    // JSON-LD escaping should handle < and > and &
    expect(jsonLd).not.toMatch(/<(?!\\u)/);
    expect(jsonLd).not.toMatch(/>(?!\\u)/);
    expect(jsonLd).toContain("\\u003c");
    expect(jsonLd).toContain("\\u003e");
    expect(jsonLd).toContain("\\u0026");
  });

  it("CDATA wrapping works for content that would need escaping", () => {
    const content = "Code example: if (a < b && c > d) { return true; }";
    const cdata = wrapCdata(content);

    expect(cdata).toContain("<![CDATA[");
    expect(cdata).toContain("]]>");
    expect(cdata).toContain(content);
  });

  it("XML dates are valid ISO format for sanitized content", () => {
    const date = new Date("2024-01-15T10:30:00Z");
    const xmlDate = formatXmlDate(date);

    // Should be valid ISO date
    expect(xmlDate).toBe("2024-01-15T10:30:00.000Z");
    expect(() => new Date(xmlDate)).not.toThrow();
  });

  it("round-trip XML encoding/decoding preserves content", () => {
    const original = 'Text with <special> & "characters"';
    const escaped = escapeXml(original);
    const decoded = decodeXml(escaped);

    expect(decoded).toBe(original);
  });
});

describe("Integration: Encoding with Cache", () => {
  it("caches encoded Float32Arrays efficiently", () => {
    const cache = createCache<string>({ max: 100 });

    const vectors = [
      new Float32Array([1.0, 2.0, 3.0]),
      new Float32Array([4.0, 5.0, 6.0]),
      new Float32Array([7.0, 8.0, 9.0]),
    ];

    // Cache encoded vectors
    vectors.forEach((vec, i) => {
      cache.set(`vector:${i}`, encodeFloat32Array(vec));
    });

    // Retrieve and decode
    const retrieved = cache.get("vector:1");
    expect(retrieved).toBeDefined();

    const decoded = decodeFloat32Array(retrieved!);
    expect(decoded[0]).toBeCloseTo(4.0);
    expect(decoded[1]).toBeCloseTo(5.0);
    expect(decoded[2]).toBeCloseTo(6.0);
  });

  it("base64 encoding round-trips through cache correctly", () => {
    const cache = createCache<string>({ max: 50 });
    const original = new Uint8Array([0, 127, 255, 128, 64, 32, 16, 8, 4, 2, 1]);

    const encoded = encodeBase64(original);
    cache.set("binary-data", encoded);

    const fromCache = cache.get("binary-data")!;
    const decoded = decodeBase64(fromCache);

    expect(decoded).toEqual(original);
  });
});

describe("Integration: Full Security Pipeline", () => {
  it("processes untrusted HTML through full security pipeline", () => {
    const untrustedHtml = `
      <div onclick="steal()">
        <script>document.cookie</script>
        <p>User content: <strong>Hello</strong></p>
        <iframe src="evil.com"></iframe>
        <a href="javascript:alert(1)">Click me</a>
      </div>
    `;

    // Step 1: Sanitize HTML
    const sanitized = sanitizeHtml(untrustedHtml);

    // Verify dangerous elements removed
    expect(sanitized).not.toContain("<script>");
    expect(sanitized).not.toContain("onclick");
    expect(sanitized).not.toContain("<iframe");
    expect(sanitized).not.toContain("javascript:");

    // Safe content preserved
    expect(sanitized).toContain("<p>");
    expect(sanitized).toContain("<strong>Hello</strong>");
  });

  it("processes untrusted JSON through security pipeline", () => {
    const untrustedJson = {
      "@context": "https://schema.org",
      "@type": "Article",
      headline: "</script><script>evil()</script>",
      author: {
        __proto__: { admin: true },
        name: "User & Friends <team>",
      },
    };

    // Step 1: Sanitize object (remove prototype pollution)
    const sanitizedObj = sanitizeObject(untrustedJson);

    // Step 2: Serialize for JSON-LD embedding
    const serialized = serializeJsonLd(sanitizedObj);

    // Verify prototype pollution removed
    expect(sanitizedObj.author).not.toHaveProperty("__proto__");

    // Verify XSS vectors escaped
    expect(serialized).not.toContain("</script>");
    expect(serialized).toContain("\\u003c/script\\u003e");
    expect(serialized).toContain("\\u0026");
    expect(serialized).toContain("\\u003cteam\\u003e");
  });

  it("validates and sanitizes file paths securely", () => {
    const userInputs = [
      { path: "content/posts/my-post.md", expected: true },
      { path: "../../../etc/passwd", expected: false },
      { path: "content/../../../secret.txt", expected: false },
      { path: "./content/valid.md", expected: true },
    ];

    const rootDir = "/app/project";

    userInputs.forEach(({ path, expected }) => {
      const result = (() => {
        try {
          sanitizePath(path, rootDir);
          return ok(true);
        } catch {
          return err(false);
        }
      })();

      expect(isOk(result)).toBe(expected);
    });
  });
});

describe("Integration: Concurrent Validation and Caching", () => {
  it("handles concurrent validation requests with caching", async () => {
    const mutex = new AsyncMutex();
    const cache = createCache<{ valid: boolean; normalized: string }>({ max: 100 });

    const validateAndCache = async (url: string) => {
      const cacheKey = `url:${url}`;

      return mutex.runExclusive(async () => {
        const cached = cache.get(cacheKey);
        if (cached) return cached;

        try {
          const parsed = validateUrl(url);
          const result = { valid: true, normalized: parsed.href };
          cache.set(cacheKey, result);
          return result;
        } catch {
          const result = { valid: false, normalized: "" };
          cache.set(cacheKey, result);
          return result;
        }
      });
    };

    const urls = [
      "https://example.com",
      "not-a-url",
      "https://example.com", // Duplicate - should hit cache
      "https://test.com/path?query=1",
    ];

    const results = await Promise.all(urls.map(validateAndCache));

    const [result0, result1, result2, result3] = results;
    expect(result0).toBeDefined();
    expect(result1).toBeDefined();
    expect(result2).toBeDefined();
    expect(result3).toBeDefined();
    expect(result0?.valid).toBe(true);
    expect(result0?.normalized).toBe("https://example.com/");
    expect(result1?.valid).toBe(false);
    expect(result2).toEqual(result0); // Same result from cache
    expect(result3?.valid).toBe(true);
  });
});

describe("Integration: Error Context Propagation", () => {
  it("errors propagate context through validation chain", () => {
    const badDoc = {
      title: "",
      slug: "Invalid Slug!",
      url: "not-a-url",
      page: 150,
    };

    const errors = validateDocument(badDoc);

    expect(errors.length).toBe(4);
    errors.forEach((error) => {
      expect(error).toBeInstanceOf(ValidationError);
      expect(error.code).toBe("VALIDATION_ERROR");
      expect(error.timestamp).toBeInstanceOf(Date);
    });

    // Each error has appropriate context
    const [error0, error1, error2, error3] = errors;
    expect(error0?.context.name).toBe("title");
    expect(error1?.context.slug).toBe("Invalid Slug!");
    expect(error2?.context.url).toBe("not-a-url");
    expect(error3?.context.value).toBe(150);
  });
});

describe("Integration: Deep Clone with Complex Types", () => {
  it("deep clones sanitized objects for immutable caching", () => {
    const original = {
      html: sanitizeHtml("<p>Content</p>"),
      metadata: {
        date: new Date("2024-01-15"),
        tags: new Set(["test", "example"]),
        counts: new Map([
          ["views", 100],
          ["likes", 50],
        ]),
      },
      nested: {
        deep: {
          value: [1, 2, 3],
        },
      },
    };

    const cloned = deepClone(original);

    // Values should be equal
    expect(cloned.html).toBe(original.html);
    expect(cloned.metadata.date.getTime()).toBe(original.metadata.date.getTime());
    expect(Array.from(cloned.metadata.tags)).toEqual(Array.from(original.metadata.tags));
    expect(Array.from(cloned.metadata.counts.entries())).toEqual(
      Array.from(original.metadata.counts.entries()),
    );
    expect(cloned.nested.deep.value).toEqual(original.nested.deep.value);

    // But modifications shouldn't affect original
    cloned.nested.deep.value.push(4);
    expect(original.nested.deep.value).toEqual([1, 2, 3]);

    cloned.metadata.tags.add("new");
    expect(original.metadata.tags.has("new")).toBe(false);
  });
});

describe("Integration: Cache Limits and Memory", () => {
  it("respects CACHE_LIMITS constants across modules", () => {
    // Verify standard limits are reasonable
    expect(CACHE_LIMITS.TRANSFORM_CONTEXT).toBe(500);
    expect(CACHE_LIMITS.YAML_PARSE).toBe(1000);
    expect(CACHE_LIMITS.SEARCH_INDEX).toBe(10);
    expect(CACHE_LIMITS.EMBEDDINGS).toBe(100);

    // Create caches with standard limits
    const contextCache = createCache<{ data: number }>({
      max: CACHE_LIMITS.TRANSFORM_CONTEXT,
    });
    const yamlCache = createCache<Record<string, unknown>>({
      max: CACHE_LIMITS.YAML_PARSE,
    });

    // Fill to capacity
    for (let i = 0; i < CACHE_LIMITS.TRANSFORM_CONTEXT + 100; i++) {
      contextCache.set(`key${i}`, { data: i });
    }

    // Should respect limit
    expect(contextCache.size).toBeLessThanOrEqual(CACHE_LIMITS.TRANSFORM_CONTEXT);
    expect(yamlCache.size).toBe(0);
  });

  it("TTL values are appropriate durations", () => {
    expect(CACHE_TTL.SHORT).toBe(5 * 60 * 1000); // 5 minutes
    expect(CACHE_TTL.MEDIUM).toBe(60 * 60 * 1000); // 1 hour
    expect(CACHE_TTL.LONG).toBe(24 * 60 * 60 * 1000); // 1 day
    expect(CACHE_TTL.PERSISTENT).toBe(7 * 24 * 60 * 60 * 1000); // 1 week
  });
});

describe("Integration: Zod Schema with Custom Validators", () => {
  it("custom validators work with zod schemas", () => {
    // Valid case
    expect(() => validatePaginatedRequest({ limit: 10, offset: 0 })).not.toThrow();

    // Zod validation fails
    expect(() => validatePaginatedRequest({ limit: -1, offset: 0 })).toThrow(ValidationError);

    // Custom validation fails
    expect(() => validatePaginatedRequest({ limit: 0, offset: 10 })).toThrow(ValidationError);
  });
});

describe("Integration: All Dangerous HTML Samples", () => {
  it("sanitizes all dangerous HTML samples from fixtures", () => {
    DANGEROUS_HTML_SAMPLES.forEach(({ input }) => {
      const sanitized = sanitizeHtml(input);

      // Should not contain dangerous patterns
      expect(sanitized).not.toContain("<script");
      expect(sanitized).not.toMatch(/on\w+\s*=/i); // No event handlers
      expect(sanitized).not.toContain("<iframe");
      expect(sanitized).not.toContain("<object");
      expect(sanitized).not.toContain("<embed");
      expect(sanitized).not.toContain("<form");
      expect(sanitized).not.toContain("<style");
      expect(sanitized).not.toContain("javascript:");
    });
  });
});

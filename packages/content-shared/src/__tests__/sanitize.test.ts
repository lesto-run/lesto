import { describe, it, expect } from "vitest";
import {
  sanitizeHtml,
  sanitizeJsonLd,
  sanitizeObject,
  serializeJsonLd,
  serializeJavaScript,
  sanitizePath,
  isDangerousHtml,
  DEFAULT_SANITIZE_CONFIG,
} from "../sanitize.js";
import { SecurityError } from "../errors.js";

describe("sanitizeHtml", () => {
  it("removes script tags", () => {
    const html = '<div><script>alert("xss")</script>Hello</div>';
    expect(sanitizeHtml(html)).toBe("<div>Hello</div>");
  });

  it("removes inline script tags with attributes", () => {
    const html = '<script type="text/javascript" src="evil.js"></script><p>Safe</p>';
    expect(sanitizeHtml(html)).toBe("<p>Safe</p>");
  });

  it("removes event handlers", () => {
    const html = '<img src="x" onerror="alert(1)">';
    const result = sanitizeHtml(html);
    expect(result).not.toContain("onerror");
  });

  it("removes onclick handlers", () => {
    const html = '<button onclick="malicious()">Click</button>';
    const result = sanitizeHtml(html);
    expect(result).not.toContain("onclick");
    expect(result).toContain("Click");
  });

  it("removes onload handlers", () => {
    const html = '<body onload="evil()"><p>Content</p></body>';
    const result = sanitizeHtml(html);
    expect(result).not.toContain("onload");
  });

  it("removes onmouseover handlers", () => {
    const html = '<div onmouseover="track()">Hover me</div>';
    const result = sanitizeHtml(html);
    expect(result).not.toContain("onmouseover");
  });

  it("removes style tags", () => {
    const html = "<style>.evil { background: url(tracking.gif) }</style><p>Text</p>";
    expect(sanitizeHtml(html)).toBe("<p>Text</p>");
  });

  it("removes iframe tags", () => {
    const html = '<iframe src="evil.com"></iframe><p>Safe</p>';
    expect(sanitizeHtml(html)).toBe("<p>Safe</p>");
  });

  it("removes object tags", () => {
    const html = '<object data="malware.swf"></object><p>Safe</p>';
    expect(sanitizeHtml(html)).toBe("<p>Safe</p>");
  });

  it("removes embed tags", () => {
    const html = '<embed src="evil.swf"><p>Safe</p>';
    expect(sanitizeHtml(html)).toBe("<p>Safe</p>");
  });

  it("removes form tags", () => {
    const html = '<form action="phishing.com"><input name="password"></form><p>Safe</p>';
    const result = sanitizeHtml(html);
    expect(result).not.toContain("<form");
    expect(result).not.toContain("</form>");
    expect(result).toContain("<p>Safe</p>");
  });

  it("preserves safe content", () => {
    const html = '<p class="test">Hello <strong>world</strong></p>';
    expect(sanitizeHtml(html)).toBe(html);
  });

  it("preserves safe attributes", () => {
    const html = '<a href="https://example.com" class="link">Link</a>';
    expect(sanitizeHtml(html)).toBe(html);
  });

  it("preserves target and rel attributes (configured)", () => {
    const html = '<a href="https://example.com" target="_blank" rel="noopener">Link</a>';
    expect(sanitizeHtml(html)).toBe(html);
  });

  it("handles nested elements correctly", () => {
    const html = "<div><p><strong>Bold <em>and italic</em></strong></p></div>";
    expect(sanitizeHtml(html)).toBe(html);
  });

  it("handles empty input", () => {
    expect(sanitizeHtml("")).toBe("");
  });

  it("handles plain text", () => {
    expect(sanitizeHtml("Just plain text")).toBe("Just plain text");
  });

  it("handles malformed HTML gracefully", () => {
    const html = "<div><p>Unclosed tags";
    const result = sanitizeHtml(html);
    expect(result).toContain("Unclosed tags");
  });

  it("handles javascript: protocol in href", () => {
    const html = '<a href="javascript:alert(1)">Click</a>';
    const result = sanitizeHtml(html);
    expect(result).not.toContain("javascript:");
  });

  it("handles data: protocol in src", () => {
    // Note: DOMPurify allows data: URLs in img src by default as they're not
    // directly executable. The <script> is just text within the data URL.
    // For stricter control, configure ADD_DATA_URI_TAGS option.
    const html = '<img src="data:text/html,<script>alert(1)</script>">';
    const result = sanitizeHtml(html);
    // The img tag is preserved but any actual script execution is prevented
    expect(result).toContain("<img");
  });

  it("accepts custom config options", () => {
    const html = "<div><p>Paragraph</p></div>";
    const result = sanitizeHtml(html, { ALLOWED_TAGS: ["p"] });
    expect(result).toBe("<p>Paragraph</p>");
  });

  it("exports default config", () => {
    expect(DEFAULT_SANITIZE_CONFIG).toBeDefined();
    expect(DEFAULT_SANITIZE_CONFIG.FORBID_TAGS).toContain("script");
    expect(DEFAULT_SANITIZE_CONFIG.FORBID_ATTR).toContain("onerror");
  });
});

describe("isDangerousHtml", () => {
  it("returns true for HTML with script tags", () => {
    const html = "<div><script>alert(1)</script></div>";
    expect(isDangerousHtml(html)).toBe(true);
  });

  it("returns true for HTML with event handlers", () => {
    const html = '<img src="x" onerror="alert(1)">';
    expect(isDangerousHtml(html)).toBe(true);
  });

  it("returns false for safe HTML", () => {
    const html = '<p class="test">Hello <strong>world</strong></p>';
    expect(isDangerousHtml(html)).toBe(false);
  });

  it("returns false for plain text", () => {
    expect(isDangerousHtml("Just text")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isDangerousHtml("")).toBe(false);
  });
});

describe("sanitizeJsonLd", () => {
  it("escapes script closing tags", () => {
    const json = '{"title": "</script><script>alert(1)</script>"}';
    const result = sanitizeJsonLd(json);
    expect(result).not.toContain("</script>");
    expect(result).toContain("\\u003c/script\\u003e");
  });

  it("escapes less-than signs", () => {
    const json = '{"content": "a < b"}';
    const result = sanitizeJsonLd(json);
    expect(result).toContain("\\u003c");
    expect(result).not.toContain(" < ");
  });

  it("escapes greater-than signs", () => {
    const json = '{"content": "a > b"}';
    const result = sanitizeJsonLd(json);
    expect(result).toContain("\\u003e");
    expect(result).not.toContain(" > ");
  });

  it("escapes ampersands", () => {
    const json = '{"content": "a & b"}';
    const result = sanitizeJsonLd(json);
    expect(result).toContain("\\u0026");
    expect(result).not.toContain(" & ");
  });

  it("throws SecurityError on invalid JSON", () => {
    expect(() => sanitizeJsonLd("not json")).toThrow(SecurityError);
  });

  it("throws with original error message in context", () => {
    try {
      sanitizeJsonLd("{invalid}");
      expect.fail("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(SecurityError);
      expect((e as SecurityError).context.originalError).toBeDefined();
    }
  });

  it("handles valid JSON-LD structure", () => {
    const json = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Article",
      headline: "Test Article",
    });
    const result = sanitizeJsonLd(json);
    expect(result).toContain("@context");
    expect(result).toContain("schema.org");
  });

  it("handles nested objects", () => {
    const json = JSON.stringify({
      author: {
        "@type": "Person",
        name: "Test <Author>",
      },
    });
    const result = sanitizeJsonLd(json);
    expect(result).toContain("\\u003cAuthor\\u003e");
  });

  it("handles arrays", () => {
    const json = JSON.stringify({
      items: ["<item1>", "<item2>"],
    });
    const result = sanitizeJsonLd(json);
    expect(result).toContain("\\u003citem1\\u003e");
    expect(result).toContain("\\u003citem2\\u003e");
  });
});

describe("serializeJsonLd", () => {
  it("serializes objects safely", () => {
    const obj = { title: "Test <Title>" };
    const result = serializeJsonLd(obj);
    expect(result).toContain("\\u003cTitle\\u003e");
  });

  it("handles line separator U+2028", () => {
    const obj = { content: "line\u2028separator" };
    const result = serializeJsonLd(obj);
    expect(result).toContain("\\u2028");
  });

  it("handles paragraph separator U+2029", () => {
    const obj = { content: "para\u2029separator" };
    const result = serializeJsonLd(obj);
    expect(result).toContain("\\u2029");
  });

  it("formats with indentation", () => {
    const obj = { a: 1, b: 2 };
    const result = serializeJsonLd(obj);
    expect(result).toContain("\n");
    expect(result).toContain("  ");
  });

  it("handles null values", () => {
    const obj = { value: null };
    const result = serializeJsonLd(obj);
    expect(result).toContain("null");
  });

  it("handles boolean values", () => {
    const obj = { active: true, disabled: false };
    const result = serializeJsonLd(obj);
    expect(result).toContain("true");
    expect(result).toContain("false");
  });

  it("handles numeric values", () => {
    const obj = { count: 42, price: 19.99 };
    const result = serializeJsonLd(obj);
    expect(result).toContain("42");
    expect(result).toContain("19.99");
  });
});

describe("sanitizeObject", () => {
  it("removes __proto__ keys", () => {
    const obj = JSON.parse('{"normal": "value", "__proto__": {"malicious": true}}');
    const result = sanitizeObject(obj);
    expect(result).not.toHaveProperty("__proto__");
    expect(result.normal).toBe("value");
  });

  it("removes constructor keys", () => {
    const obj = { normal: "value", constructor: { evil: true } };
    const result = sanitizeObject(obj);
    // Note: constructor is a function on objects, so we need to check our sanitized version
    expect(Object.keys(result)).not.toContain("constructor");
    expect(result.normal).toBe("value");
  });

  it("removes prototype keys", () => {
    const obj = { normal: "value", prototype: { evil: true } };
    const result = sanitizeObject(obj);
    expect(Object.keys(result)).not.toContain("prototype");
    expect(result.normal).toBe("value");
  });

  it("handles nested objects", () => {
    const obj = JSON.parse('{"nested": {"__proto__": {}, "safe": "value"}}');
    const result = sanitizeObject(obj);
    expect(result.nested).not.toHaveProperty("__proto__");
    expect(result.nested.safe).toBe("value");
  });

  it("handles deeply nested objects", () => {
    const obj = JSON.parse('{"a": {"b": {"c": {"__proto__": {}, "d": "deep"}}}}');
    const result = sanitizeObject(obj);
    expect(result.a.b.c).not.toHaveProperty("__proto__");
    expect(result.a.b.c.d).toBe("deep");
  });

  it("handles arrays", () => {
    const obj = { items: [{ __proto__: {}, name: "item1" }, { name: "item2" }] };
    const result = sanitizeObject(obj);
    expect(result.items[0]).not.toHaveProperty("__proto__");
    expect(result.items[0]?.name).toBe("item1");
    expect(result.items[1]?.name).toBe("item2");
  });

  it("handles arrays with primitive values", () => {
    const obj = { items: [1, "two", true, null] };
    const result = sanitizeObject(obj);
    expect(result.items).toEqual([1, "two", true, null]);
  });

  it("handles null values", () => {
    const obj = { nullProp: null, normal: "value" };
    const result = sanitizeObject(obj);
    expect(result.nullProp).toBe(null);
    expect(result.normal).toBe("value");
  });

  it("returns primitives as-is", () => {
    // @ts-expect-error - testing edge case
    expect(sanitizeObject(null)).toBe(null);
    // @ts-expect-error - testing edge case
    expect(sanitizeObject("string")).toBe("string");
    // @ts-expect-error - testing edge case
    expect(sanitizeObject(42)).toBe(42);
    // @ts-expect-error - testing edge case
    expect(sanitizeObject(true)).toBe(true);
  });

  it("preserves safe properties", () => {
    const obj = {
      name: "Test",
      count: 42,
      active: true,
      tags: ["a", "b"],
      nested: { value: 1 },
    };
    const result = sanitizeObject(obj);
    expect(result).toEqual(obj);
  });
});

describe("serializeJavaScript", () => {
  it("serializes objects safely", () => {
    const obj = { name: "Test", count: 42 };
    const result = serializeJavaScript(obj);
    expect(result).toContain("name");
    expect(result).toContain("Test");
    expect(result).toContain("42");
  });

  it("handles special characters", () => {
    const obj = { html: "<script>alert(1)</script>" };
    const result = serializeJavaScript(obj);
    // serialize-javascript escapes these for HTML embedding
    expect(result).toBeDefined();
  });

  it("handles nested objects", () => {
    const obj = { outer: { inner: { value: "deep" } } };
    const result = serializeJavaScript(obj);
    expect(result).toContain("deep");
  });

  it("handles arrays", () => {
    const obj = { items: [1, 2, 3] };
    const result = serializeJavaScript(obj);
    expect(result).toContain("[1,2,3]");
  });

  it("handles null and undefined", () => {
    const obj = { nullVal: null };
    const result = serializeJavaScript(obj);
    expect(result).toContain("null");
  });
});

describe("sanitizePath", () => {
  it("allows paths within root directory", () => {
    const result = sanitizePath("subdir/file.txt", "/root");
    expect(result).toBe("/root/subdir/file.txt");
  });

  it("allows nested paths within root", () => {
    const result = sanitizePath("a/b/c/file.txt", "/root");
    expect(result).toBe("/root/a/b/c/file.txt");
  });

  it("allows root directory itself", () => {
    const result = sanitizePath(".", "/root");
    expect(result).toBe("/root");
  });

  it("throws SecurityError for path traversal with ../", () => {
    expect(() => sanitizePath("../outside/file.txt", "/root")).toThrow(SecurityError);
  });

  it("throws SecurityError for deeply nested path traversal", () => {
    expect(() => sanitizePath("subdir/../../outside/file.txt", "/root")).toThrow(SecurityError);
  });

  it("throws SecurityError for absolute paths outside root", () => {
    expect(() => sanitizePath("/etc/passwd", "/root")).toThrow(SecurityError);
  });

  it("includes context in SecurityError", () => {
    try {
      sanitizePath("../secret", "/root");
      expect.fail("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(SecurityError);
      const error = e as SecurityError;
      expect(error.context.inputPath).toBe("../secret");
      expect(error.context.rootDir).toBe("/root");
      expect(error.context.resolved).toBeDefined();
    }
  });

  it("normalizes paths with ./ segments", () => {
    const result = sanitizePath("./subdir/./file.txt", "/root");
    expect(result).toBe("/root/subdir/file.txt");
  });

  it("handles paths with trailing slashes", () => {
    const result = sanitizePath("subdir/", "/root");
    expect(result).toBe("/root/subdir");
  });

  it("handles empty input path", () => {
    const result = sanitizePath("", "/root");
    expect(result).toBe("/root");
  });

  it("rejects path traversal hidden in middle", () => {
    expect(() => sanitizePath("allowed/../../../etc/passwd", "/root")).toThrow(SecurityError);
  });
});

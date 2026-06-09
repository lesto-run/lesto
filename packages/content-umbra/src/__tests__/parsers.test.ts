import { describe, it, expect } from "vitest";
import {
  jsonParser,
  yamlParser,
  frontmatterParser,
  frontmatterOnlyParser,
  JsonParseError,
  YamlParseError,
  FrontmatterParseError,
  resolveParser,
  getParserExtensions,
  isValidPreset,
  getDefaultIncludePatterns,
  detectParserByExtension,
  hasFrontmatter,
  stringify,
  extractExcerpt,
  type Parser,
  type ParserPreset,
} from "../index";

const parseFn = (content: string, _filePath: string) => ({
  data: { raw: content },
  content: "",
});

describe("parsers", () => {
  describe("jsonParser", () => {
    it("parses valid JSON object", () => {
      const content = JSON.stringify({ title: "Test", count: 42 });
      const result = jsonParser.parse(content, "test.json");

      expect(result.data).toEqual({ title: "Test", count: 42 });
      expect(result.content).toBe("");
    });

    it("returns empty content string", () => {
      const content = JSON.stringify({ foo: "bar" });
      const result = jsonParser.parse(content, "test.json");

      expect(result.content).toBe("");
    });

    it("throws JsonParseError for invalid JSON", () => {
      const content = "{ invalid json }";

      expect(() => jsonParser.parse(content, "test.json")).toThrow(JsonParseError);
    });

    it("throws error for array root", () => {
      const content = JSON.stringify([1, 2, 3]);

      expect(() => jsonParser.parse(content, "test.json")).toThrow(JsonParseError);
      expect(() => jsonParser.parse(content, "test.json")).toThrow(
        "JSON must be an object at the root level",
      );
    });

    it("throws error for string root", () => {
      const content = JSON.stringify("just a string");

      expect(() => jsonParser.parse(content, "test.json")).toThrow(JsonParseError);
    });

    it("throws error for number root", () => {
      const content = JSON.stringify(42);

      expect(() => jsonParser.parse(content, "test.json")).toThrow(JsonParseError);
    });

    it("throws error for null root", () => {
      const content = JSON.stringify(null);

      expect(() => jsonParser.parse(content, "test.json")).toThrow(JsonParseError);
    });

    it("error includes file path", () => {
      const content = "{ invalid }";

      try {
        jsonParser.parse(content, "/path/to/file.json");
      } catch (error) {
        expect(error).toBeInstanceOf(JsonParseError);
        const jsonError = error as JsonParseError;
        expect(jsonError.filePath).toBe("/path/to/file.json");
        expect(jsonError.message).toContain("/path/to/file.json");
      }
    });

    it("has correct metadata", () => {
      expect(jsonParser.name).toBe("json");
      expect(jsonParser.extensions).toEqual(["json"]);
      expect(jsonParser.hasContent).toBe(false);
    });
  });

  describe("yamlParser", () => {
    it("parses valid YAML object", () => {
      const content = "title: Test\ncount: 42";
      const result = yamlParser.parse(content, "test.yaml");

      expect(result.data).toEqual({ title: "Test", count: 42 });
      expect(result.content).toBe("");
    });

    it("returns empty content string", () => {
      const content = "foo: bar";
      const result = yamlParser.parse(content, "test.yaml");

      expect(result.content).toBe("");
    });

    it("handles multi-line values", () => {
      const content = `title: Test
description: |
  This is a multi-line
  description
count: 42`;
      const result = yamlParser.parse(content, "test.yaml");

      expect(result.data.title).toBe("Test");
      expect(result.data.description).toBe("This is a multi-line\ndescription\n");
      expect(result.data.count).toBe(42);
    });

    it("throws YamlParseError for invalid YAML", () => {
      const content = "invalid:\n  - yaml\n - not indented";

      expect(() => yamlParser.parse(content, "test.yaml")).toThrow(YamlParseError);
    });

    it("throws error for array root", () => {
      const content = "- item1\n- item2";

      expect(() => yamlParser.parse(content, "test.yaml")).toThrow(YamlParseError);
      expect(() => yamlParser.parse(content, "test.yaml")).toThrow(
        "YAML must be an object at the root level",
      );
    });

    it("throws error for string root", () => {
      const content = "just a string";

      expect(() => yamlParser.parse(content, "test.yaml")).toThrow(YamlParseError);
    });

    it("handles null as empty object", () => {
      const content = "null";
      const result = yamlParser.parse(content, "test.yaml");

      expect(result.data).toEqual({});
    });

    it("error includes file path", () => {
      const content = "invalid:\n  - yaml\n - bad";

      try {
        yamlParser.parse(content, "/path/to/file.yaml");
      } catch (error) {
        expect(error).toBeInstanceOf(YamlParseError);
        const yamlError = error as YamlParseError;
        expect(yamlError.filePath).toBe("/path/to/file.yaml");
        expect(yamlError.message).toContain("/path/to/file.yaml");
      }
    });

    it("has correct metadata", () => {
      expect(yamlParser.name).toBe("yaml");
      expect(yamlParser.extensions).toEqual(["yaml", "yml"]);
      expect(yamlParser.hasContent).toBe(false);
    });
  });

  describe("frontmatterParser", () => {
    it("extracts frontmatter data correctly", () => {
      const content = `---
title: Test Post
author: John Doe
---

Content here`;
      const result = frontmatterParser.parse(content, "test.md");

      expect(result.data).toEqual({ title: "Test Post", author: "John Doe" });
    });

    it("extracts markdown content body", () => {
      const content = `---
title: Test
---

# Heading

This is content`;
      const result = frontmatterParser.parse(content, "test.md");

      expect(result.content).toBe("# Heading\n\nThis is content");
    });

    it("handles empty frontmatter", () => {
      const content = `---
---

Content only`;
      const result = frontmatterParser.parse(content, "test.md");

      expect(result.data).toEqual({});
      expect(result.content).toBe("Content only");
    });

    it("handles empty content", () => {
      const content = `---
title: Test
---`;
      const result = frontmatterParser.parse(content, "test.md");

      expect(result.data).toEqual({ title: "Test" });
      expect(result.content).toBe("");
    });

    it("handles no frontmatter", () => {
      const content = "Just plain content";
      const result = frontmatterParser.parse(content, "test.md");

      expect(result.data).toEqual({});
      expect(result.content).toBe("Just plain content");
    });

    it("throws FrontmatterParseError for invalid frontmatter", () => {
      const content = `---
title: Test
invalid yaml:
  - item
 - bad indent
---

Content`;

      expect(() => frontmatterParser.parse(content, "test.md")).toThrow(FrontmatterParseError);
    });

    it("throws error for array frontmatter", () => {
      const content = `---
- item1
- item2
---

Content`;

      expect(() => frontmatterParser.parse(content, "test.md")).toThrow(FrontmatterParseError);
      expect(() => frontmatterParser.parse(content, "test.md")).toThrow(
        "Frontmatter must be a YAML object/map",
      );
    });

    it("error includes file path", () => {
      const content = `---
- array
---`;

      try {
        frontmatterParser.parse(content, "/path/to/file.md");
      } catch (error) {
        expect(error).toBeInstanceOf(FrontmatterParseError);
        const fmError = error as FrontmatterParseError;
        expect(fmError.filePath).toBe("/path/to/file.md");
        expect(fmError.message).toContain("/path/to/file.md");
      }
    });

    it("has correct metadata", () => {
      expect(frontmatterParser.name).toBe("frontmatter");
      expect(frontmatterParser.extensions).toEqual(["md", "mdx", "markdown"]);
      expect(frontmatterParser.hasContent).toBe(true);
    });

    // Edge case tests for production-ready parser
    describe("edge cases", () => {
      it("handles CRLF line endings (Windows)", () => {
        const content = "---\r\ntitle: Test\r\n---\r\n\r\nContent";
        const result = frontmatterParser.parse(content, "test.md");

        expect(result.data).toEqual({ title: "Test" });
        expect(result.content).toBe("Content");
      });

      it("handles CR-only line endings (old Mac)", () => {
        const content = "---\rtitle: Test\r---\r\rContent";
        const result = frontmatterParser.parse(content, "test.md");

        expect(result.data).toEqual({ title: "Test" });
        expect(result.content).toBe("Content");
      });

      it("handles mixed line endings", () => {
        const content = "---\r\ntitle: Test\n---\r\nContent";
        const result = frontmatterParser.parse(content, "test.md");

        expect(result.data).toEqual({ title: "Test" });
        expect(result.content).toBe("Content");
      });

      it("handles BOM (Byte Order Mark) at start", () => {
        const content = "\ufeff---\ntitle: Test\n---\n\nContent";
        const result = frontmatterParser.parse(content, "test.md");

        expect(result.data).toEqual({ title: "Test" });
        expect(result.content).toBe("Content");
      });

      it("handles BOM with CRLF", () => {
        const content = "\ufeff---\r\ntitle: Test\r\n---\r\n\r\nContent";
        const result = frontmatterParser.parse(content, "test.md");

        expect(result.data).toEqual({ title: "Test" });
        expect(result.content).toBe("Content");
      });

      it("handles YAML document end marker (...)", () => {
        const content = "---\ntitle: Test\n...\n\nContent";
        const result = frontmatterParser.parse(content, "test.md");

        expect(result.data).toEqual({ title: "Test" });
        expect(result.content).toBe("Content");
      });

      it("handles trailing whitespace on opening delimiter", () => {
        const content = "---   \ntitle: Test\n---\n\nContent";
        const result = frontmatterParser.parse(content, "test.md");

        expect(result.data).toEqual({ title: "Test" });
        expect(result.content).toBe("Content");
      });

      it("handles trailing whitespace on closing delimiter", () => {
        const content = "---\ntitle: Test\n---  \n\nContent";
        const result = frontmatterParser.parse(content, "test.md");

        expect(result.data).toEqual({ title: "Test" });
        expect(result.content).toBe("Content");
      });

      it("handles trailing tab on delimiter", () => {
        const content = "---\t\ntitle: Test\n---\t\n\nContent";
        const result = frontmatterParser.parse(content, "test.md");

        expect(result.data).toEqual({ title: "Test" });
        expect(result.content).toBe("Content");
      });

      it("handles content starting with --- that isn't frontmatter", () => {
        const content = "---abc\nNot frontmatter";
        const result = frontmatterParser.parse(content, "test.md");

        expect(result.data).toEqual({});
        expect(result.content).toBe("---abc\nNot frontmatter");
      });

      it("handles only opening delimiter without newline", () => {
        const content = "---";
        const result = frontmatterParser.parse(content, "test.md");

        expect(result.data).toEqual({});
        expect(result.content).toBe("---");
      });

      it("handles missing closing delimiter", () => {
        const content = "---\ntitle: Test\nNo closing delimiter here";
        const result = frontmatterParser.parse(content, "test.md");

        // Matches gray-matter behavior: treat rest as body
        expect(result.data).toEqual({});
        expect(result.content).toBe("title: Test\nNo closing delimiter here");
      });

      it("handles null frontmatter value", () => {
        const content = "---\nnull\n---\n\nContent";
        const result = frontmatterParser.parse(content, "test.md");

        expect(result.data).toEqual({});
        expect(result.content).toBe("Content");
      });

      it("handles frontmatter with only comments", () => {
        const content = "---\n# Just a comment\n---\n\nContent";
        const result = frontmatterParser.parse(content, "test.md");

        expect(result.data).toEqual({});
        expect(result.content).toBe("Content");
      });

      it("handles complex nested YAML", () => {
        const content = `---
title: Test
metadata:
  author: John
  tags:
    - one
    - two
  nested:
    deep: value
---

Content`;
        const result = frontmatterParser.parse(content, "test.md");

        expect(result.data).toEqual({
          title: "Test",
          metadata: {
            author: "John",
            tags: ["one", "two"],
            nested: { deep: "value" },
          },
        });
      });

      it("handles dates in frontmatter", () => {
        const content = `---
title: Test
date: 2024-01-15
---

Content`;
        const result = frontmatterParser.parse(content, "test.md");

        expect(result.data.title).toBe("Test");
        // YAML parses dates as Date objects
        expect(result.data.date).toBeInstanceOf(Date);
      });

      it("handles quoted strings with special characters", () => {
        const content = `---
title: "Test: with colon"
description: "Has --- dashes"
---

Content`;
        const result = frontmatterParser.parse(content, "test.md");

        expect(result.data).toEqual({
          title: "Test: with colon",
          description: "Has --- dashes",
        });
      });

      it("handles multiline strings", () => {
        const content = `---
description: |
  Line 1
  Line 2
---

Content`;
        const result = frontmatterParser.parse(content, "test.md");

        expect(result.data.description).toBe("Line 1\nLine 2\n");
      });

      it("handles very long content efficiently", () => {
        const longBody = "x".repeat(100000);
        const content = `---
title: Test
---

${longBody}`;
        const result = frontmatterParser.parse(content, "test.md");

        expect(result.data).toEqual({ title: "Test" });
        // Body is \n + longBody, but we strip the leading newline
        expect(result.content.length).toBe(100000);
        expect(result.content).toBe(longBody);
      });

      it("handles ---json language identifier", () => {
        const content = `---json
{"title": "Test", "count": 42}
---

Content`;
        const result = frontmatterParser.parse(content, "test.md");

        expect(result.data).toEqual({ title: "Test", count: 42 });
        expect(result.content).toBe("Content");
      });

      it("handles ---json with CRLF", () => {
        const content = "---json\r\n{\"title\": \"Test\"}\r\n---\r\n\r\nContent";
        const result = frontmatterParser.parse(content, "test.md");

        expect(result.data).toEqual({ title: "Test" });
        expect(result.content).toBe("Content");
      });
    });
  });

  describe("frontmatterOnlyParser", () => {
    it("extracts frontmatter and returns empty content", () => {
      const content = `---
title: Test Post
author: John Doe
---

This content is ignored`;
      const result = frontmatterOnlyParser.parse(content, "test.md");

      expect(result.data).toEqual({ title: "Test Post", author: "John Doe" });
      expect(result.content).toBe("");
    });

    it("handles empty frontmatter", () => {
      const content = `---
---

Content`;
      const result = frontmatterOnlyParser.parse(content, "test.md");

      expect(result.data).toEqual({});
      expect(result.content).toBe("");
    });

    it("handles no frontmatter", () => {
      const content = "Just content";
      const result = frontmatterOnlyParser.parse(content, "test.md");

      expect(result.data).toEqual({});
      expect(result.content).toBe("");
    });

    it("throws FrontmatterParseError for invalid YAML", () => {
      const content = `---
invalid:
  - yaml
 - bad
---`;

      expect(() => frontmatterOnlyParser.parse(content, "test.md")).toThrow(FrontmatterParseError);
    });

    it("has correct metadata", () => {
      expect(frontmatterOnlyParser.name).toBe("frontmatter-only");
      expect(frontmatterOnlyParser.extensions).toEqual(["md", "mdx", "markdown"]);
      expect(frontmatterOnlyParser.hasContent).toBe(false);
    });
  });

  describe("resolveParser", () => {
    it("returns frontmatter parser for undefined", () => {
      const parser = resolveParser(undefined);

      expect(parser.name).toBe("frontmatter");
      expect(parser).toBe(frontmatterParser);
    });

    it("resolves json preset", () => {
      const parser = resolveParser("json");

      expect(parser.name).toBe("json");
      expect(parser).toBe(jsonParser);
    });

    it("resolves yaml preset", () => {
      const parser = resolveParser("yaml");

      expect(parser.name).toBe("yaml");
      expect(parser).toBe(yamlParser);
    });

    it("resolves frontmatter preset", () => {
      const parser = resolveParser("frontmatter");

      expect(parser.name).toBe("frontmatter");
      expect(parser).toBe(frontmatterParser);
    });

    it("resolves frontmatter-only preset", () => {
      const parser = resolveParser("frontmatter-only");

      expect(parser.name).toBe("frontmatter-only");
      expect(parser).toBe(frontmatterOnlyParser);
    });

    it("returns custom parser object", () => {
      const customParser: Parser = {
        name: "custom",
        extensions: ["txt"],
        hasContent: true,
        parse: (content, _filePath) => ({ data: {}, content }),
      };

      const parser = resolveParser(customParser);

      expect(parser).toBe(customParser);
    });

    it("wraps parse function in parser object", () => {
      const parser = resolveParser(parseFn);

      expect(parser.name).toBe("custom");
      expect(parser.extensions).toEqual([]);
      expect(parser.hasContent).toBe(true);
      expect(parser.parse).toBe(parseFn);
    });

    it("throws for unknown preset", () => {
      expect(() => resolveParser("unknown" as ParserPreset)).toThrow(
        'Unknown parser preset: "unknown"',
      );
      expect(() => resolveParser("toml" as ParserPreset)).toThrow(
        "Valid presets are: frontmatter, frontmatter-only, json, yaml",
      );
    });
  });

  describe("getParserExtensions", () => {
    it("returns json extensions", () => {
      const extensions = getParserExtensions("json");

      expect(extensions).toEqual(["json"]);
    });

    it("returns yaml extensions", () => {
      const extensions = getParserExtensions("yaml");

      expect(extensions).toEqual(["yaml", "yml"]);
    });

    it("returns frontmatter extensions", () => {
      const extensions = getParserExtensions("frontmatter");

      expect(extensions).toEqual(["md", "mdx", "markdown"]);
    });

    it("returns frontmatter-only extensions", () => {
      const extensions = getParserExtensions("frontmatter-only");

      expect(extensions).toEqual(["md", "mdx", "markdown"]);
    });
  });

  describe("isValidPreset", () => {
    it("returns true for valid presets", () => {
      expect(isValidPreset("json")).toBe(true);
      expect(isValidPreset("yaml")).toBe(true);
      expect(isValidPreset("frontmatter")).toBe(true);
      expect(isValidPreset("frontmatter-only")).toBe(true);
    });

    it("returns false for invalid presets", () => {
      expect(isValidPreset("unknown")).toBe(false);
      expect(isValidPreset("toml")).toBe(false);
      expect(isValidPreset("xml")).toBe(false);
      expect(isValidPreset("")).toBe(false);
    });
  });

  describe("getDefaultIncludePatterns", () => {
    it("returns empty array for parser with no extensions", () => {
      const parser: Parser = {
        name: "custom",
        extensions: [],
        hasContent: true,
        parse: () => ({ data: {}, content: "" }),
      };

      const patterns = getDefaultIncludePatterns(parser);

      expect(patterns).toEqual([]);
    });

    it("returns simple pattern for single extension", () => {
      const patterns = getDefaultIncludePatterns(jsonParser);

      expect(patterns).toEqual(["**/*.json"]);
    });

    it("returns brace expansion for multiple extensions", () => {
      const patterns = getDefaultIncludePatterns(yamlParser);

      expect(patterns).toEqual(["**/*.{yaml,yml}"]);
    });

    it("handles frontmatter extensions", () => {
      const patterns = getDefaultIncludePatterns(frontmatterParser);

      expect(patterns).toEqual(["**/*.{md,mdx,markdown}"]);
    });
  });

  describe("detectParserByExtension", () => {
    it("detects json parser", () => {
      const parser = detectParserByExtension("json");

      expect(parser?.name).toBe("json");
    });

    it("detects yaml parser for yaml extension", () => {
      const parser = detectParserByExtension("yaml");

      expect(parser?.name).toBe("yaml");
    });

    it("detects yaml parser for yml extension", () => {
      const parser = detectParserByExtension("yml");

      expect(parser?.name).toBe("yaml");
    });

    it("detects frontmatter parser for md extension", () => {
      const parser = detectParserByExtension("md");

      expect(parser?.name).toBe("frontmatter");
    });

    it("detects frontmatter parser for mdx extension", () => {
      const parser = detectParserByExtension("mdx");

      expect(parser?.name).toBe("frontmatter");
    });

    it("detects frontmatter parser for markdown extension", () => {
      const parser = detectParserByExtension("markdown");

      expect(parser?.name).toBe("frontmatter");
    });

    it("is case insensitive", () => {
      expect(detectParserByExtension("JSON")?.name).toBe("json");
      expect(detectParserByExtension("YAML")?.name).toBe("yaml");
      expect(detectParserByExtension("YML")?.name).toBe("yaml");
      expect(detectParserByExtension("MD")?.name).toBe("frontmatter");
      expect(detectParserByExtension("MDX")?.name).toBe("frontmatter");
    });

    it("returns undefined for unknown extension", () => {
      expect(detectParserByExtension("txt")).toBeUndefined();
      expect(detectParserByExtension("toml")).toBeUndefined();
      expect(detectParserByExtension("xml")).toBeUndefined();
      expect(detectParserByExtension("")).toBeUndefined();
    });
  });

  describe("hasFrontmatter", () => {
    it("returns true for valid frontmatter", () => {
      expect(hasFrontmatter("---\ntitle: Test\n---")).toBe(true);
    });

    it("returns true for frontmatter with BOM", () => {
      expect(hasFrontmatter("\ufeff---\ntitle: Test\n---")).toBe(true);
    });

    it("returns true for frontmatter with CRLF", () => {
      expect(hasFrontmatter("---\r\ntitle: Test\r\n---")).toBe(true);
    });

    it("returns true for frontmatter with trailing whitespace", () => {
      expect(hasFrontmatter("---   \ntitle: Test\n---")).toBe(true);
    });

    it("returns false for content without frontmatter", () => {
      expect(hasFrontmatter("# Just a heading")).toBe(false);
    });

    it("returns true for language identifier like ---json", () => {
      expect(hasFrontmatter("---json\n{}\n---")).toBe(true);
    });

    it("returns false for invalid delimiter like ---!", () => {
      expect(hasFrontmatter("---!\nNot frontmatter")).toBe(false);
    });

    it("returns false when no newline after language identifier", () => {
      expect(hasFrontmatter("---json")).toBe(false);
    });

    it("returns false for short content", () => {
      expect(hasFrontmatter("---")).toBe(false);
      expect(hasFrontmatter("--")).toBe(false);
      expect(hasFrontmatter("")).toBe(false);
    });
  });

  describe("stringify", () => {
    it("converts data to frontmatter string", () => {
      const result = stringify({ title: "Test" }, "Content here");

      expect(result).toContain("---");
      expect(result).toContain("title: Test");
      expect(result).toContain("Content here");
    });

    it("returns content only for empty data", () => {
      const result = stringify({}, "Content here");

      expect(result).toBe("Content here");
    });

    it("handles JSON language option", () => {
      const result = stringify({ title: "Test" }, "Content", { language: "json" });

      expect(result).toContain("---json");
      expect(result).toContain('"title": "Test"');
    });
  });

  describe("extractExcerpt", () => {
    it("extracts excerpt with default separator", () => {
      const parsed = {
        data: { title: "Test" },
        body: "This is excerpt\n---\nThis is content",
        matter: "title: Test",
        hasFrontmatter: true,
        language: "yaml" as const,
      };
      const result = extractExcerpt(parsed);

      expect(result.excerpt).toBe("This is excerpt");
      expect(result.body).toBe("This is content");
    });

    it("returns empty excerpt when separator not found", () => {
      const parsed = {
        data: { title: "Test" },
        body: "Content without separator",
        matter: "title: Test",
        hasFrontmatter: true,
        language: "yaml" as const,
      };
      const result = extractExcerpt(parsed);

      expect(result.excerpt).toBe("");
      expect(result.body).toBe("Content without separator");
    });

    it("uses custom separator", () => {
      const parsed = {
        data: { title: "Test" },
        body: "This is excerpt\n<!-- more -->\nThis is content",
        matter: "title: Test",
        hasFrontmatter: true,
        language: "yaml" as const,
      };
      const result = extractExcerpt(parsed, "<!-- more -->");

      expect(result.excerpt).toBe("This is excerpt");
      expect(result.body).toBe("This is content");
    });
  });
});

import { describe, it, expect } from "vitest";
import {
  createSlugger,
  slugify,
  slugifyOnce,
  resetSlugger,
} from "../slugify.js";

describe("createSlugger", () => {
  it("creates a new slugger instance", () => {
    const slugger = createSlugger();
    expect(slugger).toBeDefined();
    expect(typeof slugger.slug).toBe("function");
    expect(typeof slugger.reset).toBe("function");
  });

  it("creates independent instances", () => {
    const slugger1 = createSlugger();
    const slugger2 = createSlugger();

    slugger1.slug("test");
    slugger1.slug("test");

    // Slugger2 should start fresh
    expect(slugger2.slug("test")).toBe("test");
  });
});

describe("slugify", () => {
  it("converts text to lowercase slug", () => {
    expect(slugify("Hello World")).toBe("hello-world");
  });

  it("handles special characters", () => {
    expect(slugify("What's New?")).toBe("whats-new");
    expect(slugify("C++ Programming")).toBe("c-programming");
  });

  it("handles unicode characters", () => {
    expect(slugify("Café Résumé")).toBe("café-résumé");
    expect(slugify("日本語")).toBe("日本語");
  });

  it("handles numbers", () => {
    expect(slugify("Version 2.0")).toBe("version-20");
    expect(slugify("100 Tips")).toBe("100-tips");
  });

  it("handles consecutive spaces", () => {
    expect(slugify("Multiple   Spaces")).toBe("multiple---spaces");
  });

  it("tracks duplicates with shared slugger", () => {
    const slugger = createSlugger();

    expect(slugify("Test", slugger)).toBe("test");
    expect(slugify("Test", slugger)).toBe("test-1");
    expect(slugify("Test", slugger)).toBe("test-2");
  });

  it("creates new slugger when none provided", () => {
    // Each call without slugger should be independent
    expect(slugify("Test")).toBe("test");
    expect(slugify("Test")).toBe("test");
  });

  it("handles empty string", () => {
    expect(slugify("")).toBe("");
  });

  it("handles whitespace-only string", () => {
    // github-slugger converts spaces to dashes
    expect(slugify("   ")).toBe("---");
  });

  it("handles markdown headers", () => {
    expect(slugify("## Getting Started")).toBe("-getting-started");
  });
});

describe("slugifyOnce", () => {
  it("generates slug without tracking duplicates", () => {
    // Each call is independent
    expect(slugifyOnce("Test")).toBe("test");
    expect(slugifyOnce("Test")).toBe("test");
    expect(slugifyOnce("Test")).toBe("test");
  });

  it("converts text to slug", () => {
    expect(slugifyOnce("Hello World")).toBe("hello-world");
    expect(slugifyOnce("API Reference")).toBe("api-reference");
  });

  it("handles special characters", () => {
    expect(slugifyOnce("What's Up?")).toBe("whats-up");
  });
});

describe("resetSlugger", () => {
  it("clears duplicate tracking", () => {
    const slugger = createSlugger();

    expect(slugger.slug("test")).toBe("test");
    expect(slugger.slug("test")).toBe("test-1");
    expect(slugger.slug("test")).toBe("test-2");

    resetSlugger(slugger);

    // After reset, should start fresh
    expect(slugger.slug("test")).toBe("test");
    expect(slugger.slug("test")).toBe("test-1");
  });

  it("resets all tracked slugs", () => {
    const slugger = createSlugger();

    slugger.slug("foo");
    slugger.slug("bar");
    slugger.slug("baz");

    resetSlugger(slugger);

    // All should be fresh
    expect(slugger.slug("foo")).toBe("foo");
    expect(slugger.slug("bar")).toBe("bar");
    expect(slugger.slug("baz")).toBe("baz");
  });
});

describe("slug generation edge cases", () => {
  it("handles very long text", () => {
    const longText = "A".repeat(1000);
    const slug = slugifyOnce(longText);
    expect(typeof slug).toBe("string");
    expect(slug.length).toBeGreaterThan(0);
  });

  it("handles mixed case", () => {
    expect(slugifyOnce("CamelCase")).toBe("camelcase");
    expect(slugifyOnce("UPPERCASE")).toBe("uppercase");
    expect(slugifyOnce("lowercase")).toBe("lowercase");
  });

  it("handles punctuation", () => {
    expect(slugifyOnce("Hello, World!")).toBe("hello-world");
    expect(slugifyOnce("foo.bar.baz")).toBe("foobarbaz");
    expect(slugifyOnce("one/two/three")).toBe("onetwothree");
  });

  it("handles dashes", () => {
    expect(slugifyOnce("pre-existing")).toBe("pre-existing");
    expect(slugifyOnce("--double--dash--")).toBe("--double--dash--");
  });

  it("handles emojis", () => {
    const slug = slugifyOnce("Hello 👋 World");
    expect(typeof slug).toBe("string");
  });
});

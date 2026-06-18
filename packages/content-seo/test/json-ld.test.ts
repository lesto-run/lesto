import { describe, expect, it } from "vitest";

import { ParseError } from "@volo/content-shared/errors";

import { jsonLd } from "../src/json-ld";

import type { SchemaEntry, SchemaOrgOptions } from "../src/types";

const entry = (extra: Record<string, unknown>): SchemaEntry => ({
  id: "1",
  collection: "posts",
  ...extra,
});

const options: SchemaOrgOptions = { siteUrl: "https://example.com" };

// All jsonLd methods return serialized (script-safe) JSON; parse back through
// the package's own parse() helper to assert on structure.
const parse = (json: string): Record<string, unknown> => jsonLd.parse(json);

describe("jsonLd entry-based methods", () => {
  it("article / blogPost / newsArticle / techArticle emit the matching @type", () => {
    const cases: Array<[keyof typeof jsonLd, string]> = [
      ["article", "Article"],
      ["blogPost", "BlogPosting"],
      ["newsArticle", "NewsArticle"],
      ["techArticle", "TechArticle"],
    ];
    for (const [method, type] of cases) {
      const fn = jsonLd[method] as (e: SchemaEntry, o: SchemaOrgOptions) => string;
      const schema = parse(fn(entry({ slug: "s", title: "T" }), options));
      expect(schema["@type"]).toBe(type);
      expect(schema["@context"]).toBe("https://schema.org");
    }
  });

  it("product emits a Product schema", () => {
    const schema = parse(jsonLd.product(entry({ slug: "s", name: "Widget" }), options));
    expect(schema["@type"]).toBe("Product");
    expect(schema["name"]).toBe("Widget");
  });

  it("page emits a WebPage schema", () => {
    const schema = parse(jsonLd.page(entry({ slug: "s", title: "Page" }), options));
    expect(schema["@type"]).toBe("WebPage");
    expect(schema["name"]).toBe("Page");
  });
});

describe("jsonLd specialized methods", () => {
  it("faq emits a FAQPage", () => {
    const schema = parse(jsonLd.faq([{ question: "Q?", answer: "A." }]));
    expect(schema["@type"]).toBe("FAQPage");
  });

  it("howTo passes through name, steps, and options", () => {
    const schema = parse(
      jsonLd.howTo("Guide", [{ name: "step", text: "do" }], { description: "d" }),
    );
    expect(schema["@type"]).toBe("HowTo");
    expect(schema["name"]).toBe("Guide");
    expect(schema["description"]).toBe("d");
  });

  it("howTo works without options", () => {
    const schema = parse(jsonLd.howTo("Guide", [{ name: "step", text: "do" }]));
    expect(schema["@type"]).toBe("HowTo");
    expect(schema["description"]).toBeUndefined();
  });

  it("breadcrumbs emits a BreadcrumbList", () => {
    const schema = parse(jsonLd.breadcrumbs([{ name: "Home", url: "https://x.com" }]));
    expect(schema["@type"]).toBe("BreadcrumbList");
  });
});

describe("jsonLd.postWithBreadcrumbs", () => {
  it("combines a BlogPosting with a three-level breadcrumb in a @graph", () => {
    const schema = parse(
      jsonLd.postWithBreadcrumbs(entry({ slug: "my-post", title: "My Post" }), {
        siteUrl: "https://example.com",
        sectionName: "Blog",
        sectionPath: "/blog",
      }),
    );
    const graph = schema["@graph"] as Record<string, unknown>[];
    expect(graph).toHaveLength(2);
    expect(graph[0]?.["@type"]).toBe("BlogPosting");

    const breadcrumb = graph[1] as Record<string, unknown>;
    expect(breadcrumb["@type"]).toBe("BreadcrumbList");
    const items = breadcrumb["itemListElement"] as Record<string, unknown>[];
    expect(items.map((i) => i["item"])).toEqual([
      "https://example.com",
      "https://example.com/blog",
      "https://example.com/blog/my-post",
    ]);
    expect(items.map((i) => i["name"])).toEqual(["Home", "Blog", "My Post"]);
  });

  it("applies default section name/path and trims a trailing slash from siteUrl", () => {
    const schema = parse(
      jsonLd.postWithBreadcrumbs(entry({ slug: "p", title: "P" }), {
        siteUrl: "https://example.com/",
      }),
    );
    const graph = schema["@graph"] as Record<string, unknown>[];
    const items = (graph[1]?.["itemListElement"] ?? []) as Record<string, unknown>[];
    expect(items[1]?.["name"]).toBe("Posts");
    expect(items[1]?.["item"]).toBe("https://example.com/posts");
    expect(items[2]?.["item"]).toBe("https://example.com/posts/p");
  });

  it("uses Untitled and an empty slug when those fields are missing", () => {
    const schema = parse(
      jsonLd.postWithBreadcrumbs({ id: "x", collection: "posts" } as SchemaEntry, {
        siteUrl: "https://example.com",
      }),
    );
    const graph = schema["@graph"] as Record<string, unknown>[];
    const items = (graph[1]?.["itemListElement"] ?? []) as Record<string, unknown>[];
    expect(items[2]?.["name"]).toBe("Untitled");
    expect(items[2]?.["item"]).toBe("https://example.com/posts/");
  });
});

describe("jsonLd.create", () => {
  it("wraps arbitrary properties with @context and @type", () => {
    const schema = parse(
      jsonLd.create("Person", { name: "Grace Hopper", jobTitle: "Computer Scientist" }),
    );
    expect(schema["@context"]).toBe("https://schema.org");
    expect(schema["@type"]).toBe("Person");
    expect(schema["name"]).toBe("Grace Hopper");
    expect(schema["jobTitle"]).toBe("Computer Scientist");
  });
});

describe("jsonLd.graph", () => {
  it("merges multiple serialized schemas, stripping per-schema @context", () => {
    const combined = parse(
      jsonLd.graph(
        jsonLd.blogPost(entry({ slug: "s", title: "T" }), options),
        jsonLd.breadcrumbs([{ name: "Home", url: "https://x.com" }]),
      ),
    );
    expect(combined["@context"]).toBe("https://schema.org");
    const graph = combined["@graph"] as Record<string, unknown>[];
    expect(graph).toHaveLength(2);
    expect(graph[0]?.["@context"]).toBeUndefined();
    expect(graph[1]?.["@context"]).toBeUndefined();
  });

  it("throws a ParseError with count context when called with no schemas", () => {
    try {
      jsonLd.graph();
      expect.unreachable("graph() should throw on no input");
    } catch (error) {
      expect(error).toBeInstanceOf(ParseError);
      expect((error as ParseError).code).toBe("PARSE_ERROR");
      expect((error as ParseError).context["count"]).toBe(0);
    }
  });

  it("throws a ParseError that pinpoints the index of an invalid JSON schema", () => {
    try {
      jsonLd.graph(jsonLd.create("Thing", {}), "{not valid json");
      expect.unreachable("graph() should throw on invalid JSON");
    } catch (error) {
      expect(error).toBeInstanceOf(ParseError);
      expect((error as ParseError).context["index"]).toBe(1);
      expect((error as ParseError).context["preview"]).toBe("{not valid json");
    }
  });
});

describe("jsonLd.parse", () => {
  it("parses a serialized schema back into an object", () => {
    const json = jsonLd.create("Thing", { name: "x" });
    const obj = jsonLd.parse(json);
    expect(obj["name"]).toBe("x");
  });
});

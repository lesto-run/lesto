import { describe, expect, it } from "vitest";

import {
  generateBreadcrumbSchema,
  generateFAQSchema,
  generateHowToSchema,
  generateSchemaOrg,
  mergeSchemaOrg,
  serializeSchemaOrg,
} from "../src/schema-org";

import type { SchemaEntry, SchemaOrgOptions } from "../src/types";

const entry = (extra: Record<string, unknown>): SchemaEntry => ({
  id: "1",
  collection: "posts",
  ...extra,
});

const baseOptions: SchemaOrgOptions = { siteUrl: "https://example.com" };

describe("generateSchemaOrg — Article family", () => {
  it("builds a BlogPosting with headline, url, and mainEntityOfPage", () => {
    const schema = generateSchemaOrg(
      entry({ slug: "hello", title: "Hello World" }),
      "BlogPosting",
      baseOptions,
    );
    expect(schema["@type"]).toBe("BlogPosting");
    expect(schema["headline"]).toBe("Hello World");
    expect(schema["url"]).toBe("https://example.com/posts/hello");
    expect(schema["mainEntityOfPage"]).toEqual({
      "@type": "WebPage",
      "@id": "https://example.com/posts/hello",
    });
  });

  it("supports all four article subtypes", () => {
    for (const type of ["Article", "TechArticle", "NewsArticle"] as const) {
      const schema = generateSchemaOrg(entry({ slug: "s" }), type, baseOptions);
      expect(schema["@type"]).toBe(type);
    }
  });

  it("falls back to the slug for the headline when no title is present", () => {
    const schema = generateSchemaOrg(entry({ slug: "slug-only" }), "Article", baseOptions);
    expect(schema["headline"]).toBe("slug-only");
  });

  it("includes description from the configured descriptionField, then excerpt, then summary", () => {
    const fromExcerpt = generateSchemaOrg(
      entry({ slug: "s", excerpt: "via excerpt" }),
      "Article",
      baseOptions,
    );
    expect(fromExcerpt["description"]).toBe("via excerpt");

    const fromSummary = generateSchemaOrg(
      entry({ slug: "s", summary: "via summary" }),
      "Article",
      baseOptions,
    );
    expect(fromSummary["description"]).toBe("via summary");
  });

  it("omits description, dates, image, author, and publisher when absent", () => {
    const schema = generateSchemaOrg(entry({ slug: "s" }), "Article", baseOptions);
    expect(schema["description"]).toBeUndefined();
    expect(schema["datePublished"]).toBeUndefined();
    expect(schema["dateModified"]).toBeUndefined();
    expect(schema["image"]).toBeUndefined();
    expect(schema["author"]).toBeUndefined();
    expect(schema["publisher"]).toBeUndefined();
  });

  it("formats a Date instance and a parseable date string to ISO", () => {
    const fromDate = generateSchemaOrg(
      entry({ slug: "s", date: new Date("2025-01-02T03:04:05.000Z") }),
      "Article",
      baseOptions,
    );
    expect(fromDate["datePublished"]).toBe("2025-01-02T03:04:05.000Z");

    const fromString = generateSchemaOrg(
      entry({ slug: "s", date: "2025-06-09" }),
      "Article",
      baseOptions,
    );
    expect(fromString["datePublished"]).toBe(new Date("2025-06-09").toISOString());
  });

  it("ignores an unparseable date string", () => {
    const schema = generateSchemaOrg(
      entry({ slug: "s", date: "not a date" }),
      "Article",
      baseOptions,
    );
    expect(schema["datePublished"]).toBeUndefined();
  });

  it("ignores a date value that is neither a Date nor a string", () => {
    // A numeric date field is truthy but not handled, so no date is emitted.
    const schema = generateSchemaOrg(
      entry({ slug: "s", date: 1717891200000 }),
      "Article",
      baseOptions,
    );
    expect(schema["datePublished"]).toBeUndefined();
  });

  it("falls back through publishedAt and createdAt for the published date", () => {
    const fromPublishedAt = generateSchemaOrg(
      entry({ slug: "s", publishedAt: "2025-01-01" }),
      "Article",
      baseOptions,
    );
    expect(fromPublishedAt["datePublished"]).toBe(new Date("2025-01-01").toISOString());

    const fromCreatedAt = generateSchemaOrg(
      entry({ slug: "s", createdAt: "2025-02-02" }),
      "Article",
      baseOptions,
    );
    expect(fromCreatedAt["datePublished"]).toBe(new Date("2025-02-02").toISOString());
  });

  it("resolves the modified date from updatedAt by default and modifiedAt as a fallback", () => {
    const fromUpdated = generateSchemaOrg(
      entry({ slug: "s", updatedAt: "2025-03-03" }),
      "Article",
      baseOptions,
    );
    expect(fromUpdated["dateModified"]).toBe(new Date("2025-03-03").toISOString());

    const fromModified = generateSchemaOrg(
      entry({ slug: "s", modifiedAt: "2025-04-04" }),
      "Article",
      baseOptions,
    );
    expect(fromModified["dateModified"]).toBe(new Date("2025-04-04").toISOString());
  });

  it("honors a custom modifiedDateField", () => {
    const schema = generateSchemaOrg(entry({ slug: "s", lastTouched: "2025-05-05" }), "Article", {
      ...baseOptions,
      modifiedDateField: "lastTouched",
    });
    expect(schema["dateModified"]).toBe(new Date("2025-05-05").toISOString());
  });

  it("wraps the image url in an ImageObject and respects field priority", () => {
    const schema = generateSchemaOrg(
      entry({ slug: "s", og_image: "/og.png" }),
      "Article",
      baseOptions,
    );
    expect(schema["image"]).toEqual({ "@type": "ImageObject", url: "/og.png" });
  });

  it("honors a custom imageField", () => {
    const schema = generateSchemaOrg(entry({ slug: "s", hero: "/hero.png" }), "Article", {
      ...baseOptions,
      imageField: "hero",
    });
    expect(schema["image"]).toEqual({ "@type": "ImageObject", url: "/hero.png" });
  });

  it("emits a Person author with optional url and image", () => {
    const schema = generateSchemaOrg(entry({ slug: "s" }), "Article", {
      ...baseOptions,
      author: { name: "Jane", url: "https://jane.dev", image: "/jane.png" },
    });
    expect(schema["author"]).toEqual({
      "@type": "Person",
      name: "Jane",
      url: "https://jane.dev",
      image: "/jane.png",
    });
  });

  it("emits a Person author without the optional fields", () => {
    const schema = generateSchemaOrg(entry({ slug: "s" }), "Article", {
      ...baseOptions,
      author: { name: "Jane" },
    });
    expect(schema["author"]).toEqual({ "@type": "Person", name: "Jane" });
  });

  it("emits an Organization publisher with a logo ImageObject and url", () => {
    const schema = generateSchemaOrg(entry({ slug: "s" }), "Article", {
      ...baseOptions,
      publisher: { name: "Acme", url: "https://acme.com", logo: "/logo.png" },
    });
    expect(schema["publisher"]).toEqual({
      "@type": "Organization",
      name: "Acme",
      url: "https://acme.com",
      logo: { "@type": "ImageObject", url: "/logo.png" },
    });
  });

  it("emits an Organization publisher without optional url and logo", () => {
    const schema = generateSchemaOrg(entry({ slug: "s" }), "Article", {
      ...baseOptions,
      publisher: { name: "Acme" },
    });
    expect(schema["publisher"]).toEqual({ "@type": "Organization", name: "Acme" });
  });
});

describe("generateSchemaOrg — entry URL generation", () => {
  it("strips a trailing slash from siteUrl and percent-encodes collection and slug", () => {
    const schema = generateSchemaOrg(
      entry({ collection: "blog posts", slug: "a/b c" }),
      "WebPage",
      { siteUrl: "https://example.com/" },
    );
    expect(schema["url"]).toBe("https://example.com/blog%20posts/a%2Fb%20c");
  });

  it("falls back to the id when no slug is present", () => {
    const schema = generateSchemaOrg({ id: "abc", collection: "c" }, "WebPage", baseOptions);
    expect(schema["url"]).toBe("https://example.com/c/abc");
  });

  it("treats an empty collection as a bare path segment", () => {
    const schema = generateSchemaOrg({ id: "abc", collection: "" }, "WebPage", baseOptions);
    expect(schema["url"]).toBe("https://example.com//abc");
  });

  it("uses a custom urlGenerator when provided", () => {
    const schema = generateSchemaOrg(entry({ slug: "x" }), "WebPage", {
      ...baseOptions,
      urlGenerator: (e) => `https://cdn.example.com/${e.id}`,
    });
    expect(schema["url"]).toBe("https://cdn.example.com/1");
  });

  it("throws when a custom urlGenerator returns an invalid URL", () => {
    expect(() =>
      generateSchemaOrg(entry({ slug: "x" }), "WebPage", {
        ...baseOptions,
        urlGenerator: () => "not-a-url",
      }),
    ).toThrow();
  });

  it("throws when the entry has neither slug nor id for default URL generation", () => {
    expect(() => generateSchemaOrg({ id: "", collection: "c" }, "WebPage", baseOptions)).toThrow(
      "Entry must have a slug or id for URL generation",
    );
  });

  it("throws when siteUrl itself is invalid", () => {
    expect(() => generateSchemaOrg(entry({ slug: "x" }), "WebPage", { siteUrl: "::::" })).toThrow();
  });
});

describe("generateSchemaOrg — Product", () => {
  it("builds a Product with name falling back to title then slug", () => {
    expect(
      generateSchemaOrg(entry({ slug: "s", name: "Widget" }), "Product", baseOptions)["name"],
    ).toBe("Widget");
    expect(
      generateSchemaOrg(entry({ slug: "s", title: "Titled" }), "Product", baseOptions)["name"],
    ).toBe("Titled");
    expect(generateSchemaOrg(entry({ slug: "s" }), "Product", baseOptions)["name"]).toBe("s");
  });

  it("includes brand, sku, image, and description when present", () => {
    const schema = generateSchemaOrg(
      entry({
        slug: "s",
        description: "A great widget",
        productImage: "/w.png",
        brand: "Acme",
        sku: "SKU-1",
      }),
      "Product",
      baseOptions,
    );
    expect(schema["description"]).toBe("A great widget");
    expect(schema["image"]).toEqual({ "@type": "ImageObject", url: "/w.png" });
    expect(schema["brand"]).toEqual({ "@type": "Brand", name: "Acme" });
    expect(schema["sku"]).toBe("SKU-1");
    expect(schema["offers"]).toBeUndefined();
  });

  it("emits an Offer with normalized availability when a price is present", () => {
    const schema = generateSchemaOrg(
      entry({ slug: "s", price: 19.99, currency: "EUR", availability: "out of stock" }),
      "Product",
      baseOptions,
    );
    expect(schema["offers"]).toEqual({
      "@type": "Offer",
      price: "19.99",
      priceCurrency: "EUR",
      availability: "https://schema.org/OutOfStock",
      url: "https://example.com/posts/s",
    });
  });

  it("treats a price of 0 as present and defaults currency to USD", () => {
    const schema = generateSchemaOrg(entry({ slug: "s", price: 0 }), "Product", baseOptions);
    const offers = schema["offers"] as Record<string, unknown>;
    expect(offers["price"]).toBe("0");
    expect(offers["priceCurrency"]).toBe("USD");
    // Unknown / missing availability defaults to InStock.
    expect(offers["availability"]).toBe("https://schema.org/InStock");
  });

  it("falls back to InStock for an unrecognized availability value", () => {
    const schema = generateSchemaOrg(
      entry({ slug: "s", price: 5, availability: "whoknows" }),
      "Product",
      baseOptions,
    );
    expect((schema["offers"] as Record<string, unknown>)["availability"]).toBe(
      "https://schema.org/InStock",
    );
  });

  it("normalizes several availability aliases", () => {
    const cases: Array<[string, string]> = [
      ["instock", "https://schema.org/InStock"],
      ["preorder", "https://schema.org/PreOrder"],
      ["back_order", "https://schema.org/BackOrder"],
      ["discontinued", "https://schema.org/Discontinued"],
      ["sold out", "https://schema.org/SoldOut"],
      ["limited availability", "https://schema.org/LimitedAvailability"],
      ["online_only", "https://schema.org/OnlineOnly"],
    ];
    for (const [input, expected] of cases) {
      const schema = generateSchemaOrg(
        entry({ slug: "s", price: 1, availability: input }),
        "Product",
        baseOptions,
      );
      expect((schema["offers"] as Record<string, unknown>)["availability"]).toBe(expected);
    }
  });
});

describe("generateSchemaOrg — WebPage", () => {
  it("builds a WebPage with name (title first), description, and url", () => {
    const schema = generateSchemaOrg(
      entry({ slug: "s", title: "Page Title", description: "Desc" }),
      "WebPage",
      baseOptions,
    );
    expect(schema["@type"]).toBe("WebPage");
    expect(schema["name"]).toBe("Page Title");
    expect(schema["description"]).toBe("Desc");
  });

  it("falls back from title to name to slug for the WebPage name", () => {
    expect(
      generateSchemaOrg(entry({ slug: "s", name: "By Name" }), "WebPage", baseOptions)["name"],
    ).toBe("By Name");
    expect(generateSchemaOrg(entry({ slug: "the-slug" }), "WebPage", baseOptions)["name"]).toBe(
      "the-slug",
    );
  });

  it("omits the description when absent", () => {
    const schema = generateSchemaOrg(entry({ slug: "s" }), "WebPage", baseOptions);
    expect(schema["description"]).toBeUndefined();
  });
});

describe("generateFAQSchema", () => {
  it("maps question/answer pairs into a FAQPage", () => {
    const schema = generateFAQSchema([
      { question: "Q1?", answer: "A1." },
      { question: "Q2?", answer: "A2." },
    ]);
    expect(schema["@type"]).toBe("FAQPage");
    expect(schema["mainEntity"]).toEqual([
      {
        "@type": "Question",
        name: "Q1?",
        acceptedAnswer: { "@type": "Answer", text: "A1." },
      },
      {
        "@type": "Question",
        name: "Q2?",
        acceptedAnswer: { "@type": "Answer", text: "A2." },
      },
    ]);
  });

  it("produces an empty mainEntity for no items", () => {
    expect(generateFAQSchema([])["mainEntity"]).toEqual([]);
  });
});

describe("generateHowToSchema", () => {
  it("numbers steps from 1 and carries optional step images", () => {
    const schema = generateHowToSchema("Make Tea", [
      { name: "Boil", text: "Boil water" },
      { name: "Steep", text: "Steep tea", image: "/steep.png" },
    ]);
    expect(schema["@type"]).toBe("HowTo");
    expect(schema["name"]).toBe("Make Tea");
    expect(schema["step"]).toEqual([
      { "@type": "HowToStep", position: 1, name: "Boil", text: "Boil water" },
      {
        "@type": "HowToStep",
        position: 2,
        name: "Steep",
        text: "Steep tea",
        image: "/steep.png",
      },
    ]);
  });

  it("includes top-level description and image when given in options", () => {
    const schema = generateHowToSchema("Guide", [{ name: "x", text: "y" }], {
      description: "How to do the thing",
      image: "/guide.png",
    });
    expect(schema["description"]).toBe("How to do the thing");
    expect(schema["image"]).toBe("/guide.png");
  });

  it("omits description and image when options are absent", () => {
    const schema = generateHowToSchema("Guide", [{ name: "x", text: "y" }]);
    expect(schema["description"]).toBeUndefined();
    expect(schema["image"]).toBeUndefined();
  });
});

describe("generateBreadcrumbSchema", () => {
  it("builds an ordered BreadcrumbList from items", () => {
    const schema = generateBreadcrumbSchema([
      { name: "Home", url: "https://x.com" },
      { name: "Blog", url: "https://x.com/blog" },
    ]);
    expect(schema["@type"]).toBe("BreadcrumbList");
    expect(schema["itemListElement"]).toEqual([
      { "@type": "ListItem", position: 1, name: "Home", item: "https://x.com" },
      { "@type": "ListItem", position: 2, name: "Blog", item: "https://x.com/blog" },
    ]);
  });
});

describe("serializeSchemaOrg", () => {
  it("escapes characters that could break out of a script tag", () => {
    const json = serializeSchemaOrg({ name: "</script><b>x</b>", note: "a & b" });
    expect(json).not.toContain("</script>");
    expect(json).toContain("\\u003c");
    expect(json).toContain("\\u003e");
    expect(json).toContain("\\u0026");
  });

  it("round-trips back to the original object once unescaped via JSON.parse", () => {
    const obj = { "@type": "Thing", name: "Plain" };
    expect(JSON.parse(serializeSchemaOrg(obj))).toEqual(obj);
  });
});

describe("mergeSchemaOrg", () => {
  it("lifts @context to the root and wraps schemas in a @graph", () => {
    const a = generateSchemaOrg(entry({ slug: "a", title: "A" }), "BlogPosting", baseOptions);
    const b = generateBreadcrumbSchema([{ name: "Home", url: "https://x.com" }]);
    const merged = mergeSchemaOrg([a, b]);

    expect(merged["@context"]).toBe("https://schema.org");
    const graph = merged["@graph"] as Record<string, unknown>[];
    expect(graph).toHaveLength(2);
    // Individual @context entries are stripped from graph members.
    expect(graph[0]?.["@context"]).toBeUndefined();
    expect(graph[1]?.["@context"]).toBeUndefined();
    expect(graph[0]?.["@type"]).toBe("BlogPosting");
  });

  it("produces an empty graph for no schemas", () => {
    expect(mergeSchemaOrg([])["@graph"]).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";

import { escape } from "../src/escape";
import { jsonLd } from "../src/json-ld";
import { metaTags } from "../src/meta-tags";
import { robots } from "../src/robots";
import { sitemap } from "../src/sitemap";

describe("escape", () => {
  it("replaces every XML-significant character with its entity", () => {
    expect(escape(`& < > " '`)).toBe("&amp; &lt; &gt; &quot; &apos;");
  });

  it("escapes ampersands without double-escaping the entities it introduces", () => {
    expect(escape("a&b")).toBe("a&amp;b");
  });
});

describe("metaTags", () => {
  it("emits every tag when all optionals are present", () => {
    const html = metaTags({
      title: "Home",
      description: "Welcome home",
      canonical: "https://example.com/",
      image: "https://example.com/og.png",
      type: "website",
    });

    expect(html).toBe(
      [
        "<title>Home</title>",
        `<meta property="og:title" content="Home" />`,
        `<meta name="description" content="Welcome home" />`,
        `<meta property="og:description" content="Welcome home" />`,
        `<meta property="og:image" content="https://example.com/og.png" />`,
        `<meta property="og:type" content="website" />`,
        `<link rel="canonical" href="https://example.com/" />`,
      ].join("\n"),
    );
  });

  it("omits every optional tag when only the title is given", () => {
    const html = metaTags({ title: "Bare" });

    expect(html).toBe(
      ["<title>Bare</title>", `<meta property="og:title" content="Bare" />`].join("\n"),
    );
    expect(html).not.toContain("description");
    expect(html).not.toContain("og:image");
    expect(html).not.toContain("og:type");
    expect(html).not.toContain("canonical");
  });

  it("HTML-escapes values containing & and <", () => {
    const html = metaTags({ title: "Tom & Jerry <best>" });

    expect(html).toContain("<title>Tom &amp; Jerry &lt;best&gt;</title>");
    expect(html).toContain(`content="Tom &amp; Jerry &lt;best&gt;"`);
  });
});

describe("sitemap", () => {
  it("renders multiple urls with the xml declaration and urlset wrapper", () => {
    const xml = sitemap([{ loc: "https://a.test/" }, { loc: "https://b.test/" }]);

    expect(xml).toBe(
      [
        `<?xml version="1.0" encoding="UTF-8"?>`,
        `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`,
        "<url>",
        "  <loc>https://a.test/</loc>",
        "</url>",
        "<url>",
        "  <loc>https://b.test/</loc>",
        "</url>",
        "</urlset>",
      ].join("\n"),
    );
  });

  it("prefixes a relative loc with baseUrl and joins on a single slash", () => {
    const xml = sitemap([{ loc: "/about" }], { baseUrl: "https://example.com/" });

    expect(xml).toContain("<loc>https://example.com/about</loc>");
  });

  it("leaves an absolute loc untouched even when a baseUrl is given", () => {
    const xml = sitemap([{ loc: "https://other.test/page" }], { baseUrl: "https://example.com" });

    expect(xml).toContain("<loc>https://other.test/page</loc>");
  });

  it("leaves a relative loc untouched when no baseUrl is given", () => {
    const xml = sitemap([{ loc: "/about" }]);

    expect(xml).toContain("<loc>/about</loc>");
  });

  it("emits lastmod and priority when present", () => {
    const xml = sitemap([{ loc: "/p", lastmod: "2026-01-01", priority: 0.8 }], {
      baseUrl: "https://example.com",
    });

    expect(xml).toContain("  <lastmod>2026-01-01</lastmod>");
    expect(xml).toContain("  <priority>0.8</priority>");
  });

  it("omits lastmod and priority when absent", () => {
    const xml = sitemap([{ loc: "/p" }], { baseUrl: "https://example.com" });

    expect(xml).not.toContain("<lastmod>");
    expect(xml).not.toContain("<priority>");
  });

  it("XML-escapes an ampersand in a url", () => {
    const xml = sitemap([{ loc: "https://example.com/?a=1&b=2" }]);

    expect(xml).toContain("<loc>https://example.com/?a=1&amp;b=2</loc>");
  });
});

describe("robots", () => {
  it("renders allow, disallow, and sitemap together", () => {
    const body = robots({
      allow: ["/public"],
      disallow: ["/admin", "/private"],
      sitemap: "https://example.com/sitemap.xml",
    });

    expect(body).toBe(
      [
        "User-agent: *",
        "Allow: /public",
        "Disallow: /admin",
        "Disallow: /private",
        "Sitemap: https://example.com/sitemap.xml",
      ].join("\n"),
    );
  });

  it("renders just the user-agent line for empty input", () => {
    expect(robots({})).toBe("User-agent: *");
  });
});

describe("jsonLd", () => {
  it("frames data with context and type and parses back to the expected object", () => {
    const html = jsonLd("Article", { headline: "Hello", wordCount: 42 });

    const match = /^<script type="application\/ld\+json">(.*)<\/script>$/s.exec(html);
    expect(match).not.toBeNull();

    const payload: unknown = JSON.parse(match?.[1] ?? "");

    expect(payload).toEqual({
      "@context": "https://schema.org",
      "@type": "Article",
      headline: "Hello",
      wordCount: 42,
    });
  });

  it("neutralizes < so a value cannot break out of the script element", () => {
    const html = jsonLd("WebPage", { note: "</script><script>alert(1)" });

    expect(html).not.toContain("</script><script>");
    expect(html).toContain("\\u003c/script>\\u003cscript>");
  });
});

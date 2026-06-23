import { describe, expect, it } from "vitest";

import { escape } from "../src/escape";
import { LestoError, SeoError } from "../src/errors";
import { jsonLd } from "../src/json-ld";
import { metaTags } from "../src/meta-tags";
import { ogImage } from "../src/og-image";
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

  it("refuses a loc bearing a newline with a coded error", () => {
    try {
      sitemap([{ loc: "https://example.com/\n<loc>evil</loc>" }]);
      expect.unreachable("sitemap should have refused the injected newline");
    } catch (error) {
      expect(error).toBeInstanceOf(SeoError);
      expect((error as SeoError).code).toBe("SEO_INJECTED_NEWLINE");
      expect((error as SeoError).details.field).toBe("Sitemap loc");
    }
  });

  it("refuses a loc bearing a '#' fragment", () => {
    expect(() => sitemap([{ loc: "https://example.com/page#frag" }])).toThrow(SeoError);
  });

  it("checks the resolved URL, so a base-joined relative loc is still guarded", () => {
    try {
      sitemap([{ loc: "/page#frag" }], { baseUrl: "https://example.com" });
      expect.unreachable("sitemap should have refused the resolved fragment");
    } catch (error) {
      expect((error as SeoError).code).toBe("SEO_INJECTED_FRAGMENT");
    }
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

  it("refuses a Disallow path bearing a newline with a coded error", () => {
    try {
      robots({ disallow: ["/admin\nDisallow: /"] });
      expect.unreachable("robots should have refused the injected newline");
    } catch (error) {
      expect(error).toBeInstanceOf(SeoError);
      expect(error).toBeInstanceOf(LestoError);
      expect((error as SeoError).code).toBe("SEO_INJECTED_NEWLINE");
      expect((error as SeoError).details.field).toBe("Disallow path");
    }
  });

  it("refuses a carriage return in a Disallow path", () => {
    expect(() => robots({ disallow: ["/admin\rDisallow: /"] })).toThrow(SeoError);
  });

  it("refuses a '#' in a Disallow path (it would open a comment)", () => {
    try {
      robots({ disallow: ["/admin#secret"] });
      expect.unreachable("robots should have refused the injected fragment");
    } catch (error) {
      expect((error as SeoError).code).toBe("SEO_INJECTED_FRAGMENT");
      expect((error as SeoError).details.field).toBe("Disallow path");
    }
  });

  it("refuses an injected newline in an Allow path", () => {
    expect(() => robots({ allow: ["/ok\nDisallow: /"] })).toThrow(SeoError);
  });

  it("refuses an injected newline in the Sitemap URL", () => {
    try {
      robots({ sitemap: "https://example.com/s.xml\nDisallow: /" });
      expect.unreachable("robots should have refused the injected sitemap URL");
    } catch (error) {
      expect((error as SeoError).code).toBe("SEO_INJECTED_NEWLINE");
      expect((error as SeoError).details.field).toBe("Sitemap URL");
    }
  });
});

describe("ogImage", () => {
  it("renders a 1200×630 svg card from just a title", () => {
    const svg = ogImage({ title: "Welcome" });

    expect(svg).toContain(`width="1200" height="630"`);
    expect(svg).toContain(`viewBox="0 0 1200 630"`);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
    expect(svg).toContain(">Welcome</text>");
  });

  it("applies the default Lesto palette when no colors are given", () => {
    const svg = ogImage({ title: "Welcome" });

    expect(svg).toContain(`stop-color="#3730a3"`);
    expect(svg).toContain(`stop-color="#4f46e5"`);
    expect(svg).toContain(`<path d="M137 124h17v52h33v16h-50z" fill="#4f46e5"/>`);
  });

  it("merges partial colors over the defaults", () => {
    const svg = ogImage({ title: "Welcome", colors: { gradientFrom: "#000000" } });

    // Overridden field takes the caller's value...
    expect(svg).toContain(`stop-color="#000000"`);
    // ...while an un-passed field keeps the default.
    expect(svg).toContain(`stop-color="#4f46e5"`);
  });

  it("emits the wordmark, footer, and description only when present", () => {
    const full = ogImage({
      title: "Hero",
      description: "A supporting line.",
      wordmark: "Acme",
      footer: "acme.test",
    });

    expect(full).toContain(">Acme</text>");
    expect(full).toContain(">A supporting line.</text>");
    expect(full).toContain(">acme.test</text>");
  });

  it("omits the wordmark, description, and footer when absent", () => {
    const bare = ogImage({ title: "Hero" });

    expect(bare).not.toContain('font-weight="800"'); // the wordmark line
    expect(bare).not.toContain('font-size="32"'); // the description line
    expect(bare).not.toContain("ui-monospace"); // the footer line
  });

  it("tints title lines after the first with the accent color", () => {
    const svg = ogImage({
      title: ["First", "Second"],
      colors: { title: "#ffffff", accent: "#abcdef" },
    });

    expect(svg).toContain(`fill="#ffffff">First</text>`);
    expect(svg).toContain(`fill="#abcdef">Second</text>`);
  });

  it("HTML-escapes attacker-influenced title and description text", () => {
    const svg = ogImage({
      title: "Tom & <script>",
      description: "a & b <c>",
      wordmark: "A&B",
      footer: "x&y",
    });

    expect(svg).toContain(">Tom &amp; &lt;script&gt;</text>");
    expect(svg).toContain(">a &amp; b &lt;c&gt;</text>");
    expect(svg).toContain(">A&amp;B</text>");
    expect(svg).toContain(">x&amp;y</text>");
    expect(svg).not.toContain("<script>");
  });

  it("escapes color values so they cannot break out of the attribute", () => {
    const svg = ogImage({ title: "Hi", colors: { gradientFrom: `"/><script>` } });

    expect(svg).not.toContain(`"/><script>`);
    expect(svg).toContain("&quot;/&gt;&lt;script&gt;");
  });

  it("refuses an empty-string title with a coded error", () => {
    try {
      ogImage({ title: "   " });
      expect.unreachable("ogImage should have refused the empty title");
    } catch (error) {
      expect(error).toBeInstanceOf(SeoError);
      expect((error as SeoError).code).toBe("SEO_EMPTY_OG_TITLE");
    }
  });

  it("refuses an empty array title (and an all-blank array) with a coded error", () => {
    expect(() => ogImage({ title: [] })).toThrow(SeoError);
    expect(() => ogImage({ title: ["", "  "] })).toThrow(SeoError);
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
